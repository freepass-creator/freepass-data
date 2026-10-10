// 정본 지킴이 — registry/canonical-development-lines.json 에 적힌 «하나의 정본» 을 기계로 지킨다.
//
// 대표(2026-09-26): 「AI 코어에서 절대 정본이 두 개나 이렇게 갈리지 않게끔 메인 브랜치만 활용하게끔 뭔가가 있어야」.
// 등록부는 「정본은 여기」 라고 적기만 했다. 이 모듈은 그 등록부를 읽어 어긋나면 빨간불을 켠다.
// AI Core 만이 아니라 어느 저장소든 같은 등록부 형식이면 그대로 쓴다(scripts/canon-guard.mjs --root <repo>).
//
// 막는 것(저장소 하나의 파일만 보고 판정 — 네트워크 없음):
//   HISTORICAL_MARKER_MISSING   역사/비정본으로 적힌 파일이 스스로 정본이라 말하면서 NOT_CANONICAL 표시가 없다
//   DEFINITION_OUTSIDE_CANON    가드 패턴(토큰 정의·공식 등)이 정본 뿌리 밖에서 새로 나타났다
//   ENTRY_FILE_DIVERGED         CLAUDE.md·GEMINI.md 가 AGENTS.md 와 같지도, 가리키는 한 줄도 아니다
//   WORKFLOW_REF_PINNED         워크플로가 main 이 아닌 커밋·가지를 checkout 해 돈다
//   BASELINE_EXPIRED            예외 목록의 기한이 지났다 — 고치거나 기한을 사람이 다시 정한다
//   BASELINE_STALE              예외로 적힌 위반이 이미 사라졌다 — 목록에서 지운다(늘 줄어드는 쪽으로만)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

// .canon-guard = 재사용 워크플로가 호출 저장소 안에 받아 둔 AI Core 사본. 호출 저장소의 파일이 아니다.
const SKIP_DIRS = new Set(['.git', '.canon-guard', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.vercel']);
/** ★«이 저장소를 통째로 복사해 둔 자리»는 훑지 않는다 — `.canon-guard` 와 똑같은 사정이다.
 *
 *  `.claude/worktrees/…`            다른 체크아웃(워크트리)
 *  `artifacts/ai-core-collection-…` 수집 도구가 떠 둔 저장소 스냅샷
 *
 *  둘 다 «정본을 두 벌 둔 것»이 아니라 같은 정본의 사본이다. 그런데 훑다가 걸려서
 *  `DEFINITION_OUTSIDE_CANON: design-system/tokens.css ×31` 로 빨개졌다(2026-09-28 실측).
 *  사본을 중복으로 세면 이 검사가 «진짜 중복»을 가리키지 못하게 된다. 둘 다 git 추적 대상도 아니다. */
const SKIP_PREFIXES = ['.claude/worktrees', 'artifacts/ai-core-collection-'];
const CLAIM = /(정본|canonical|SSOT|single source of truth)/i;
export const NOT_CANONICAL = 'NOT_CANONICAL';

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const matchesAny = (path, globs = []) => globs.some(g => globToRegExp(g).test(path));
const underAny = (path, roots = []) => roots.some(r => (r.endsWith('/') ? path.startsWith(r) : path === r || path.startsWith(`${r}/`) || (!r.includes('.') && path.startsWith(r))));

export function listFiles(base) {
  const out = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const 상대 = relative(base, full).split('\\').join('/');
      if (SKIP_PREFIXES.some((p) => 상대 === p || 상대.startsWith(p.endsWith('-') ? p : `${p}/`))) continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.size <= 2_000_000) out.push(relative(base, full).split('\\').join('/'));
    }
  })(base);
  return out.sort();
}

const read = (base, path) => { try { return readFileSync(join(base, path), 'utf8'); } catch { return null; } };
const head = (text, lines = 40) => text.split('\n').slice(0, lines).join('\n');

function historicalEntries(line) {
  return (line.historical_or_noncanonical ?? []).map(entry => (typeof entry === 'string' ? { path: entry } : entry));
}

function checkHistorical(base, files, line, errors) {
  for (const entry of historicalEntries(line)) {
    if (entry.marker_in) {
      const text = read(base, entry.marker_in);
      if (!text || !text.includes(entry.path.replace(/^.*?\//, '')) && !text.includes(entry.path)) {
        errors.push({ code: 'HISTORICAL_MARKER_MISSING', line: line.id, path: entry.path, detail: `marker_in ${entry.marker_in} does not name it` });
      }
      continue;
    }
    const targets = entry.path.endsWith('/') ? files.filter(f => f.startsWith(entry.path)) : [entry.path];
    for (const path of targets) {
      const text = read(base, path);
      if (text === null) { if (!entry.path.endsWith('/')) errors.push({ code: 'HISTORICAL_PATH_MISSING', line: line.id, path }); continue; }
      if (!/\.(md|json|txt|ya?ml|css|mjs|js|ts|tsx)$/.test(path)) continue;
      // 스스로 정본이라 말하는 파일만 표시를 요구한다 — 조용한 역사자료까지 손대게 하지 않는다.
      if (CLAIM.test(head(text)) && !head(text).includes(NOT_CANONICAL)) {
        errors.push({ code: 'HISTORICAL_MARKER_MISSING', line: line.id, path, detail: `claims authority without ${NOT_CANONICAL} in its first 40 lines` });
      }
    }
  }
}

function countMatches(text, pattern) {
  const re = new RegExp(pattern, 'gm');
  return (text.match(re) ?? []).length;
}

function checkGuards(base, files, line, errors, found) {
  for (const guard of line.guards ?? []) {
    const exempt = [...(line.canonical_roots ?? []), ...(guard.also_allowed ?? [])];
    for (const path of files) {
      if (!matchesAny(path, guard.include)) continue;
      if (matchesAny(path, guard.exclude)) continue;
      if (underAny(path, exempt)) continue;
      const text = read(base, path);
      if (text === null) continue;
      const count = countMatches(text, guard.pattern);
      if (count > 0) found.push({ line: line.id, guard: guard.id, path, count });
    }
  }
}

function checkEntryFiles(base, config, errors) {
  if (!config) return;
  const canonical = read(base, config.canonical);
  if (canonical === null) { errors.push({ code: 'ENTRY_CANONICAL_MISSING', path: config.canonical }); return; }
  for (const mirror of config.mirrors ?? []) {
    const text = read(base, mirror);
    if (text === null) continue;
    const identical = text.trim() === canonical.trim();
    const lines = text.trim().split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    const pointer = lines.length <= 3 && text.includes(config.canonical);
    if (!identical && !pointer) {
      errors.push({ code: 'ENTRY_FILE_DIVERGED', path: mirror, detail: `must be identical to ${config.canonical} or a pointer (<=3 lines naming it)` });
    }
  }
}

function checkWorkflowRefs(base, files, config, found) {
  if (!config) return;
  const allowed = new Set(config.allow ?? ['main']);
  for (const path of files.filter(f => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))) {
    const text = read(base, path) ?? '';
    const blocks = text.split(/\n\s*-\s+(?=uses:|name:)/);
    for (const block of blocks) {
      if (!/uses:\s*actions\/checkout@/.test(block)) continue;
      // 단계로 자르면 ref: 가 조각의 «마지막 줄»이 되어 뒤 줄바꿈이 없을 수 있다(freepasserp4 발행기가 그랬다).
      const ref = `${block}\n`.match(/\n\s+ref:[ \t]*['"]?([^'"\n#]+?)['"]?[ \t]*(?:#[^\n]*)?\n/);
      if (!ref) continue;
      const value = ref[1].trim();
      if (value.startsWith('${{') || allowed.has(value)) continue;
      found.push({ line: 'repository', guard: 'workflow-ref-pin', path, count: 1, detail: value });
    }
  }
}

function applyBaseline(found, baseline = [], now, errors) {
  const today = now.toISOString().slice(0, 10);
  const key = v => `${v.guard}|${v.path}`;
  const allowed = new Map(baseline.map(b => [`${b.guard}|${b.path}`, b]));
  const seen = new Set();
  for (const v of found) {
    const b = allowed.get(key(v));
    seen.add(key(v));
    if (!b) { errors.push({ code: v.guard === 'workflow-ref-pin' ? 'WORKFLOW_REF_PINNED' : 'DEFINITION_OUTSIDE_CANON', line: v.line, path: v.path, detail: `${v.guard}${v.detail ? ` ${v.detail}` : ''} ×${v.count}` }); continue; }
    if (b.expires && b.expires < today) errors.push({ code: 'BASELINE_EXPIRED', path: v.path, detail: `${v.guard} expired ${b.expires}` });
    else if (typeof b.max_count === 'number' && v.count > b.max_count) errors.push({ code: 'DEFINITION_OUTSIDE_CANON', line: v.line, path: v.path, detail: `${v.guard} grew ${b.max_count}→${v.count}` });
  }
  for (const b of baseline) if (!seen.has(`${b.guard}|${b.path}`)) errors.push({ code: 'BASELINE_STALE', path: b.path, detail: `${b.guard} is already fixed — remove it from the baseline` });
}

/** 저장소 하나를 등록부대로 잰다. 통과면 빈 배열. */
export function checkRepository(base, registry, { now = new Date() } = {}) {
  const errors = [];
  if (registry?.schema !== 'ai-core-canonical-development-lines/v1') return [{ code: 'CANONICAL_LINES_SCHEMA_INVALID' }];
  const files = listFiles(base);
  const found = [];
  const ids = new Set();
  for (const line of registry.lines ?? []) {
    if (!line.id || ids.has(line.id)) errors.push({ code: 'CANONICAL_LINE_ID_INVALID', line: line.id ?? 'missing' });
    ids.add(line.id);
    if (!line.canonical_entrypoint || !existsSync(join(base, line.canonical_entrypoint))) errors.push({ code: 'CANONICAL_ENTRYPOINT_MISSING', line: line.id });
    checkHistorical(base, files, line, errors);
    checkGuards(base, files, line, errors, found);
  }
  const repo = registry.repository_guards ?? {};
  checkEntryFiles(base, repo.entry_files, errors);
  checkWorkflowRefs(base, files, repo.workflow_refs, found);
  applyBaseline(found, registry.baseline ?? [], now, errors);
  return errors;
}

export const formatError = e => [e.code, e.line, e.path, e.detail].filter(Boolean).join(' · ');

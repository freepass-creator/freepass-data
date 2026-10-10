// 정본 지킴이 실행기. 어느 저장소든 registry/canonical-development-lines.json 이 있으면 잰다.
//
//   node scripts/canon-guard.mjs                    이 저장소(AI Core)
//   node scripts/canon-guard.mjs --root ../renman   다른 저장소
//   node scripts/canon-guard.mjs --self-test        알려진 나쁜 표본을 전부 잡는지 스스로 잰다
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRepository, formatError } from '../src/governance/canonical-guard.mjs';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'registry/canonical-development-lines.json';

function sample(files) {
  const dir = mkdtempSync(join(tmpdir(), 'canon-guard-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const baseRegistry = extra => ({
  schema: 'ai-core-canonical-development-lines/v1',
  policy: { one_canonical_line_per_concern: true },
  lines: [{
    id: 'ui-ux',
    canonical_entrypoint: 'docs/UI.md',
    canonical_roots: ['design-system/'],
    historical_or_noncanonical: ['design/old/'],
    guards: [{ id: 'css-token-definition', pattern: '^\\s*--[a-z0-9-]+\\s*:', include: ['**/*.css'] }],
  }],
  repository_guards: {
    entry_files: { canonical: 'AGENTS.md', mirrors: ['CLAUDE.md', 'GEMINI.md'] },
    workflow_refs: { allow: ['main'] },
  },
  ...extra,
});

const clean = {
  'docs/UI.md': '# UI\n',
  'design-system/tokens.css': ':root {\n  --color-primary: #155eef;\n}\n',
  'design/old/NOTES.md': '# NOT_CANONICAL — 옛 정본 기록\n',
  'app/page.css': '.a { color: var(--color-primary); }\n',
  'AGENTS.md': '# rules\nuse main\n',
  'CLAUDE.md': '# rules\nuse main\n',
  'GEMINI.md': 'Read AGENTS.md.\n',
  '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: main\n',
  // 워크플로가 받아 둔 AI Core 사본 — 정의가 있어도 호출 저장소의 위반이 아니다(welrixtable 에서 오탐).
  '.canon-guard/design/x.css': ':root {\n  --color-primary: #000000;\n}\n',
};

const KNOWN_BAD = [
  ['second token definition outside canon', { 'app/page.css': ':root {\n  --color-primary: #1b2a4a;\n}\n' }, {}, 'DEFINITION_OUTSIDE_CANON'],
  ['historical file claims authority', { 'design/old/tokens.json': '{"note":"이 파일이 값의 정본이다"}\n' }, {}, 'HISTORICAL_MARKER_MISSING'],
  ['entry file diverged', { 'GEMINI.md': '# other rules\nuse any branch\nfreely\nmore\n' }, {}, 'ENTRY_FILE_DIVERGED'],
  ['workflow pinned as the last line of a step', { '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - name: engine\n        uses: actions/checkout@v4\n        with:\n          # 설명 주석\n          ref: 3c98e1b616392ee6d47e07c7d08dbb30320f67ff\n      - name: next\n        uses: actions/checkout@v4\n        with:\n          ref: ${{ github.workflow_sha }}\n' }, {}, 'WORKFLOW_REF_PINNED'],
  ['workflow pinned to a commit', { '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: 3c98e1b6\n' }, {}, 'WORKFLOW_REF_PINNED'],
  ['expired baseline', { 'app/page.css': ':root {\n  --x: 1px;\n}\n' }, { baseline: [{ guard: 'css-token-definition', path: 'app/page.css', expires: '2000-01-01' }] }, 'BASELINE_EXPIRED'],
  ['stale baseline', {}, { baseline: [{ guard: 'css-token-definition', path: 'app/gone.css', expires: '2999-01-01' }] }, 'BASELINE_STALE'],
  ['missing entrypoint', { 'docs/UI.md': null }, {}, 'CANONICAL_ENTRYPOINT_MISSING'],
];

function selfTest() {
  const fails = [];
  const dir = sample(clean);
  const good = checkRepository(dir, baseRegistry());
  rmSync(dir, { recursive: true, force: true });
  if (good.length) fails.push(`clean sample is not green: ${good.map(formatError).join(' | ')}`);
  for (const [name, patch, extra, code] of KNOWN_BAD) {
    const files = { ...clean, ...patch };
    for (const [k, v] of Object.entries(files)) if (v === null) delete files[k];
    const d = sample(files);
    const errors = checkRepository(d, baseRegistry(extra));
    rmSync(d, { recursive: true, force: true });
    if (!errors.some(e => e.code === code)) fails.push(`${name}: expected ${code}, got [${errors.map(e => e.code).join(', ')}]`);
  }
  if (fails.length) { fails.forEach(f => console.error(`CHECKER BROKEN: ${f}`)); process.exitCode = 1; }
  else console.log(`PASS: canon-guard self-test caught ${KNOWN_BAD.length}/${KNOWN_BAD.length} known-bad samples and passed the clean one`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const at = args.indexOf('--root');
  const root = resolve(at >= 0 ? args[at + 1] : here);
  const path = join(root, REGISTRY);
  if (!existsSync(path)) { console.error(`FAIL: ${REGISTRY} not found in ${root} — every repository declares its canonical lines there`); process.exitCode = 1; return; }
  const errors = checkRepository(root, JSON.parse(readFileSync(path, 'utf8')));
  if (errors.length) { errors.forEach(e => console.error(`FAIL: ${formatError(e)}`)); process.exitCode = 1; }
  else console.log(`PASS: canon-guard — one canonical line per concern in ${root}`);
}

main();

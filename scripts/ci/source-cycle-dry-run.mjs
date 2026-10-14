// 온라인 원천 엔진 DRY_RUN(쓰기 0) 실행기. .github/workflows/source-cycle-dry-run.yml 이 부른다.
// 원천 종류마다 엔진을 «계획 모드»(--apply·--unattended 없음)로 한 번씩 부르고, 결과 한 줄 요약을 남긴다.
// 쓰기 쪽 스위치·승인 digest 는 자식 환경에서 지운다. 필요한 변수가 없으면 그 원천은 SKIPPED(이유 코드)로 남긴다.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 온라인에서 읽을 수 있는 원천과 필요한 변수. 시트 원천(F05·AICA)은 gws(회사 계정 위임) 의존이라 아직 넣지 않는다.
 * IRON 은 홈페이지 상세 모드(SOURCE_CYCLE_IRON_HOMEPAGE=1)면 고정 호스트만 읽어 변수가 필요 없고, 옛 목록 모드만 SOURCE_CYCLE_IRON_LIST_URL 이 필요하다. */
export const ONLINE_DRY_RUN_SOURCES = Object.freeze({
  IANCAR: ['EANCAR_ONE_API_BASE_URL', 'EANCAR_ONE_API_KEY'],
  IRON: ['SOURCE_CYCLE_IRON_LIST_URL'],
  AUTOPLUS: [],
});
/** 그 원천을 계획하는 데 필요한 변수(읽기 모드에 따라 다르다). */
export function requiredVars(kind, env) {
  if (kind === 'IRON' && env.SOURCE_CYCLE_IRON_HOMEPAGE === '1') return [];
  return ONLINE_DRY_RUN_SOURCES[kind];
}
/** 자식 프로세스에 절대 넘기지 않는 쓰기·승인·인계 스위치.
 * SOURCE_CYCLE_IRON_HOMEPAGE 는 쓰기 스위치가 아니라 «읽기 모드 선택»(홈페이지 상세)이라 넘긴다 — 지우면 DRY_RUN 이 운영과 다른 옛 목록 경로를 검증한다. */
export const WRITE_SWITCHES = Object.freeze(['SOURCE_CYCLE_UNATTENDED', 'SOURCE_CYCLE_APPROVED_DIGEST', 'SOURCE_CYCLE_TAKEOVER',
  'SOURCE_CYCLE_SONOGONG_API', 'SOURCE_CYCLE_SONOGONG_REPLACE_ONCE', 'SOURCE_CYCLE_SONOGONG_ENROLL_CAP_ONCE',
  'SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_WRITE', 'SOURCE_CYCLE_AUTOPLUS_SHEET', 'SOURCE_CYCLE_WRITE_MONTHLY_PRODUCT_TYPE',
  'SONOGONG_API_KEY', 'SONOGONG_ACCOUNT_JSON']);

export function dryRunEnv(base, kind, privateDir) {
  const env = { ...base };
  for (const key of WRITE_SWITCHES) delete env[key];
  return { ...env, SOURCE_CYCLE_SOURCES: kind, SOURCE_CYCLE_PRIVATE_DIR: privateDir };
}

export function parseSources(value) {
  const kinds = String(value ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const unknown = kinds.filter(k => !Object.hasOwn(ONLINE_DRY_RUN_SOURCES, k));
  if (!kinds.length || unknown.length) throw new Error(`DRY_RUN_SOURCES_INVALID ${unknown.join(',')}`);
  return [...new Set(kinds)];
}

/** 엔진 출력(JSON 배열)을 요약한다. 적용 흔적(APPLIED·되읽기 수)이 보이면 즉시 실패. */
export function summarizeEngineOutput(kind, stdout, exitCode) {
  const line = String(stdout).trim().split('\n').filter(Boolean).pop() ?? '';
  let reports;
  try { reports = JSON.parse(line); } catch { return [{ kind, source: null, status: 'RUNTIME_HOLD', summary: `exit ${exitCode}` }]; }
  if (!Array.isArray(reports)) return [{ kind, source: null, status: 'RUNTIME_HOLD', summary: 'unexpected output' }];
  return reports.map(r => {
    if (r.status === 'APPLIED' || /되읽기 [1-9]/.test(String(r.summary ?? ''))) throw new Error(`DRY_RUN_WROTE ${r.source}`);
    return { kind, source: r.source ?? null, status: r.status ?? null, summary: r.summary ?? '', digest: r.digest ?? null };
  });
}

function main() {
  const kinds = parseSources(process.env.SOURCES);
  const rows = [];
  for (const kind of kinds) {
    const missing = requiredVars(kind, process.env).filter(name => !process.env[name]?.trim());
    if (missing.length) { rows.push({ kind, source: null, status: 'SKIPPED', summary: `missing ${missing.join(',')}` }); continue; }
    const privateDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), `source-cycle-${kind}-`));
    const run = spawnSync(process.execPath, ['dist/src/runtime/source-cycle-runtime.js'],
      { env: dryRunEnv(process.env, kind, privateDir), encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    rows.push(...summarizeEngineOutput(kind, run.stdout, run.status));
  }
  const table = ['| 종류 | 원천 | 상태 | 요약 |', '|---|---|---|---|',
    ...rows.map(r => `| ${r.kind} | ${r.source ?? '-'} | ${r.status} | ${String(r.summary).replace(/\|/g, '/')} |`)].join('\n');
  console.log(JSON.stringify({ status: 'DRY_RUN', writes: 0, rows }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 원천 엔진 DRY_RUN (쓰기 0)\n\n${table}\n`);
  if (rows.some(r => ['RUNTIME_HOLD', 'HOLD', 'STOPPED'].includes(r.status))) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();

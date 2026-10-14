// 온라인 원천 회차 요약(읽기 전용): 엔진 무인 회차 결과(JSON 한 줄)와 heartbeats.jsonl 의 5칸 지표를 Actions 실행 요약 표로 만든다.
//   node scripts/ci/source-cycle-summary.mjs <cycle-result.json> <private-dir>
// 번호는 원본에 이미 끝 4자리뿐이고 키·원문은 결과에 없다. 네트워크·쓰기 0(표준 출력만).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cell = v => String(v ?? '-').replace(/\|/g, '/').replace(/\n/g, ' ');
export function cycleSummaryMarkdown(resultText, heartbeatLines, five) {
  const out = ['## 원천 엔진 온라인 회차'];
  let record = null;
  try { record = JSON.parse(String(resultText).trim().split('\n').filter(Boolean).pop() ?? ''); } catch { /* 아래에서 표시 */ }
  if (!record || typeof record !== 'object') return [...out, '', '결과를 읽지 못함(SOURCE_CYCLE_RUNTIME_HOLD)'].join('\n');
  out.push('', `종료 코드 ${cell(record.exit)}${record.error ? ` · 오류 ${cell(record.error)}` : ''}${record.preflight?.length ? ` · 사전점검 ${cell(record.preflight.join(','))}` : ''}`);
  if (Array.isArray(record.reports) && record.reports.length) {
    out.push('', '| 원천 | 단계 | 상태 | 요약 | 노출 전→후 | 원천 판매가능 | gap |', '|---|---|---|---|---|---|---|');
    for (const r of record.reports) out.push(`| ${cell(r.source)} | ${cell(r.stage)} | ${cell(r.status)} | ${cell(r.summary)} | ${cell(r.exposure?.before)}→${cell(r.exposure?.after)} | ${cell(r.exposure?.sourceSellable)} | ${cell(r.exposure?.gap)} |`);
  }
  // 한 줄 판정(#629: ✅ 일치 / ⚠ 차이와 이유 / ❌ 정지·연속 차이)이 있으면 맨 위에 둔다 — 사람은 이 줄만 본다.
  if (five && typeof five.verdictRows === 'function') {
    const verdicts = five.verdictRows(heartbeatLines);
    if (verdicts.length) out.splice(1, 0, '', ...verdicts.map(v => `- ${v.line}`));
  }
  if (five) {
    const rows = five.fiveColumnRows(heartbeatLines);
    if (rows.length) out.push('', '### 5칸 지표', '', ...rows.map(row => `- ${five.fiveColumnLine(row)}`));
  }
  return out.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [resultPath, dir] = process.argv.slice(2);
  const resultText = await readFile(resultPath, 'utf8').catch(() => '');
  const lines = dir ? (await readFile(join(dir, 'heartbeats.jsonl'), 'utf8').catch(() => '')).split('\n') : [];
  const five = await import(pathToFileURL(join(process.cwd(), 'dist', 'src', 'application', 'source-five-column-report.js')).href).catch(() => null);
  console.log(cycleSummaryMarkdown(resultText, lines, five));
}

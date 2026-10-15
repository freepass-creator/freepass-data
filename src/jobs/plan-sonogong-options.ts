/** 손오공 옵션 투영 plan CLI(읽기 전용: JSON 파일 입력, 쓰기·네트워크 없음).
 *   node dist/src/jobs/plan-sonogong-options.js --records <상품 원문 배열.json>
 * 입력: 배열. 각 항목은 {detail:{options}} · {raw:{detail:{options}}} · {options} 중 하나(source_raw 덤프 또는 엔진 레코드).
 * 출력: 집계만(건수·구분 분포·유상 금액 KNOWN/UNKNOWN·이상 징후). 이름·금액·번호 값은 출력하지 않는다. 상품 문서 쓰기는 이 도구가 하지 않는다. */
import { readFile } from 'node:fs/promises';
import { projectSonogongOptions, summarizeOptionProjections } from '../application/sonogong-options.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
const optionsOf = (entry: unknown): unknown => {
  const e = rec(entry);
  return rec(e.detail).options ?? rec(rec(e.raw).detail).options ?? e.options;
};

export async function runSonogongOptionsPlan(input: { records: string }) {
  const raw = JSON.parse(await readFile(input.records, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('OPTIONS_RECORDS_INVALID');
  const projections = raw.map(entry => projectSonogongOptions(optionsOf(entry)));
  return { status: 'SONOGONG_OPTIONS_PLAN', writes: 0, summary: summarizeOptionProjections(projections) };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('plan-sonogong-options.js')) {
  const records = arg('--records');
  if (!records) { console.error('OPTIONS_PLAN_ARGS_REQUIRED'); process.exitCode = 1; }
  else runSonogongOptionsPlan({ records }).then(r => console.log(JSON.stringify(r, null, 1)))
    .catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'OPTIONS_PLAN_FAILED'); process.exitCode = 1; });
}

/** 끝 4자리 교차 대조 CLI(읽기 전용: JSON 파일 두 개, 쓰기·네트워크 없음).
 *   node dist/src/jobs/crosscheck-last4.js --homepage <목록.json> --image <사람이 확인한 끝4자리.json>
 * 입력: 문자열 배열, 또는 {car_number} 객체 배열(홈페이지 목록 덤프). 출력: 끝 4자리 차이 리포트만. 결과로 어떤 문서도 바꾸지 않는다. */
import { readFile } from 'node:fs/promises';
import { crosscheckLast4 } from '../application/last4-crosscheck.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const valuesOf = async (path: string): Promise<unknown[]> => {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('CROSSCHECK_INPUT_INVALID');
  return raw.map(v => (v && typeof v === 'object' ? (v as Record<string, unknown>).car_number : v));
};

export async function runLast4Crosscheck(input: { homepage: string; image: string }) {
  return { status: 'LAST4_CROSSCHECK', writes: 0, caveat: '끝 4자리 일치는 같은 차 확정이 아니다 — 참고·대조용, 상품 문서는 홈페이지 정본만 따른다',
    ...crosscheckLast4(await valuesOf(input.homepage), await valuesOf(input.image)) };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('crosscheck-last4.js')) {
  const homepage = arg('--homepage'), image = arg('--image');
  if (!homepage || !image) { console.error('CROSSCHECK_ARGS_REQUIRED'); process.exitCode = 1; }
  else runLast4Crosscheck({ homepage, image }).then(r => console.log(JSON.stringify(r, null, 1)))
    .catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'CROSSCHECK_FAILED'); process.exitCode = 1; });
}

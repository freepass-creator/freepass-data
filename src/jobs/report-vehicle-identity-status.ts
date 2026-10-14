/** 차종 정체성 4칸 현황표 CLI(읽기 전용, 쓰기 0·네트워크 0). 공개 카탈로그를 받아 둔 JSON(summary-v1 의 vehicles 또는 상품 배열)을 넣으면 공급사별 대수 표를 낸다.
 *   node dist/src/jobs/report-vehicle-identity-status.js --input <catalog.json> [--out <table.json>]
 * 출력에는 전체 차량번호·고객정보가 없다(대수만). 분류 기준은 application/vehicle-identity-status.ts. */
import { readFile, writeFile } from 'node:fs/promises';
import { buildIdentityStatusTable, type IdentityStatusRow } from '../application/vehicle-identity-status.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

export function rowsFromCatalog(raw: unknown): IdentityStatusRow[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { vehicles?: unknown }).vehicles) ? (raw as { vehicles: unknown[] }).vehicles : null;
  if (!list) throw new Error('IDENTITY_STATUS_INPUT_INVALID');
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return list.map(item => {
    const v = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return { supplier: str(v.supplier), manufacturer: str(v.manufacturer), model: str(v.model), subModel: str(v.subModel), trim: str(v.trim) };
  });
}

export async function runIdentityStatusCli(argv: { input?: string | undefined; out?: string | undefined }) {
  if (!argv.input) throw new Error('IDENTITY_STATUS_ARGS_REQUIRED');
  const table = buildIdentityStatusTable(rowsFromCatalog(JSON.parse(await readFile(argv.input, 'utf8'))));
  if (argv.out) await writeFile(argv.out, JSON.stringify(table, null, 2), { mode: 0o600 });
  return table;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('report-vehicle-identity-status.js')) {
  runIdentityStatusCli({ input: arg('--input'), out: arg('--out') })
    .then(table => console.log(JSON.stringify({ status: 'IDENTITY_STATUS_BUILT', writes: 0, ...table })))
    .catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'IDENTITY_STATUS_FAILED'); process.exitCode = 1; });
}

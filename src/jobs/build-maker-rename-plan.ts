/** 제조사명 정정 계획서 생성 CLI(읽기 전용: 스냅샷 JSON 입력, 쓰기·네트워크 없음).
 *   node dist/src/jobs/build-maker-rename-plan.js --input <maker-snapshot.json> --out-dir <계획서 폴더>
 * 입력: { "rename": {"르노코리아":"르노","KG모빌리티":"KGM"}, "masters":[{id,maker,model,sub_model,title?,retired?}], "trims":[{id,maker,master_id}],
 *         "products":[{id,maker,model,sub_model}] } (전체 번호·고객정보 없음). 출력: 마스터 계획(masters-N.json) → 상품 계획(products-N.json) 순서로 적용.
 * 각 계획서는 VEHICLE_NAME_REPAIR_PLAN=<파일> npm run repair:vehicle-name-parity (DRY_RUN → 정확한 digest 승인 → --apply) 로 적용한다. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMakerRenamePlans, type MakerRenameInput } from '../application/maker-rename-plan.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function parseMakerSnapshot(raw: unknown): MakerRenameInput {
  if (!obj(raw) || !obj(raw.rename) || !Array.isArray(raw.masters) || !Array.isArray(raw.trims) || !Array.isArray(raw.products)) throw new Error('MAKER_SNAPSHOT_INVALID');
  const rename = Object.fromEntries(Object.entries(raw.rename).map(([k, v]) => [k, str(v)]));
  const masters = raw.masters.map(m => { if (!obj(m) || !str(m.id)) throw new Error('MAKER_MASTER_INVALID');
    return { id: str(m.id), maker: str(m.maker), model: str(m.model), sub_model: str(m.sub_model), ...(m.title !== undefined ? { title: str(m.title) } : {}), ...(m.retired === true ? { retired: true } : {}) }; });
  const trims = raw.trims.map(t => { if (!obj(t) || !str(t.id)) throw new Error('MAKER_TRIM_INVALID');
    return { id: str(t.id), maker: str(t.maker), master_id: str(t.master_id) }; });
  const products = raw.products.map(p => { if (!obj(p) || !str(p.id)) throw new Error('MAKER_PRODUCT_INVALID');
    return { id: str(p.id), maker: str(p.maker), model: str(p.model), sub_model: str(p.sub_model) }; });
  return { rename, masters, trims, products, ...(str(raw.label) ? { label: str(raw.label) } : {}) };
}

export async function runMakerRenamePlanCli(argv: { input?: string | undefined; outDir?: string | undefined }) {
  if (!argv.input || !argv.outDir) throw new Error('MAKER_PLAN_ARGS_REQUIRED');
  const result = buildMakerRenamePlans(parseMakerSnapshot(JSON.parse(await readFile(argv.input, 'utf8'))));
  await mkdir(argv.outDir, { recursive: true });
  const files: string[] = [];
  for (const [i, plan] of result.masterPlans.entries()) { const f = `maker-rename-masters-${i + 1}.json`; await writeFile(join(argv.outDir, f), JSON.stringify(plan, null, 2), { mode: 0o600 }); files.push(f); }
  for (const [i, plan] of result.productPlans.entries()) { const f = `maker-rename-products-${i + 1}.json`; await writeFile(join(argv.outDir, f), JSON.stringify(plan, null, 2), { mode: 0o600 }); files.push(f); }
  return { status: 'MAKER_RENAME_PLAN', writes: 0, files, ...result.summary };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('build-maker-rename-plan.js')) {
  runMakerRenamePlanCli({ input: arg('--input'), outDir: arg('--out-dir') }).then(r => console.log(JSON.stringify(r, null, 1)))
    .catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'MAKER_PLAN_FAILED'); process.exitCode = 1; });
}

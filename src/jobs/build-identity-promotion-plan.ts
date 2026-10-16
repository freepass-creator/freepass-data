/** 정체성 승격 계획서 생성 CLI(읽기 전용, 쓰기 0·네트워크 0). B3Q 가 운영 문서·마스터 스냅샷 JSON 을 만들어 이 도구에 넣고, 나온 계획서를 정해진 정정 경로
 * (VEHICLE_NAME_REPAIR_PLAN=<계획서> npm run repair:vehicle-name-parity → Codex 검토 → DRY_RUN → 정확한 digest 승인 → 적용 → 되읽기)로 적용한다.
 *   node dist/src/jobs/build-identity-promotion-plan.js --input <snapshot.json> --out <plan.json> [--trim-out <trim-plan.json>] [--held <held.json>]
 * 정체성 정정과 같은 상품의 세부트림은 두 번째 계획(--trim-out, 기본 <out 이름>.trim.json)에 담긴다 — out 을 적용·되읽기한 뒤 적용한다.
 * 입력 JSON: { "products": IdentityProduct[], "masters": IdentityMaster[], "label"?: string } (끝4·원문 차명·연식만, 전체 번호·고객정보 없음). */
import { readFile, writeFile } from 'node:fs/promises';
import { auditConfirmedIdentities, buildIdentityPromotionPlan, type IdentityMaster, type IdentityProduct } from '../application/identity-promotion-plan.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');

/** 입력 검증(순수): 형식이 틀리면 던져 «일부만 읽은 계획서»를 만들지 않는다. */
export function parseIdentitySnapshot(raw: unknown): { products: Array<IdentityProduct & { supplier?: string }>; masters: IdentityMaster[]; label: string } {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!object(raw) || !Array.isArray(raw.products) || !Array.isArray(raw.masters)) throw new Error('IDENTITY_SNAPSHOT_INVALID');
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const products = raw.products.map((p: unknown): IdentityProduct & { supplier?: string } => {
    if (!object(p) || !str(p.id).trim()) throw new Error('IDENTITY_PRODUCT_INVALID');
    // 전체 차량번호가 들어오면 거부한다(보고서에 번호 전체를 남기지 않는다).
    if (/\d{2,3}[가-힣]\d{4}/.test(str(p.plate4)) || str(p.plate4).length > 4) throw new Error('IDENTITY_PRODUCT_PLATE_NOT_MASKED');
    return { id: str(p.id), plate4: str(p.plate4), maker: str(p.maker), model: str(p.model), sub_model: str(p.sub_model), trim_name: str(p.trim_name),
      rawName: str(p.rawName), year: str(p.year), listable: p.listable === true, ...(str(p.supplier) ? { supplier: str(p.supplier) } : {}), ...(str(p.fuel) ? { fuel: str(p.fuel) } : {}), ...(p.engineTemp === true ? { engineTemp: true } : {}), ...(p.makerModelFromSource === true ? { makerModelFromSource: true } : {}) };
  });
  const masters = raw.masters.map((m: unknown): IdentityMaster => {
    if (!object(m) || !str(m.id).trim() || !str(m.sub_model).trim()) throw new Error('IDENTITY_MASTER_INVALID');
    const trims = Array.isArray(m.trims) ? m.trims.map((t: unknown) => {
      if (!object(t) || !str(t.name).trim() || (t.aliases !== undefined && !isStringArray(t.aliases))) throw new Error('IDENTITY_MASTER_TRIM_INVALID');
      return { name: str(t.name), aliases: (t.aliases as string[] | undefined) ?? [] };
    }) : [];
    const year = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
    return { id: str(m.id), maker: str(m.maker), model: str(m.model), sub_model: str(m.sub_model),
      model_aliases: isStringArray(m.model_aliases) ? m.model_aliases : [], sub_model_aliases: isStringArray(m.sub_model_aliases) ? m.sub_model_aliases : [],
      yearFrom: year(m.yearFrom), yearTo: year(m.yearTo), trims };
  });
  return { products, masters, label: str(raw.label) || 'identity-promotion' };
}

export async function runIdentityPlanCli(argv: { input?: string | undefined; out?: string | undefined; held?: string | undefined; trimOut?: string | undefined;
  appendix?: string | undefined; audit?: string | undefined }) {
  if (!argv.input || !argv.out) throw new Error('IDENTITY_PLAN_ARGS_REQUIRED');
  const snapshot = parseIdentitySnapshot(JSON.parse(await readFile(argv.input, 'utf8')));
  const result = buildIdentityPromotionPlan(snapshot.products, snapshot.masters, { sourceLabel: snapshot.label });
  await writeFile(argv.out, JSON.stringify(result.plan, null, 2), { mode: 0o600 });
  if (result.trimPlan) await writeFile(argv.trimOut ?? argv.out.replace(/(\.json)?$/i, '.trim.json'), JSON.stringify(result.trimPlan, null, 2), { mode: 0o600 });
  if (argv.held) await writeFile(argv.held, JSON.stringify({ stats: result.stats, held: result.held }, null, 2), { mode: 0o600 });
  // R3 부록(형제 세대 목록·별칭 후보)과 «이미 확정» 감사(R1/R2, 읽기 전용 — 되돌림 없이 검토 필요 후보만).
  if (argv.appendix) await writeFile(argv.appendix, JSON.stringify(result.appendix, null, 2), { mode: 0o600 });
  if (argv.audit) {
    const audit = auditConfirmedIdentities(snapshot.products, snapshot.masters);
    await writeFile(argv.audit, JSON.stringify({ total: audit.total, unmatchedMaster: audit.unmatchedMaster, bySupplier: audit.bySupplier,
      review: audit.rows.filter(r => r.verdict !== 'OK' && r.verdict !== 'UNVERIFIABLE') }, null, 2), { mode: 0o600 });
  }
  return result;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('build-identity-promotion-plan.js')) {
  runIdentityPlanCli({ input: arg('--input'), out: arg('--out'), held: arg('--held'), trimOut: arg('--trim-out'), appendix: arg('--appendix'), audit: arg('--audit') })
    .then(r => console.log(JSON.stringify({ status: 'PLAN_BUILT', writes: 0, ...r.stats })))
    .catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'IDENTITY_PLAN_FAILED'); process.exitCode = 1; });
}

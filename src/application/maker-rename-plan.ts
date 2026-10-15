/** 제조사명 정정 계획 생성(순수, 읽기 전용 — 쓰기 0). 기준 한 장 규칙 7 «제조사 이름은 짧게»(쉐보레·르노·KGM·도요타) 이행: 옛 표기(르노코리아·KG모빌리티 등)를
 * 짧은 표기로 옮기는 정정 계획서를 만든다. 적용은 기존 이름 정정기(repair:vehicle-name-parity)의 masterMakerRepairs·trimMakerRepairs·productMakerRepairs 만 쓴다
 * (새 쓰기 길 금지, 계획 → Codex → 백업 → 적용 → 되읽기). 옛 이름은 maker_aliases 로 남고 지우지 않는다.
 * 안전: 마스터와 그 세부트림 행은 같은 계획에 «통째로» 담는다(제조사 칸 일관성). 행의 제조사가 마스터와 다르면 그 마스터는 건드리지 않고 skipped 로 보고한다.
 * 상품은 정정 뒤 마스터 정체성(제조사|모델|세부모델)이 «정확히 하나»로 맞을 때만 담는다. 별도 계획이며 마스터 계획을 먼저 적용·되읽기한 뒤 적용한다. */
import { stableDigest } from '../shared/stable-digest.js';

export type MakerMaster = { id: string; maker: string; model: string; sub_model: string; title?: string; retired?: boolean };
export type MakerTrimRow = { id: string; maker: string; master_id: string };
export type MakerProduct = { id: string; maker: string; model: string; sub_model: string };
export type MakerRenameInput = { rename: Record<string, string>; masters: MakerMaster[]; trims: MakerTrimRow[]; products: MakerProduct[]; label?: string };
type Item = { id: string; from: string; to: string };
export type MakerRenamePlan = {
  sourceDigest: string; masterRepairs: []; productRepairs: [];
  masterMakerRepairs?: Item[]; trimMakerRepairs?: Item[]; masterTitleRepairs?: Item[]; productMakerRepairs?: Item[];
};
export type MakerRenameResult = {
  masterPlans: MakerRenamePlan[]; productPlans: MakerRenamePlan[];
  summary: { masters: number; trims: number; titles: number; products: number; skipped: Record<string, number>; planSizes: number[] };
};

/** 계획 한 개의 대상 수 상한(이름 정정기 MAX_VEHICLE_NAME_REPAIR_TARGETS=200 보다 작게). */
export const MAKER_PLAN_CHUNK = 180;
const clean = (v: unknown) => String(v ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');

export function buildMakerRenamePlans(input: MakerRenameInput): MakerRenameResult {
  const rename = Object.fromEntries(Object.entries(input.rename).map(([from, to]) => [clean(from), clean(to)]));
  for (const [from, to] of Object.entries(rename)) {
    if (!from || !to || from === to) throw new Error('MAKER_RENAME_MAPPING_INVALID');
  }
  if (Object.values(rename).some(to => rename[to] !== undefined)) throw new Error('MAKER_RENAME_CHAIN');
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  const rowsByMaster = new Map<string, MakerTrimRow[]>();
  for (const row of input.trims) (rowsByMaster.get(row.master_id) ?? rowsByMaster.set(row.master_id, []).get(row.master_id)!).push(row);

  // 마스터 단위 묶음(마스터 + 행 + 표시명). 행 제조사가 마스터와 다르면 그 마스터는 통째로 건너뛴다.
  const groups: Array<{ items: Required<Pick<MakerRenamePlan, 'masterMakerRepairs' | 'trimMakerRepairs' | 'masterTitleRepairs'>> }> = [];
  const renamedMasters = new Set<string>();
  for (const m of [...input.masters].sort((a, b) => a.id.localeCompare(b.id))) {
    const from = clean(m.maker);
    const to = rename[from];
    if (!to) continue;
    if (m.retired === true) { skip('RETIRED_MASTER'); continue; }
    const rows = rowsByMaster.get(m.id) ?? [];
    if (rows.some(r => clean(r.maker) !== from)) { skip('TRIM_ROW_MAKER_DIFFERS'); continue; }
    // 표시명: 비어 있으면 그대로(악화 없음), 표준형(옛 제조사 + 세부모델)이면 함께 정정, 그 밖은 이 마스터 정정을 건너뛴다(적용기도 같은 규칙으로 중단).
    const titleOld = clean(m.title), titleFrom = clean(`${from} ${m.sub_model}`);
    if (titleOld && titleOld !== titleFrom) { skip('TITLE_NOT_STANDARD'); continue; }
    const masterMakerRepairs = [{ id: m.id, from, to }];
    const trimMakerRepairs = rows.map(r => ({ id: r.id, from, to }));
    const masterTitleRepairs = titleOld ? [{ id: m.id, from: m.title!, to: clean(`${to} ${m.sub_model}`) }] : [];
    groups.push({ items: { masterMakerRepairs, trimMakerRepairs, masterTitleRepairs } });
    renamedMasters.add(m.id);
  }
  const masterPlans: MakerRenamePlan[] = [];
  let current: MakerRenamePlan | null = null, size = 0;
  const flush = () => { if (current && size) masterPlans.push(current); current = null; size = 0; };
  for (const g of groups) {
    const n = g.items.masterMakerRepairs.length + g.items.trimMakerRepairs.length + g.items.masterTitleRepairs.length;
    if (n > MAKER_PLAN_CHUNK) { skip('MASTER_TOO_MANY_ROWS_FOR_ONE_PLAN'); renamedMasters.delete(g.items.masterMakerRepairs[0]!.id); continue; }
    if (current && size + n > MAKER_PLAN_CHUNK) flush();
    if (!current) current = { sourceDigest: '', masterRepairs: [], productRepairs: [], masterMakerRepairs: [], trimMakerRepairs: [], masterTitleRepairs: [] };
    current.masterMakerRepairs!.push(...g.items.masterMakerRepairs);
    current.trimMakerRepairs!.push(...g.items.trimMakerRepairs);
    current.masterTitleRepairs!.push(...g.items.masterTitleRepairs);
    size += n;
  }
  flush();

  // 상품: 정정 뒤 마스터 정체성에 «정확히 하나»로 맞을 때만. 마스터는 정정되는 것(renamedMasters)과 이미 새 표기인 것을 모두 본다.
  const finalKey = (m: MakerMaster) => [renamedMasters.has(m.id) ? rename[clean(m.maker)]! : clean(m.maker), clean(m.model), clean(m.sub_model)].join('|');
  const activeCount: Record<string, number> = {};
  for (const m of input.masters) if (m.retired !== true) activeCount[finalKey(m)] = (activeCount[finalKey(m)] ?? 0) + 1;
  const productItems: Item[] = [];
  for (const p of [...input.products].sort((a, b) => a.id.localeCompare(b.id))) {
    const from = clean(p.maker);
    const to = rename[from];
    if (!to) continue;
    const key = [to, clean(p.model), clean(p.sub_model)].join('|');
    if (activeCount[key] === 1) productItems.push({ id: p.id, from, to });
    else skip(activeCount[key] ? 'PRODUCT_IDENTITY_AMBIGUOUS' : 'PRODUCT_NO_ACTIVE_MASTER');
  }
  const productPlans: MakerRenamePlan[] = [];
  for (let i = 0; i < productItems.length; i += MAKER_PLAN_CHUNK) {
    productPlans.push({ sourceDigest: '', masterRepairs: [], productRepairs: [], productMakerRepairs: productItems.slice(i, i + MAKER_PLAN_CHUNK) });
  }
  const base = stableDigest({ label: input.label ?? 'maker-rename', rename, masters: input.masters, trims: input.trims, products: input.products }).slice(0, 24);
  masterPlans.forEach((p, i) => { p.sourceDigest = `maker-rename:${base}:masters:${i + 1}`; if (!p.masterTitleRepairs!.length) delete p.masterTitleRepairs; });
  productPlans.forEach((p, i) => { p.sourceDigest = `maker-rename:${base}:products:${i + 1}`; });
  return { masterPlans, productPlans, summary: {
    masters: masterPlans.reduce((a, p) => a + p.masterMakerRepairs!.length, 0), trims: masterPlans.reduce((a, p) => a + p.trimMakerRepairs!.length, 0),
    titles: masterPlans.reduce((a, p) => a + (p.masterTitleRepairs?.length ?? 0), 0), products: productItems.length, skipped,
    planSizes: [...masterPlans, ...productPlans].map(p => (p.masterMakerRepairs?.length ?? 0) + (p.trimMakerRepairs?.length ?? 0) + (p.masterTitleRepairs?.length ?? 0) + (p.productMakerRepairs?.length ?? 0)) } };
}

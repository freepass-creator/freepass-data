/**
 * 정체성 승격 계획서 생성(읽기 전용). Firestore 에 쓰지 않고 네트워크도 쓰지 않는다 — 입력은 파일 두 개:
 *   VEHICLE_MASTER_SNAPSHOT_JSON  활성 마스터 스냅샷(freepasserp5/vehicle_master+vehicle_trim_master, digest 봉인)
 *   PRODUCTS_JSON                 products 문서 배열 [{ id, data }]
 * 결과 계획서(plans[i])는 그대로 VEHICLE_NAME_REPAIR_PLAN 에 넣어 repair:vehicle-name-parity 로 검토·적용한다.
 * 스냅샷 신선도는 적용 단계가 다시 본다(적용기가 트랜잭션 안에서 «활성 마스터 정확히 하나»를 재확인).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { verifiedMasterRecords, type VehicleMasterSnapshot } from '../adapters/vehicle-identity-inputs.js';
import { planIdentityPromotion, type IdentityPromotionProduct } from '../application/identity-promotion-plan.js';
import { stableDigest } from '../shared/stable-digest.js';

const json = async (envName: string): Promise<unknown> => {
  const path = process.env[envName]?.trim();
  if (!path) throw new Error(`${envName} is required`);
  return JSON.parse(await readFile(path, 'utf8'));
};
const master = await json('VEHICLE_MASTER_SNAPSHOT_JSON') as VehicleMasterSnapshot;
const products = await json('PRODUCTS_JSON');
if (!Array.isArray(products) || products.some((p) => !p || typeof p.id !== 'string' || !p.data || typeof p.data !== 'object')) {
  throw new Error('PRODUCTS_JSON must be an array of { id, data }');
}
// 오프라인 파일 대조: 봉인 digest 는 검사하되 나이는 스냅샷 시각 기준(적용 단계에서 최신 마스터로 다시 막는다).
const records = verifiedMasterRecords(master, Date.parse(master.readAt));
const report = planIdentityPromotion({ products: products as IdentityPromotionProduct[], records, snapshotDigest: master.digest });
// 계획 검증·승인 digest 확인은 repair:vehicle-name-parity 가 한다(이 job 은 쓰기 저장소를 들이지 않는다).
const planDigests = report.plans.map((plan) => ({ sourceDigest: plan.sourceDigest, planDigest: stableDigest(plan),
  productIdentityCount: plan.productIdentityRepairs.length }));
// 세부트림 계획은 정체성 계획을 모두 적용·되읽기한 뒤에 쓴다(한 상품을 한 계획에 겹치지 않는 정정 경로 제약).
const trimPlanDigests = report.trimPlans.map((plan) => ({ sourceDigest: plan.sourceDigest, planDigest: stableDigest(plan),
  productTrimCount: plan.productTrimRepairs.length }));
const out = process.env.IDENTITY_PROMOTION_OUT?.trim();
if (out) await writeFile(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ status: 'PLAN_ONLY', ruleVersion: report.ruleVersion, snapshotDigest: report.snapshotDigest,
  productsDigest: report.productsDigest, counts: report.counts, planDigests, trimPlanDigests, trimHeld: report.trimHolds.length, ...(out ? { out } : { holds: report.holds.slice(0, 50) }) }, null, 2));

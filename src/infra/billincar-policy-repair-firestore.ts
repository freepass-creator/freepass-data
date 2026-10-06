import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import {
  assertBillincarCanonicalPolicy,
  assertBillincarProductSet,
  BILLINCAR_CANONICAL_POLICY_CODE,
  BILLINCAR_DUPLICATE_POLICY_CODE,
  BILLINCAR_EXPECTED_PRODUCT_COUNT,
  BILLINCAR_EXPECTED_UNLINKED_COUNT,
  BILLINCAR_PROVIDER_CODE,
  BILLINCAR_SOURCE_POLICY_CODES,
  BILLINCAR_SOURCE_POLICY_UID,
} from '../domain/billincar-policy-invariant.js';
import { assertNoCorrectorOverwrite } from '../domain/policy-correction.js';
import { getTargetFirebaseApp } from './firebase-target.js';

const sourcePolicyPatch = {
  policy_name: '빌린카 · 프리패스 표준', annual_mileage: '연 20,000km', mileage_upcharge_per_10000km: '10만원',
  over_mileage_rate_domestic: 200, over_mileage_rate_imported: 400, basic_driver_age: '만 26세 이상',
  driver_age_lowering: '만 21세까지', age_lowering_cost: '10만원', age_21_cost: '12만원', age_23_cost: '7만원',
  driver_age_upper_limit: '만 70세 이하', license_period: '제한없음', insurance_included: '보험료 포함',
  maintenance_service: '미제공', additional_driver_allowance_count: '1인까지', additional_driver_cost: '5만원',
  deposit_installment: '2회까지', succession_allowed: '협의', deposit_return_days: '7일', injury_compensation_limit: '무한',
  injury_deductible: '30만원', property_compensation_limit: '1억원', property_deductible: '30만원',
  self_body_accident: '1억원', self_body_deductible: '30만원', uninsured_damage: '없음', uninsured_deductible: '없음',
  own_damage_compensation: '차량가액', own_damage_repair_ratio: '20%', own_damage_min_deductible: '50만원',
  own_damage_max_deductible: '100만원', annual_roadside_assistance: '연간 5회', replacement_car_policy: '불가',
  screening_criteria: '무심사', policy_source_spreadsheet_id: '1036j-xoQtu-nzWOcfky8MmtSRrvPhRls16E7n49iFVA',
  policy_source_sheet_id: 654905320, policy_source_tab: '운영정책', policy_source_uid: BILLINCAR_SOURCE_POLICY_UID,
} as const;

export async function applyBillincarPolicyRepair() {
  const db = getFirestore(getTargetFirebaseApp());
  const policyIds = [BILLINCAR_CANONICAL_POLICY_CODE, ...BILLINCAR_SOURCE_POLICY_CODES, BILLINCAR_DUPLICATE_POLICY_CODE];
  const policyRefs = policyIds.map((code) => db.collection('policy').doc(code));
  const policyBefore = await db.getAll(...policyRefs);
  if (policyBefore.some((snapshot) => !snapshot.exists)) throw new Error('RP021 policy precondition missing');
  if (policyBefore.some((snapshot) => snapshot.data()?.provider_company_code !== BILLINCAR_PROVIDER_CODE)) throw new Error('RP021 policy provider precondition changed');
  const productQuery = await db.collection('products').get();
  const productBefore = productQuery.docs.filter((snapshot) => snapshot.data().provider_company_code === BILLINCAR_PROVIDER_CODE && snapshot.data()._deleted !== true);
  assertBillincarProductSet(productBefore.map((snapshot) => ({ id: snapshot.id, data: snapshot.data() })));
  if (productQuery.docs.some((snapshot) => snapshot.data().policy_code === BILLINCAR_DUPLICATE_POLICY_CODE)) throw new Error(`${BILLINCAR_DUPLICATE_POLICY_CODE} is still referenced`);
  const productRefs = productBefore.map((snapshot) => snapshot.ref);
  const backupDir = join(homedir(), '.codex', 'private', 'freepass-data-billincar-policy-backups');
  await mkdir(backupDir, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const backupPath = join(backupDir, `${runId}.json`);
  await writeFile(backupPath, JSON.stringify({ runId, projectId: process.env.FIREBASE_PROJECT_ID, capturedAt: new Date().toISOString(),
    source: { spreadsheetId: sourcePolicyPatch.policy_source_spreadsheet_id, sheetId: sourcePolicyPatch.policy_source_sheet_id, range: '운영정책!A1:BS5' },
    documents: [...policyBefore, ...productBefore].map((snapshot) => ({ path: snapshot.ref.path, data: snapshot.data() })) }, null, 2), { flag: 'wx', mode: 0o600 });
  await db.runTransaction(async (transaction) => {
    const current = await transaction.getAll(...policyRefs, ...productRefs);
    const expected = [...policyBefore, ...productBefore];
    current.forEach((snapshot, index) => {
      if (!snapshot.exists || snapshot.updateTime?.toMillis() !== expected[index]!.updateTime?.toMillis()) throw new Error(`transaction precondition changed ${snapshot.ref.path}`);
    });
    assertNoCorrectorOverwrite(policyRefs[0]!.id, current[0]?.data() ?? {}, { ...sourcePolicyPatch });
    transaction.update(policyRefs[0]!, { ...sourcePolicyPatch, updated_at: FieldValue.serverTimestamp(), policy_correction_reason: '빌린카 운영정책 pol_freepassstd 원본 정합' });
    transaction.update(policyRefs.at(-1)!, { status: 'retired', _deleted: true, superseded_by: 'POL-0035', retired_at: FieldValue.serverTimestamp(), retirement_reason: '빌린카 운영정책 원본에 없는 미사용 중복' });
    current.slice(policyRefs.length).forEach((snapshot) => {
      if (!snapshot.data()?.policy_code) transaction.update(snapshot.ref, { policy_code: BILLINCAR_CANONICAL_POLICY_CODE,
        policy_reference_checked_at: FieldValue.serverTimestamp(), policy_reference_state: 'linked_by_source_uid',
        policy_code_linked_reason: '원본 정책 UID pol_freepassstd → FP-RP021-RENT' });
    });
  });
  const [policyAfter, ...productAfter] = await db.getAll(policyRefs[0]!, ...productRefs);
  assertBillincarCanonicalPolicy(policyAfter?.data() ?? {});
  if (productAfter.length !== BILLINCAR_EXPECTED_PRODUCT_COUNT || productAfter.some((snapshot) => snapshot.data()?.policy_code !== BILLINCAR_CANONICAL_POLICY_CODE)) throw new Error('RP021 product policy readback mismatch');
  const duplicateAfter = await policyRefs.at(-1)!.get();
  if (duplicateAfter.data()?.status !== 'retired' || duplicateAfter.data()?._deleted !== true) throw new Error('RP021 duplicate policy retirement readback mismatch');
  return { runId, backupPath, productCount: productAfter.length, linkedProductCount: BILLINCAR_EXPECTED_UNLINKED_COUNT,
    canonicalPolicyCode: BILLINCAR_CANONICAL_POLICY_CODE, retiredPolicyCode: BILLINCAR_DUPLICATE_POLICY_CODE };
}

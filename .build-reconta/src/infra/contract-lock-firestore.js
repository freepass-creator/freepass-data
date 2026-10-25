import { getFirestore } from 'firebase-admin/firestore';
import { buildContractLockReleaseUpdate } from '../domain/contract-lock-release-update.js';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
export async function readProductsByIds(ids) {
    const db = getFirestore(getTargetFirebaseApp());
    const collection = db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products);
    const snaps = await Promise.all(ids.map(id => collection.doc(id).get()));
    return Object.fromEntries(ids.map((id, index) => [id, snaps[index].exists ? snaps[index].data() : null]));
}
/** 조건부 해제: 잠금 값·시각·공급사가 계획과 같을 때만 locked_by_contract 를 null 로 풀고, 이전 값은 해제 기록에 보존한다(지우지 않는다). */
export async function releaseContractLock(input) {
    const db = getFirestore(getTargetFirebaseApp());
    const ref = db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).doc(input.id);
    return db.runTransaction(async (tx) => {
        // 재시도 포함 모든 시도에서 증거 만료를 다시 본다.
        const evidenceAt = Date.parse(input.evidenceReadAt);
        if (!Number.isFinite(evidenceAt) || Date.now() - evidenceAt > input.maxEvidenceAgeMs)
            return 'EVIDENCE_EXPIRED';
        const snap = await tx.get(ref);
        const data = snap.data();
        if (!data || data.provider_company_code !== input.supplierCode || data.locked_by_contract !== 'LEDGER' || typeof data._ledger_lock_at !== 'number' || data._ledger_lock_at !== input.expectedLockAt) {
            return 'PRECONDITION_FAILED';
        }
        tx.update(ref, buildContractLockReleaseUpdate(data, input, Date.now()));
        return 'RELEASED';
    });
}

import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';

type Rec = Record<string, unknown>;

export async function readProductsByIds(ids: string[]): Promise<Record<string, Rec | null>> {
  const db = getFirestore(getTargetFirebaseApp());
  const collection = db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products);
  const snaps = await Promise.all(ids.map(id => collection.doc(id).get()));
  return Object.fromEntries(ids.map((id, index) => [id, snaps[index]!.exists ? (snaps[index]!.data() as Rec) : null]));
}

export type ContractLockReleaseWrite = {
  id: string;
  supplierCode: string;
  expectedLockAt: number;
  reason: string;
  backup: Rec;
};

/** 조건부 해제: 잠금 값·시각·공급사가 계획과 같을 때만 locked_by_contract 를 null 로 풀고, 이전 값은 해제 기록에 보존한다(지우지 않는다). */
export async function releaseContractLock(input: ContractLockReleaseWrite): Promise<'RELEASED' | 'PRECONDITION_FAILED'> {
  const db = getFirestore(getTargetFirebaseApp());
  const ref = db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).doc(input.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as Rec | undefined;
    if (!data || data.provider_company_code !== input.supplierCode || data.locked_by_contract !== 'LEDGER' || data._ledger_lock_at !== input.expectedLockAt) {
      return 'PRECONDITION_FAILED' as const;
    }
    tx.update(ref, {
      locked_by_contract: null,
      _ledger_unlocked_at: Date.now(),
      _ledger_unlock_reason: input.reason,
      _ledger_unlock_previous: { locked_by_contract: 'LEDGER', _ledger_lock_at: input.expectedLockAt },
    });
    return 'RELEASED' as const;
  });
}

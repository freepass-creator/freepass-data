import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { isPublicIancarPhotoProduct } from '../domain/consumer-output-contract.js';
import type { IancarPhotoStorePointer } from '../domain/iancar-photo-store.js';

type Rec = Record<string, unknown>;

export async function readIancarProducts(): Promise<Record<string, Rec>> {
  const db = getFirestore(getTargetFirebaseApp());
  const snap = await db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).where('provider_company_code', '==', 'RP031').get();
  return Object.fromEntries(snap.docs.map(doc => [doc.id, doc.data() as Rec]));
}

/**
 * 포인터 게시(조건부): 상품이 지금도 공개 대상이고 차량이 같고 이전 포인터가 계획 때와 같을 때만
 * iancar_photo_store 한 칸만 쓴다. 다른 칸(공개·철회·상태)은 건드리지 않는다.
 */
export async function publishIancarPhotoPointer(productId: string, pointer: IancarPhotoStorePointer, previousManifestSha256: string | null, vehicleId: string): Promise<'PUBLISHED' | 'PRECONDITION_FAILED'> {
  const db = getFirestore(getTargetFirebaseApp());
  const ref = db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).doc(productId);
  return db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data() as Rec | undefined;
    if (!data || !isPublicIancarPhotoProduct(data) || data.iancar_one_vehicle_id !== vehicleId) return 'PRECONDITION_FAILED' as const;
    const current = (data.iancar_photo_store as Rec | undefined)?.manifestSha256;
    if ((typeof current === 'string' ? current : null) !== previousManifestSha256) return 'PRECONDITION_FAILED' as const;
    tx.update(ref, { iancar_photo_store: pointer });
    return 'PUBLISHED' as const;
  });
}

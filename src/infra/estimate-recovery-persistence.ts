import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { createFirestoreVehicleMasterStore } from './vehicle-master-firestore-store.js';
import { FirestoreVehicleMasterSourceArchive } from './firestore-vehicle-master-source-archive.js';
import type { OperationalEstimateSourceDocument } from '../domain/estimate-operational-publication.js';

/** Internal ports for the gateway-wrapped recovery worker, not a consumer API. */
export function createEstimateRecoveryPersistence() {
  const db=getFirestore(getTargetFirebaseApp());
  return {
    sourceStore:createFirestoreVehicleMasterStore(),
    archive:new FirestoreVehicleMasterSourceArchive(db),
    readDocument:async(collection:OperationalEstimateSourceDocument['collection'],id:string):Promise<OperationalEstimateSourceDocument>=>{
      if(!['vehicle_master_source_documents','vehicle_master_normalized_records'].includes(collection)||!id||id.includes('/'))throw new Error('ESTIMATE_RECOVERY_SOURCE_SCOPE_INVALID');
      const doc=await db.collection(collection).doc(encodeURIComponent(id)).get();
      if(!doc.exists||!doc.updateTime)throw new Error('ESTIMATE_RECOVERY_PERSISTED_SOURCE_MISSING');
      return {collection,id:doc.id,data:doc.data()!,updateTime:{seconds:doc.updateTime.seconds,nanoseconds:doc.updateTime.nanoseconds}};
    },
  };
}

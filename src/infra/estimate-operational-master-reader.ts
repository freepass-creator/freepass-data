import { getFirestore, type Firestore, type QuerySnapshot } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { OperationalEstimateSourceSnapshot, OperationalMasterDocument } from '../ports/estimate-operational-source.js';

function jsonSafe(value: unknown): unknown {
  if (value == null || ['string','number','boolean'].includes(typeof value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const timestamp = value as { seconds?: unknown; nanoseconds?: unknown; toDate?: unknown };
    if (typeof timestamp.toDate === 'function' && typeof timestamp.seconds === 'number' && typeof timestamp.nanoseconds === 'number') {
      return { seconds:timestamp.seconds, nanoseconds:timestamp.nanoseconds };
    }
    return Object.fromEntries(Object.entries(value).map(([key,child]) => [key,jsonSafe(child)]));
  }
  throw new Error('ESTIMATE_OPERATIONAL_SOURCE_VALUE_INVALID');
}
function documents(snapshot: QuerySnapshot): OperationalMasterDocument[] {
  return snapshot.docs.map(doc => ({
    id:doc.id,
    data:jsonSafe(doc.data()) as Record<string,unknown>,
    updateTime:doc.updateTime ? { seconds:doc.updateTime.seconds, nanoseconds:doc.updateTime.nanoseconds } : null,
  })).sort((a,b) => a.id.localeCompare(b.id));
}

/** Same bound Firebase target, one atomic read-only transaction, no alternative writer. */
export async function readOperationalEstimateSourceSnapshot(
  db: Firestore = getFirestore(getTargetFirebaseApp()),
): Promise<OperationalEstimateSourceSnapshot> {
  return db.runTransaction(async transaction => {
    const masters = await transaction.get(db.collection('vehicle_master'));
    const trims = await transaction.get(db.collection('vehicle_trim_master'));
    const products = await transaction.get(db.collection('new_car_trim'));
    if (!masters.readTime.isEqual(trims.readTime) || !masters.readTime.isEqual(products.readTime)) {
      throw new Error('ESTIMATE_OPERATIONAL_SOURCE_NON_ATOMIC_READ');
    }
    const source = { masters:documents(masters), trims:documents(trims), newCarTrims:documents(products) };
    return {
      contract:'estimate-operational-source-snapshot/v1',
      source:'freepasserp5/vehicle_master+vehicle_trim_master+new_car_trim',
      complete:true,
      readAt:masters.readTime.toDate().toISOString(),
      inputDigest:stableDigest(source),
      ...source,
    };
  }, {readOnly:true});
}

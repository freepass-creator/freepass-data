import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';

export const CENTRAL_DIAGNOSTIC_COLLECTIONS = [
  'products',
  'policy',
  FIRESTORE_COLLECTIONS.catalog.products,
  FIRESTORE_COLLECTIONS.catalog.offers,
  FIRESTORE_COLLECTIONS.catalog.policies,
  FIRESTORE_COLLECTIONS.projection.active
] as const;

export type CentralFirestoreCount = {
  collection: typeof CENTRAL_DIAGNOSTIC_COLLECTIONS[number];
  count: number;
  readTime: string;
};

export async function readCentralFirestoreCounts(input: {
  projectId: string;
  accessToken?: string | null;
  fetcher?: typeof fetch;
}): Promise<CentralFirestoreCount[]> {
  const fetcher = input.fetcher ?? fetch;

  if (input.accessToken) {
    return Promise.all(CENTRAL_DIAGNOSTIC_COLLECTIONS.map(async (collection) => {
      const response = await fetcher(
        `https://firestore.googleapis.com/v1/projects/${input.projectId}/databases/(default)/documents:runAggregationQuery`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            structuredAggregationQuery: {
              structuredQuery: { from: [{ collectionId: collection }] },
              aggregations: [{ alias: 'count', count: {} }]
            }
          })
        }
      );
      if (!response.ok) {
        throw new Error(`CENTRAL_FIRESTORE_COUNT_HTTP_${response.status}`);
      }
      const rows = await response.json() as Array<{
        result?: { aggregateFields?: { count?: { integerValue?: string } } };
        readTime?: string;
      }>;
      const counted = rows.find(
        (row) => row.result?.aggregateFields?.count?.integerValue !== undefined
      );
      const count = Number(counted?.result?.aggregateFields?.count?.integerValue);
      if (!Number.isSafeInteger(count) || count < 0 || !counted?.readTime) {
        throw new Error('INVALID_CENTRAL_FIRESTORE_COUNT_RESPONSE');
      }
      return { collection, count, readTime: counted.readTime };
    }));
  }

  const db = getFirestore(getTargetFirebaseApp());
  try {
    return await Promise.all(CENTRAL_DIAGNOSTIC_COLLECTIONS.map(async (collection) => {
      const result = await db.collection(collection).count().get();
      return {
        collection,
        count: result.data().count,
        readTime: result.readTime.toDate().toISOString()
      };
    }));
  } finally {
    await db.terminate();
  }
}

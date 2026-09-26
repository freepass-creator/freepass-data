import { getFirestore } from 'firebase-admin/firestore';
import { execFileSync } from 'node:child_process';
import { getTargetFirebaseApp, resolveTargetProject } from '../infra/firebase-target.js';
import { FIRESTORE_COLLECTIONS } from '../infra/firestore-layout.js';

const projectId = resolveTargetProject();
const canonicalCollections = [
  FIRESTORE_COLLECTIONS.catalog.products,
  FIRESTORE_COLLECTIONS.catalog.offers,
  FIRESTORE_COLLECTIONS.catalog.policies
] as const;
const activeProjectionCollection = FIRESTORE_COLLECTIONS.projection.active;
const collections = [
  'products',
  'policy',
  ...canonicalCollections,
  activeProjectionCollection
] as const;
const canonicalCollectionSet = new Set<string>(canonicalCollections);
const useGcloud = process.argv.includes('--gcloud');
function localAccessToken(): string {
  try {
    const options = { encoding: 'utf8' as const, timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
    const token = (process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'gcloud.cmd auth print-access-token'], options)
      : execFileSync('gcloud', ['auth', 'print-access-token'], options)).trim();
    if (!token || /\s/.test(token)) throw new Error('Invalid token');
    return token;
  } catch {
    // Child-process errors can contain stdout; never include a credential in a diagnostic.
    throw new Error('Local gcloud authentication failed; no Firestore request was sent');
  }
}
// Explicit local diagnostic mode; never install user credentials into the service.
const db = useGcloud ? null : getFirestore(getTargetFirebaseApp());
try {
  const token = useGcloud ? localAccessToken() : null;
  const counts = await Promise.all(collections.map(async (collection) => {
    if (db) {
      const result = await db.collection(collection).count().get();
      return { collection, count: result.data().count, readTime: result.readTime.toDate().toISOString() };
    }
    const response = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runAggregationQuery`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredAggregationQuery: {
        structuredQuery: { from: [{ collectionId: collection }] }, aggregations: [{ alias: 'count', count: {} }],
      } }),
    });
    if (!response.ok) throw new Error(`Read-only count failed for ${collection}: HTTP ${response.status}`);
    const rows = await response.json() as Array<{ result?: { aggregateFields?: { count?: { integerValue?: string } } }; readTime?: string }>;
    const counted = rows.find((row) => row.result?.aggregateFields?.count?.integerValue !== undefined);
    const count = Number(counted?.result?.aggregateFields?.count?.integerValue);
    if (!Number.isSafeInteger(count) || count < 0 || !counted?.readTime) throw new Error(`Invalid count response for ${collection}`);
    return { collection, count, readTime: counted.readTime };
  }));
  console.log(JSON.stringify({
    projectId, credentialMode: useGcloud ? 'EXPLICIT_LOCAL_GCLOUD' : 'APPLICATION_DEFAULT', operation: 'READ_ONLY_COUNTS', counts,
    cutoverAuthorized: false,
    status: counts.some((item) => canonicalCollectionSet.has(item.collection) && item.count === 0) ||
      counts.some((item) => item.collection === activeProjectionCollection && item.count === 0)
      ? 'HOLD_MISSING_CANONICAL_OR_RELEASE' : 'REQUIRES_CONSUMER_PARITY_VERIFICATION',
  }, null, 2));
} finally {
  await db?.terminate();
}

import { execFileSync } from 'node:child_process';
import { resolveTargetProject } from '../infra/firebase-target.js';
import { createCentralDiagnosticDataAccessRuntime } from './data-access-runtime.js';
import { stableDigest } from '../shared/stable-digest.js';

const projectId = resolveTargetProject();
const useGcloud = process.argv.includes('--gcloud');

function localAccessToken(): string {
  try {
    const options = {
      encoding: 'utf8' as const,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore']
    };
    const token = (process.platform === 'win32'
      ? execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', 'gcloud.cmd auth print-access-token'],
          options
        )
      : execFileSync('gcloud', ['auth', 'print-access-token'], options)
    ).trim();
    if (!token || /\s/.test(token)) throw new Error('Invalid token');
    return token;
  } catch {
    throw new Error('Local gcloud authentication failed; no Firestore request was sent');
  }
}

const token = useGcloud ? localAccessToken() : null;
const runtime = await createCentralDiagnosticDataAccessRuntime();
const canonicalCollectionSet = new Set<string>(runtime.canonicalCollections);

const counts = await runtime.access.read({
  context: {
    actor: { id: 'service:freepass-data-diagnostic', kind: 'SERVICE' },
    clientId: 'job:check-central-firestore',
    purpose: 'read central Firestore inventory counts through FreePass Data'
  },
  operation: 'READ_CENTRAL_FIRESTORE_COUNTS',
  resource: {
    kind: 'SYSTEM',
    name: 'freepasserp5/(default):inventory-counts'
  },
  summarize: (value) => ({
    count: value.reduce((sum, item) => sum + item.count, 0),
    digest: stableDigest(value)
  })
}, () => runtime.readCounts({
  projectId,
  accessToken: token
}));

console.log(JSON.stringify({
  projectId,
  credentialMode: useGcloud ? 'EXPLICIT_LOCAL_GCLOUD' : 'APPLICATION_DEFAULT',
  operation: 'READ_ONLY_COUNTS',
  counts,
  cutoverAuthorized: false,
  status: counts.some(
    (item) => canonicalCollectionSet.has(item.collection) && item.count === 0
  ) || counts.some(
    (item) => item.collection === runtime.activeProjectionCollection && item.count === 0
  )
    ? 'HOLD_MISSING_CANONICAL_OR_RELEASE'
    : 'REQUIRES_CONSUMER_PARITY_VERIFICATION',
}, null, 2));

import { pathToFileURL } from 'node:url';
import { createSonogongErpReader, SONOGONG_READER_POLICY, SonogongReaderError } from '../adapters/sonogong-erp-reader.js';
import { sonogongSourceAdapter, type SonogongBucketObservation } from '../adapters/supplier-source-capture.js';
import { collectSupplierSource, type SourceIntakeBatch } from '../domain/source-intake.js';
import { compareSonogongDeposits } from '../domain/sonogong-deposit-comparison.js';
import { prepareRawSourceBatch } from '../application/ingest-raw-source.js';

/** Conservative JSON Firestore storage bound, not JSON byte size alone.
 * Map/array overhead and scalar allowance deliberately overestimate storage.
 * Reserve document-name/metadata space; reject deep/unsupported values without truncation.
 */
export function assertSonogongRawFits(batch: SourceIntakeBatch) {
  const size = (value: unknown, depth = 0): number => {
    if (depth > 18) throw new Error('SONOGONG_RAW_DOCUMENT_LIMIT');
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return 8;
    if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') + 1;
    if (Array.isArray(value)) return 32 + value.reduce((n, v) => n + size(v, depth + 1), 0);
    if (value && typeof value === 'object') return 32 + Object.entries(value)
      .reduce((n, [k, v]) => n + Buffer.byteLength(k, 'utf8') + 1 + size(v, depth + 1), 0);
    throw new Error('SONOGONG_RAW_DOCUMENT_LIMIT');
  };
  for (const record of prepareRawSourceBatch(batch).rawRecords) {
    if (8192 + size(record) > 900_000) throw new Error('SONOGONG_RAW_DOCUMENT_LIMIT');
  }
}

/** Injectable transport/store for offline tests. Default mode never constructs a store. */
export async function runSonogongCollection(input: {
  args: string[]; env: NodeJS.ProcessEnv;
  reader?: ReturnType<typeof createSonogongErpReader>;
  now?: () => number;
  ingest?: (batch: SourceIntakeBatch) => Promise<unknown>;
}) {
  const args = new Set(input.args);
  if ([...args].some(v => !['--apply-raw', '--compare-deposits'].includes(v))) throw new Error('SONOGONG_UNKNOWN_OPTION');
  const apply = args.has('--apply-raw');
  // Check approval before credentials, network, or runtime initialization.
  if (apply && input.env.SONOGONG_RAW_INGEST_APPROVED !== 'true') throw new Error('SONOGONG_RAW_APPROVAL_REQUIRED');
  const now = input.now ?? Date.now;
  const reader = input.reader ?? createSonogongErpReader({ accountJson: () => input.env.SONOGONG_ACCOUNT_JSON ?? '', now });
  const buckets: Array<{ bucket: SonogongBucketObservation['bucket']; rows: number; detailSuccess: number;
    detailFailure: number; depositSourceCount: number; observedAt: string; coverage: string }> = [];
  const adapter = sonogongSourceAdapter({ expectedFreshnessSeconds: SONOGONG_READER_POLICY.freshnessSeconds,
    readBucket: async bucket => {
      const observation = await reader.readBucket(bucket);
      const success = observation.records.filter(r => r.detail !== null).length;
      const depositSourceCount = observation.records.reduce((sum, r) => sum +
        (Array.isArray(r.detail?.estimates) ? r.detail.estimates.filter(e => e && typeof e === 'object'
          && e.securityDepositAmount !== undefined && e.securityDepositAmount !== null && e.securityDepositAmount !== '').length : 0), 0);
      buckets.push({ bucket, rows: observation.records.length, detailSuccess: success,
        detailFailure: observation.records.length - success, depositSourceCount, observedAt: observation.observedAt,
        coverage: observation.complete ? 'COMPLETE' : 'PARTIAL' });
      return observation;
    } });
  // inspect at END of collection (not invocation) to catch a capture that aged out.
  const batch = await adapter.read();
  assertSonogongRawFits(batch);
  const collected = await collectSupplierSource({ ...adapter, read: async () => batch }, new Date(now()).toISOString());
  const report = { collector: 'freepass-data/sonogong', status: collected.evidence.status,
    coverage: batch.coverage.mode, buckets, observedAt: batch.observedAt,
    freshness: collected.evidence.issues.includes('SOURCE_STALE') ? 'STALE' : 'WITHIN_CAPTURE_WINDOW',
    issues: collected.evidence.issues, writeExecuted: false,
    canonicalPublication: 'NOT_AUTHORIZED', retirementAuthorized: false,
    ...(args.has('--compare-deposits') ? { depositComparison: compareSonogongDeposits(batch) } : {}) };
  if (apply) {
    if (collected.evidence.status !== 'RAW_READY') throw new Error('SONOGONG_SOURCE_NOT_READY');
    if (input.ingest) await input.ingest(batch);
    else {
      const { createSourceIngestDataAccessRuntime } = await import('./data-access-runtime.js');
      const runtime = await createSourceIngestDataAccessRuntime();
      await runtime.ingestRawBatch(batch);
    }
    report.writeExecuted = true;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runSonogongCollection({ args: process.argv.slice(2), env: process.env });
    console.log(JSON.stringify(report));
    if (report.status === 'HOLD') process.exitCode = 2;
  } catch (error) {
    const allowed = ['SONOGONG_UNKNOWN_OPTION', 'SONOGONG_RAW_APPROVAL_REQUIRED', 'SONOGONG_SOURCE_NOT_READY', 'SONOGONG_RAW_DOCUMENT_LIMIT'];
    const code = error instanceof SonogongReaderError ? error.code
      : error instanceof Error && allowed.includes(error.message) ? error.message : 'SONOGONG_COLLECTION_FAILED';
    console.log(JSON.stringify({ status: 'HOLD', code }));
    process.exitCode = 2;
  }
}

import { pathToFileURL } from 'node:url';
import { createSonogongErpReader, SONOGONG_READER_POLICY, SonogongReaderError } from '../adapters/sonogong-erp-reader.js';
import { sonogongSourceAdapter, type SonogongBucketObservation } from '../adapters/supplier-source-capture.js';
import { collectSupplierSource, type SourceIntakeBatch } from '../domain/source-intake.js';
import { compareSonogongDeposits } from '../domain/sonogong-deposit-comparison.js';

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
    const allowed = ['SONOGONG_UNKNOWN_OPTION', 'SONOGONG_RAW_APPROVAL_REQUIRED', 'SONOGONG_SOURCE_NOT_READY'];
    const code = error instanceof SonogongReaderError ? error.code
      : error instanceof Error && allowed.includes(error.message) ? error.message : 'SONOGONG_COLLECTION_FAILED';
    console.log(JSON.stringify({ status: 'HOLD', code }));
    process.exitCode = 2;
  }
}

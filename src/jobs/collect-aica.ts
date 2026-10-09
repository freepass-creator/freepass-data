import { pathToFileURL } from 'node:url';
import { aicaSourceAdapter } from '../adapters/supplier-source-capture.js';
import { aicaSheetsGridReader } from '../infra/aica-sheet-reader.js';
import { collectSupplierSource, type AicaGridBinding, type AicaGridObservation, type SourceIntakeBatch } from '../domain/source-intake.js';

export async function captureAica(input: {
  bindings: readonly AicaGridBinding[]; expectedFreshnessSeconds: number | null;
  applyRaw: boolean; approved: boolean;
  verifyBoundTabs?: boolean;
}, ports: {
  readGrid?: (binding: AicaGridBinding) => Promise<AicaGridObservation>;
  ingestRawBatch?: (batch: SourceIntakeBatch) => Promise<unknown>;
  now?: () => string;
} = {}) {
  if (input.applyRaw && !input.approved) throw new Error('AICA_RAW_APPROVAL_REQUIRED');
  const adapter = aicaSourceAdapter({ sourceId: 'supplier:RP004:aica-original-sheet',
    bindings: input.bindings, expectedFreshnessSeconds: input.expectedFreshnessSeconds,
    readGrid: ports.readGrid ?? aicaSheetsGridReader({ verifyBoundTab: input.verifyBoundTabs === true }) });
  const { batch, evidence } = await collectSupplierSource(adapter, ports.now?.());
  if (input.applyRaw) {
    if (evidence.status !== 'RAW_READY') throw new Error('AICA_RAW_SOURCE_HOLD');
    const ingest = ports.ingestRawBatch ?? (async (value: SourceIntakeBatch) => {
      const { createSourceIngestDataAccessRuntime } = await import('./data-access-runtime.js');
      return (await createSourceIngestDataAccessRuntime()).ingestRawBatch(value);
    });
    await ingest(batch);
  }
  return { counts: { records: batch.records.length }, digest: batch.checksum, issues: evidence.issues };
}

export async function aicaCaptureCommand(args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.some(arg => arg !== '--apply-raw') || args.length > 1) throw new Error('AICA_OPTIONS_INVALID');
  let bindings: AicaGridBinding[];
  try { bindings = JSON.parse(env.AICA_GRID_BINDINGS_JSON ?? 'null') as AicaGridBinding[]; }
  catch { throw new Error('AICA_BINDINGS_INVALID'); }
  if (!Array.isArray(bindings) || !bindings.length || bindings.some(b => !b || typeof b.sheetId !== 'string'
    || typeof b.range !== 'string' || !Number.isSafeInteger(b.tabId) || !Number.isSafeInteger(b.plateColumn)))
    throw new Error('AICA_BINDINGS_INVALID');
  const freshness = env.AICA_EXPECTED_FRESHNESS_SECONDS === undefined ? null : Number(env.AICA_EXPECTED_FRESHNESS_SECONDS);
  if (freshness !== null && (!Number.isSafeInteger(freshness) || freshness <= 0)) throw new Error('AICA_FRESHNESS_INVALID');
  return captureAica({ bindings, expectedFreshnessSeconds: freshness, applyRaw: args.includes('--apply-raw'),
    approved: env.AICA_RAW_INGEST_APPROVED === 'true', verifyBoundTabs: env.AICA_VERIFY_BOUND_TABS === 'true' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  aicaCaptureCommand(process.argv.slice(2)).then(report => {
    console.log(JSON.stringify(report));
    if (report.issues.length) process.exitCode = 2;
  }).catch(() => { console.error(JSON.stringify({ issues: ['AICA_CAPTURE_HOLD'] })); process.exitCode = 2; });
}

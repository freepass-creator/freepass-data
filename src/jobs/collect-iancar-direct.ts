import {
  compareIancarInventory, prepareIancarDirectInventory, readOriginalIancarInventory
} from '../adapters/iancar-direct-source.js';

const requested = new Set(process.argv.slice(2));
if ([...requested].some(arg => !['--compare-erp5', '--apply-raw'].includes(arg)))
  throw new Error('UNKNOWN_IANCAR_DIRECT_OPTION');

const credential = process.env.IANKA_ACCOUNT_JSON?.trim() ?? '';
if (!credential) throw new Error('IANKA_ACCOUNT_JSON_REQUIRED');
let account: { email: string; password: string };
try {
  account = JSON.parse(credential) as { email: string; password: string };
} catch {
  throw new Error('INVALID_IANKA_ACCOUNT_JSON');
}

const original = await readOriginalIancarInventory(account);
const prepared = prepareIancarDirectInventory(original);
const report: Record<string, unknown> = {
  collector: 'freepass-data/iancar-direct',
  sourceId: prepared.batch.source.sourceId,
  sourceDigest: prepared.evidence.sourceDigest,
  upstreamSyncedAt: prepared.evidence.upstreamSyncedAt,
  observedAt: prepared.batch.observedAt,
  declaredTotal: prepared.evidence.declaredTotal,
  modelUnits: prepared.evidence.modelUnits,
  reservedUnits: prepared.evidence.reservedUnits,
  rawCandidates: prepared.batch.records.length,
  unknownStatusCount: prepared.evidence.unknownStatusCount,
  coverage: prepared.batch.coverage,
  issues: prepared.evidence.issues,
  pricing: 'HOLD_RATE_SOURCE_UNVERIFIED',
  canonicalPublication: 'NOT_AUTHORIZED',
  consumerReadback: 'NOT_VERIFIED'
};

if (requested.has('--compare-erp5')) {
  const { createErp5InspectionDataAccessRuntime } = await import('./data-access-runtime.js');
  const accessToken = process.env.FREEPASS_ERP5_READ_ACCESS_TOKEN?.trim() ?? '';
  const evidenceBucket = process.env.FREEPASS_DATA_EVIDENCE_BUCKET?.trim() ?? '';
  if (!accessToken || !evidenceBucket) throw new Error('ERP5_READ_ONLY_EVIDENCE_CREDENTIALS_REQUIRED');
  const capture = await createErp5InspectionDataAccessRuntime({ accessToken, evidenceBucket }).capture();
  const field = (doc: Record<string, unknown>, names: string[]): string => {
    const fields = doc.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return '';
    for (const key of names) {
      const value = (fields as Record<string, unknown>)[key];
      if (value && typeof value === 'object' && !Array.isArray(value)
        && typeof (value as Record<string, unknown>).stringValue === 'string')
        return (value as { stringValue: string }).stringValue;
    }
    return '';
  };
  const target: Array<{ plate: string; status: string }> = [];
  let invalidSourceRows = 0;
  for (const document of capture.collections.products.documents) {
    if (field(document, ['provider_company_code', 'providerCompanyCode']) !== 'RP031') continue;
    const carNumber = field(document, ['car_number', 'vehicle_number', 'carNumber']);
    if (!carNumber) { invalidSourceRows++; continue; }
    target.push({
      plate: carNumber,
      status: field(document, ['vehicle_status', 'vehicleStatus', 'dispatch_status'])
    });
  }
  const parity = compareIancarInventory(prepared, target);
  report.erp5ReadTime = capture.readTime;
  report.erp5SnapshotDigest = capture.digest;
  report.inventoryParity = { ...parity, invalidSourceRows };
  if (parity.status !== 'SOURCE_INVENTORY_PARITY_ONLY' || invalidSourceRows)
    report.issues = [...prepared.evidence.issues, 'RP031_ORIGINAL_ERP_VS_ERP5_PARITY_HOLD'];
}

// No automatic promotion: RAW capture is not a reviewed Canonical release.
if (requested.has('--apply-raw')) {
  if (process.env.IANCAR_DIRECT_RAW_INGEST_APPROVED !== 'true')
    throw new Error('IANCAR_DIRECT_RAW_INGEST_APPROVAL_REQUIRED');
  if (!prepared.evidence.readyForRawIngest) throw new Error('IANCAR_RAW_INCOMPLETE_OR_STALE');
  const { createSourceIngestDataAccessRuntime } = await import('./data-access-runtime.js');
  const { ingestRawBatch } = await createSourceIngestDataAccessRuntime();
  const run = await ingestRawBatch(prepared.batch);
  report.rawIngest = {
    runId: run.runId, status: run.status, headStatus: run.headStatus, rawCount: run.rawCount
  };
}
report.status = report.issues && (report.issues as string[]).length ? 'HOLD_SOURCE_REVIEW'
  : requested.has('--apply-raw') ? 'RAW_INGESTED_NOT_PUBLISHED' : 'OBSERVED_NOT_PUBLISHED';
console.log(JSON.stringify(report, null, 2));
// This is a staged native collector. Never turn a RAW-only result into sales-data PASS.
if (report.status === 'HOLD_SOURCE_REVIEW') process.exitCode = 2;

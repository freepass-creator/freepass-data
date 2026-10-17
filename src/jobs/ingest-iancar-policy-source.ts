import { createSourceIngestDataAccessRuntime } from './data-access-runtime.js';
import type { SourceIntakeBatch } from '../domain/source-intake.js';

type SourceMapping = {
  plate: string;
  code: string;
};

type SourceEnvelope = {
  observedAt?: string;
  sourceRevision?: string | null;
  checksum?: string | null;
  mappings: SourceMapping[];
};

const normalizePlate = (value: unknown) =>
  String(value ?? '').replace(/\s+/g, '').toUpperCase();

const readStdin = () => new Promise<string>((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});

if (process.env.IANCAR_POLICY_SOURCE_INGEST_APPROVED !== 'true') {
  throw new Error('IANCAR_POLICY_SOURCE_INGEST_APPROVED=true required');
}

const raw = await readStdin();
if (!raw.trim()) {
  throw new Error('IANCAR policy source JSON is required on stdin');
}

const parsed = JSON.parse(raw) as unknown;
const envelope: SourceEnvelope = Array.isArray(parsed)
  ? { mappings: parsed as SourceMapping[] }
  : parsed as SourceEnvelope;

if (!envelope || !Array.isArray(envelope.mappings) || envelope.mappings.length === 0) {
  throw new Error('IANCAR policy source mappings are required');
}

const observedAt =
  (typeof envelope.observedAt === 'string' ? envelope.observedAt.trim() : '') ||
  process.env.IANCAR_POLICY_SOURCE_OBSERVED_AT?.trim() ||
  '';

if (!Number.isFinite(Date.parse(observedAt))) {
  throw new Error('IANCAR_POLICY_SOURCE_OBSERVED_AT or envelope.observedAt is required');
}

const sourceRevision =
  (typeof envelope.sourceRevision === 'string' ? envelope.sourceRevision.trim() : '') ||
  process.env.IANCAR_POLICY_SOURCE_REVISION?.trim() ||
  undefined;

const checksum =
  (typeof envelope.checksum === 'string' ? envelope.checksum.trim() : '') ||
  process.env.IANCAR_POLICY_SOURCE_CHECKSUM?.trim() ||
  undefined;

const seen = new Set<string>();
const records = envelope.mappings.map((mapping, index) => {
  const sourcePlate = typeof mapping?.plate === 'string' ? mapping.plate.trim() : '';
  const policyCode = typeof mapping?.code === 'string' ? mapping.code.trim() : '';
  const plate = normalizePlate(sourcePlate);

  if (!plate || !policyCode) {
    throw new Error(`Invalid IANCAR mapping at index ${index}`);
  }
  if (seen.has(plate)) {
    throw new Error(`Duplicate IANCAR plate: ${plate}`);
  }
  seen.add(plate);

  return {
    sourceRecordId: plate,
    payload: {
      sourcePlate,
      normalizedPlate: plate,
      policyCode,
      sourceWorkbook: '이안카_프리패스',
      sourceTabs: ['이안카', '이안카 재렌트'],
    },
  };
});

const fullCoverage = process.env.IANCAR_POLICY_SOURCE_FULL === 'true';
const batch: SourceIntakeBatch = {
  laneId: 'PRODUCT_VEHICLE',
  source: {
    sourceId: 'google-sheet:iancar-freepass:policy-groups',
    kind: 'GOOGLE_SHEET',
    displayName: '이안카_프리패스 정책 그룹',
    authorityScope: ['RP031 policy assignment by vehicle plate'],
  },
  observedAt,
  ...(sourceRevision ? { sourceRevision } : {}),
  ...(checksum ? { checksum } : {}),
  coverage: fullCoverage
    ? {
        mode: 'FULL',
        completeness: 'COMPLETE',
        scope: 'current IANCAR policy assignment source rows',
        note: 'RAW_ONLY: canonical assignment requires separate reviewed normalization/promotion',
      }
    : {
        mode: 'PARTIAL',
        completeness: 'INCOMPLETE',
        scope: 'provided IANCAR policy assignment source rows',
        note: 'HOLD: partial RAW evidence only; absence and canonical assignment must not be inferred',
      },
  records,
};

const runtime = await createSourceIngestDataAccessRuntime();
const run = await runtime.ingestRawBatch(batch);

console.log(JSON.stringify({
  status: run.status,
  runId: run.runId,
  sourceId: run.sourceId,
  headStatus: run.headStatus,
  rawCount: run.rawCount,
  candidateCount: run.candidateCount,
  lineageCount: run.lineageCount ?? 0,
  coverage: run.coverage,
  checkpoint: run.checkpoint ?? null,
}, null, 2));

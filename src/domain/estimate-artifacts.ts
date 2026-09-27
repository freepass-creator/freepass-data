import { stableDigest } from '../shared/stable-digest.js';

export const QUOTE_CONTRACT_V2 = 'freepass-quote/v2' as const;
export const QUOTE_SNAPSHOT_CONTRACT_V2 = 'freepass-quote-snapshot/v2' as const;
export const QUOTE_REVISION_CONTRACT_V1 = 'freepass-quote-revision/v1' as const;
export const QUOTE_REPOSITORY_CONTRACT = 'freepass-quote-repository/v1' as const;
export const QUOTE_WRITE_RECEIPT_CONTRACT = 'freepass-quote-write-receipt/v1' as const;
export const QUOTE_READ_RECEIPT_CONTRACT = 'freepass-quote-read-receipt/v1' as const;

export const SHARE_ENVELOPE_CONTRACT = 'freepass-share-envelope/v1' as const;
export const SHARE_ENVELOPE_SNAPSHOT_CONTRACT = 'freepass-share-envelope-snapshot/v1' as const;
export const SHARE_ENVELOPE_REPOSITORY_CONTRACT = 'freepass-share-envelope-repository/v1' as const;
export const SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT = 'freepass-share-envelope-write-receipt/v1' as const;
export const SHARE_ENVELOPE_READ_RECEIPT_CONTRACT = 'freepass-share-envelope-read-receipt/v1' as const;

export type IssuedQuoteV2 = Record<string, unknown> & {
  contract: typeof QUOTE_CONTRACT_V2;
  quoteId: string;
  quoteVersion: number;
  createdAt: string;
  snapshotHash: string;
  revision?: Record<string, unknown> | null;
  revisionHash?: string | null;
};

export type QuoteWriteReceipt = {
  contract: typeof QUOTE_WRITE_RECEIPT_CONTRACT;
  status: 'CREATED' | 'EXISTING';
  quoteId: string;
  quoteVersion: number;
  snapshotHash: string;
  idempotencyKey: string;
};

export type QuoteReadReceipt =
  | {
      contract: typeof QUOTE_READ_RECEIPT_CONTRACT;
      status: 'NOT_FOUND';
      quoteId: string;
      quoteVersion: number | null;
    }
  | {
      contract: typeof QUOTE_READ_RECEIPT_CONTRACT;
      status: 'FOUND';
      quoteId: string;
      quoteVersion: number;
      snapshotHash: string;
      quote: IssuedQuoteV2;
    };

export type ShareEnvelopeQuoteRef = {
  quoteId: string;
  quoteVersion: number;
  snapshotHash: string;
};

export type ShareEnvelopeV1 = {
  contract: typeof SHARE_ENVELOPE_CONTRACT;
  envelopeId: string;
  envelopeVersion: number;
  createdAt: string;
  expiresAt: string;
  quoteRefs: ShareEnvelopeQuoteRef[];
  snapshotHash: string;
};

export type ShareEnvelopeWriteReceipt = {
  contract: typeof SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT;
  status: 'CREATED' | 'EXISTING';
  envelopeId: string;
  envelopeVersion: number;
  snapshotHash: string;
  idempotencyKey: string;
};

export type ShareEnvelopeReadReceipt =
  | {
      contract: typeof SHARE_ENVELOPE_READ_RECEIPT_CONTRACT;
      status: 'NOT_FOUND';
      envelopeId: string;
      envelopeVersion: number | null;
    }
  | {
      contract: typeof SHARE_ENVELOPE_READ_RECEIPT_CONTRACT;
      status: 'FOUND';
      envelopeId: string;
      envelopeVersion: number;
      snapshotHash: string;
      envelope: ShareEnvelopeV1;
    };

const SNAPSHOT_FIELDS = [
  'vehicleModelId',
  'modelYearId',
  'trimId',
  'powertrainId',
  'selectedOptionIds',
  'exteriorColorId',
  'interiorColorId',
  'contractTerm',
  'mileageCondition',
  'conditionSnapshot',
  'deposit',
  'prepayment',
  'depositRatePct',
  'prepaymentRatePct',
  'vehiclePriceSnapshot',
  'optionPriceSnapshot',
  'totalVehiclePrice',
  'monthlyRental',
  'pricingEngineVersion',
  'calculationProvenance',
  'sourceRevision',
] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function coded(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function requiredId(value: unknown, code: string) {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw coded(code);
  return id;
}

function positiveInteger(value: unknown, code: string) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw coded(code);
  return n;
}

function sha256(value: unknown, code: string) {
  const hash = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw coded(code);
  return hash;
}

function iso(value: unknown, code: string) {
  const text = String(value ?? '').trim();
  if (!text || !Number.isFinite(Date.parse(text))) throw coded(code);
  return text;
}

function assertSnapshotShape(value: Record<string, unknown>) {
  for (const field of SNAPSHOT_FIELDS) {
    if (!(field in value) || value[field] === undefined) throw coded('QUOTE_REPOSITORY_QUOTE_INVALID');
  }
  if (!Array.isArray(value.selectedOptionIds) || !Array.isArray(value.optionPriceSnapshot)) {
    throw coded('QUOTE_REPOSITORY_QUOTE_INVALID');
  }
  if (!record(value.vehiclePriceSnapshot) || !record(value.conditionSnapshot) || !record(value.calculationProvenance)) {
    throw coded('QUOTE_REPOSITORY_QUOTE_INVALID');
  }
  if (value.calculationProvenance.verified !== true) {
    throw coded('QUOTE_PRICING_ENGINE_UNVERIFIED');
  }
}

export function quoteSnapshotFromIssuedQuote(quote: IssuedQuoteV2) {
  const source = quote as Record<string, unknown>;
  assertSnapshotShape(source);
  return {
    contract: QUOTE_SNAPSHOT_CONTRACT_V2,
    ...Object.fromEntries(SNAPSHOT_FIELDS.map((field) => [field, source[field]])),
  };
}

export function assertIssuedQuoteV2(value: unknown): asserts value is IssuedQuoteV2 {
  if (!record(value) || value.contract !== QUOTE_CONTRACT_V2) {
    throw coded('QUOTE_REPOSITORY_QUOTE_INVALID');
  }
  const quoteId = requiredId(value.quoteId, 'QUOTE_REPOSITORY_QUOTE_INVALID');
  const quoteVersion = positiveInteger(value.quoteVersion, 'QUOTE_REPOSITORY_QUOTE_INVALID');
  iso(value.createdAt, 'QUOTE_REPOSITORY_QUOTE_INVALID');
  const snapshotHash = sha256(value.snapshotHash, 'QUOTE_REPOSITORY_QUOTE_INVALID');
  const snapshot = quoteSnapshotFromIssuedQuote(value as IssuedQuoteV2);
  if (stableDigest(snapshot) !== snapshotHash) {
    throw coded('QUOTE_V2_INTEGRITY_MISMATCH');
  }

  if (quoteVersion === 1) {
    if (quoteId !== `q_${snapshotHash.slice(0, 24)}` || value.revision != null || value.revisionHash != null) {
      throw coded('QUOTE_V2_INTEGRITY_MISMATCH');
    }
    return;
  }

  if (!record(value.revision) || value.revision.contract !== QUOTE_REVISION_CONTRACT_V1) {
    throw coded('QUOTE_REVISION_INVALID');
  }
  if (positiveInteger(value.revision.previousQuoteVersion, 'QUOTE_REVISION_INVALID') !== quoteVersion - 1) {
    throw coded('QUOTE_REVISION_INVALID');
  }
  sha256(value.revision.previousSnapshotHash, 'QUOTE_REVISION_INVALID');
  if (value.revision.previousRevisionHash != null) {
    sha256(value.revision.previousRevisionHash, 'QUOTE_REVISION_INVALID');
  }
  const revisionHash = sha256(value.revisionHash, 'QUOTE_REVISION_INVALID');
  if (revisionHash !== stableDigest({
    contract: QUOTE_REVISION_CONTRACT_V1,
    quoteId,
    quoteVersion,
    snapshotHash,
    revision: value.revision,
  })) {
    throw coded('QUOTE_REVISION_INVALID');
  }
}

export function quoteIdempotencyKey(quote: IssuedQuoteV2) {
  assertIssuedQuoteV2(quote);
  return `${quote.quoteId}:v${quote.quoteVersion}:${quote.snapshotHash}`;
}

function quoteRef(value: unknown): ShareEnvelopeQuoteRef {
  if (!record(value)) throw coded('SHARE_ENVELOPE_INVALID');
  return {
    quoteId: requiredId(value.quoteId, 'SHARE_ENVELOPE_INVALID'),
    quoteVersion: positiveInteger(value.quoteVersion, 'SHARE_ENVELOPE_INVALID'),
    snapshotHash: sha256(value.snapshotHash, 'SHARE_ENVELOPE_INVALID'),
  };
}

export function assertShareEnvelopeV1(value: unknown): asserts value is ShareEnvelopeV1 {
  if (!record(value) || value.contract !== SHARE_ENVELOPE_CONTRACT) {
    throw coded('SHARE_ENVELOPE_INVALID');
  }
  requiredId(value.envelopeId, 'SHARE_ENVELOPE_INVALID');
  positiveInteger(value.envelopeVersion, 'SHARE_ENVELOPE_INVALID');
  const createdAt = iso(value.createdAt, 'SHARE_ENVELOPE_INVALID');
  const expiresAt = iso(value.expiresAt, 'SHARE_ENVELOPE_INVALID');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw coded('SHARE_ENVELOPE_INVALID');
  if (!Array.isArray(value.quoteRefs) || value.quoteRefs.length < 1) throw coded('SHARE_ENVELOPE_INVALID');

  const refs = value.quoteRefs.map(quoteRef);
  if (new Set(refs.map((item) => item.quoteId)).size !== refs.length) {
    throw coded('SHARE_ENVELOPE_INVALID');
  }

  const snapshotHash = sha256(value.snapshotHash, 'SHARE_ENVELOPE_INVALID');
  const snapshot = {
    contract: SHARE_ENVELOPE_SNAPSHOT_CONTRACT,
    quoteRefs: refs,
    expiresAt,
  };
  if (stableDigest(snapshot) !== snapshotHash) {
    throw coded('SHARE_ENVELOPE_INTEGRITY_MISMATCH');
  }
}

export function shareEnvelopeIdempotencyKey(envelope: ShareEnvelopeV1) {
  assertShareEnvelopeV1(envelope);
  return `${envelope.envelopeId}:v${envelope.envelopeVersion}:${envelope.snapshotHash}`;
}

export type QuotePutCommand = {
  command: 'PUT_ISSUED_QUOTE';
  contract: typeof QUOTE_REPOSITORY_CONTRACT;
  idempotencyKey: string;
  quote: IssuedQuoteV2;
};

export type ShareEnvelopePutCommand = {
  command: 'PUT_SHARE_ENVELOPE';
  contract: typeof SHARE_ENVELOPE_REPOSITORY_CONTRACT;
  idempotencyKey: string;
  envelope: ShareEnvelopeV1;
};

export function assertQuotePutCommand(
  value: unknown,
  headerIdempotencyKey: unknown
): asserts value is QuotePutCommand {
  if (!record(value) || value.command !== 'PUT_ISSUED_QUOTE' || value.contract !== QUOTE_REPOSITORY_CONTRACT) {
    throw coded('QUOTE_REPOSITORY_COMMAND_INVALID');
  }
  assertIssuedQuoteV2(value.quote);
  const key = quoteIdempotencyKey(value.quote);
  if (String(value.idempotencyKey ?? '').trim() !== key || String(headerIdempotencyKey ?? '').trim() !== key) {
    throw coded('QUOTE_REPOSITORY_CONFLICT');
  }
}

export function assertShareEnvelopePutCommand(
  value: unknown,
  headerIdempotencyKey: unknown
): asserts value is ShareEnvelopePutCommand {
  if (!record(value) || value.command !== 'PUT_SHARE_ENVELOPE' || value.contract !== SHARE_ENVELOPE_REPOSITORY_CONTRACT) {
    throw coded('SHARE_ENVELOPE_COMMAND_INVALID');
  }
  assertShareEnvelopeV1(value.envelope);
  const key = shareEnvelopeIdempotencyKey(value.envelope);
  if (String(value.idempotencyKey ?? '').trim() !== key || String(headerIdempotencyKey ?? '').trim() !== key) {
    throw coded('SHARE_ENVELOPE_CONFLICT');
  }
}

export function normalizedArtifactVersion(value: unknown, code: string) {
  if (value === undefined || value === null || value === '') return null;
  return positiveInteger(value, code);
}

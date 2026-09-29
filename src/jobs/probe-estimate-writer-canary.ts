import {
  QUOTE_CONTRACT_V2, QUOTE_REPOSITORY_CONTRACT, QUOTE_SNAPSHOT_CONTRACT_V2,
  SHARE_ENVELOPE_CONTRACT, SHARE_ENVELOPE_REPOSITORY_CONTRACT, SHARE_ENVELOPE_SNAPSHOT_CONTRACT,
  estimateArtifactDigest, quoteIdempotencyKey, shareEnvelopeIdempotencyKey,
  type IssuedQuoteV2, type ShareEnvelopeV1,
} from '../domain/estimate-artifacts.js';

type CanaryInput = { baseUrl: string; cloudRunIdToken: string; consumerToken: string; runId: string; now?: Date; fetchImpl?: typeof fetch };
type JsonRecord = Record<string, unknown>;

function required(value: string | undefined, name: string) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${name}_REQUIRED`);
  return result;
}

function buildQuote(runId: string, createdAt: string): IssuedQuoteV2 {
  const snapshot = {
    contract: QUOTE_SNAPSHOT_CONTRACT_V2,
    vehicleModelId: 'synthetic_canary_vehicle', modelYearId: 'synthetic_canary_model_year',
    trimId: 'synthetic_canary_trim', powertrainId: 'synthetic_canary_powertrain',
    selectedOptionIds: ['synthetic_canary_option'], exteriorColorId: 'synthetic_canary_exterior',
    interiorColorId: 'synthetic_canary_interior', contractTerm: 48, mileageCondition: '20000',
    conditionSnapshot: {
      credit: 'CANARY', mileageCondition: '20000', maintenance: 'SELF', liability: 'STANDARD',
      extraDriver: 'NONE', feeRatePct: 0,
      costs: { policyId: 'synthetic-canary', deliveryFee: 0, tintFee: 0, dashcamFee: 0, naviFee: 0, hipassFee: 0, totalPrepFee: 0 },
    },
    deposit: 0, prepayment: 0, depositRatePct: 0, prepaymentRatePct: 0,
    vehiclePriceSnapshot: { basePrice: 1 },
    optionPriceSnapshot: [{ optionId: 'synthetic_canary_option', price: 0 }],
    totalVehiclePrice: 1, monthlyRental: 1, pricingEngineVersion: 'synthetic-canary/v1',
    calculationProvenance: {
      providerKey: 'synthetic-canary', engineId: 'synthetic-canary', engineVersion: 'synthetic-canary/v1',
      evidence: `SYNTHETIC_CANARY:${runId}`, verified: true,
    },
    sourceRevision: `synthetic-canary:${runId}`,
  };
  const snapshotHash = estimateArtifactDigest(snapshot);
  const { contract: _contract, ...facts } = snapshot;
  return { contract: QUOTE_CONTRACT_V2, quoteId: `q_${snapshotHash.slice(0, 24)}`, quoteVersion: 1, createdAt, ...facts, snapshotHash, revision: null, revisionHash: null };
}

function buildEnvelope(quote: IssuedQuoteV2, createdAt: string): ShareEnvelopeV1 {
  const quoteRefs = [{ quoteId: quote.quoteId, quoteVersion: quote.quoteVersion, snapshotHash: quote.snapshotHash }];
  const expiresAt = new Date(Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
  const snapshotHash = estimateArtifactDigest({ contract: SHARE_ENVELOPE_SNAPSHOT_CONTRACT, quoteRefs, expiresAt });
  return { contract: SHARE_ENVELOPE_CONTRACT, envelopeId: `se_${snapshotHash.slice(0, 24)}`, envelopeVersion: 1, createdAt, expiresAt, quoteRefs, snapshotHash };
}

export async function runEstimateWriterCanary(input: CanaryInput) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/$/, '');
  const createdAt = (input.now ?? new Date()).toISOString();
  const quote = buildQuote(input.runId, createdAt);
  const envelope = buildEnvelope(quote, createdAt);
  const headers = { 'X-Serverless-Authorization': `Bearer ${input.cloudRunIdToken}`, Authorization: `Bearer ${input.consumerToken}`, 'Content-Type': 'application/json' };
  async function request(path: string, init: RequestInit): Promise<JsonRecord> {
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(10_000), headers: { ...headers, ...init.headers } });
    const text = await response.text();
    let body: JsonRecord;
    try {
      body = JSON.parse(text) as JsonRecord;
    } catch {
      throw new Error(`CANARY_HTTP_${response.status}:NON_JSON`);
    }
    if (response.status !== 200) throw new Error(`CANARY_HTTP_${response.status}:${String(body.code ?? 'UNKNOWN')}`);
    return body;
  }

  const quoteKey = quoteIdempotencyKey(quote);
  const quoteCommand = { command: 'PUT_ISSUED_QUOTE', contract: QUOTE_REPOSITORY_CONTRACT, idempotencyKey: quoteKey, quote };
  const quoteCreated = await request('/v1/commands/freepass-estimate/issued-quotes', { method: 'POST', headers: { 'idempotency-key': quoteKey }, body: JSON.stringify(quoteCommand) });
  const quoteExisting = await request('/v1/commands/freepass-estimate/issued-quotes', { method: 'POST', headers: { 'idempotency-key': quoteKey }, body: JSON.stringify(quoteCommand) });
  const quoteRead = await request(`/v1/consumers/freepass-estimate/issued-quotes/${quote.quoteId}?quoteVersion=1`, { method: 'GET' });

  const envelopeKey = shareEnvelopeIdempotencyKey(envelope);
  const envelopeCommand = { command: 'PUT_SHARE_ENVELOPE', contract: SHARE_ENVELOPE_REPOSITORY_CONTRACT, idempotencyKey: envelopeKey, envelope };
  const envelopeCreated = await request('/v1/commands/freepass-estimate/share-envelopes', { method: 'POST', headers: { 'idempotency-key': envelopeKey }, body: JSON.stringify(envelopeCommand) });
  const envelopeExisting = await request('/v1/commands/freepass-estimate/share-envelopes', { method: 'POST', headers: { 'idempotency-key': envelopeKey }, body: JSON.stringify(envelopeCommand) });
  const envelopeRead = await request(`/v1/consumers/freepass-estimate/share-envelopes/${envelope.envelopeId}?envelopeVersion=1`, { method: 'GET' });

  if (quoteCreated.status !== 'CREATED' || quoteExisting.status !== 'EXISTING' || quoteCreated.persistedAt !== quoteExisting.persistedAt || quoteRead.status !== 'FOUND' || quoteRead.snapshotHash !== quote.snapshotHash) throw new Error('QUOTE_CANARY_EVIDENCE_MISMATCH');
  if (envelopeCreated.status !== 'CREATED' || envelopeExisting.status !== 'EXISTING' || envelopeCreated.persistedAt !== envelopeExisting.persistedAt || envelopeRead.status !== 'FOUND' || envelopeRead.snapshotHash !== envelope.snapshotHash) throw new Error('SHARE_ENVELOPE_CANARY_EVIDENCE_MISMATCH');

  return { status: 'PASS', runId: input.runId, quote: { quoteId: quote.quoteId, snapshotHash: quote.snapshotHash, persistedAt: quoteCreated.persistedAt }, envelope: { envelopeId: envelope.envelopeId, snapshotHash: envelope.snapshotHash, persistedAt: envelopeCreated.persistedAt } };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const result = await runEstimateWriterCanary({
    baseUrl: required(process.env.ESTIMATE_WRITER_BASE_URL, 'ESTIMATE_WRITER_BASE_URL'),
    cloudRunIdToken: required(process.env.CLOUD_RUN_ID_TOKEN, 'CLOUD_RUN_ID_TOKEN'),
    consumerToken: required(process.env.ESTIMATE_CONSUMER_TOKEN, 'ESTIMATE_CONSUMER_TOKEN'),
    runId: required(process.env.ESTIMATE_CANARY_RUN_ID, 'ESTIMATE_CANARY_RUN_ID'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

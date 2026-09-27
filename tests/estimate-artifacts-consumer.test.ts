import { describe, expect, it } from 'vitest';
import { createConsumerGateway, parseConsumerBindings, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { stableDigest } from '../src/shared/stable-digest.js';
import {
  QUOTE_READ_RECEIPT_CONTRACT,
  QUOTE_SNAPSHOT_CONTRACT_V2,
  QUOTE_WRITE_RECEIPT_CONTRACT,
  SHARE_ENVELOPE_READ_RECEIPT_CONTRACT,
  SHARE_ENVELOPE_SNAPSHOT_CONTRACT,
  SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT,
  quoteIdempotencyKey,
  shareEnvelopeIdempotencyKey,
  type IssuedQuoteV2,
  type QuoteReadReceipt,
  type ShareEnvelopeReadReceipt,
  type ShareEnvelopeV1,
} from '../src/domain/estimate-artifacts.js';
import type { EstimateArtifactStore } from '../src/ports/estimate-artifacts.js';

const token = 'estimate-artifact-token-0123456789abcdef';
const binding: ConsumerBinding = {
  id: 'freepass-estimate',
  projectionId: 'estimate-newcar-master',
  token,
  capabilities: ['estimate-newcar-master', 'estimate-artifacts'],
};
const headers = { authorization: `Bearer ${token}` };

const projectionStore = {
  getActive: async () => null,
  getManifest: async () => null,
  listProjectionLineage: async () => [],
};

function issuedQuote(): IssuedQuoteV2 {
  const snapshot = {
    contract: QUOTE_SNAPSHOT_CONTRACT_V2,
    vehicleModelId: 'vm_niro',
    modelYearId: 'my_niro_2026',
    trimId: 'trim_niro_signature',
    powertrainId: 'pt_niro_hev',
    selectedOptionIds: ['opt_drivewise'],
    exteriorColorId: 'ext_white',
    interiorColorId: 'int_charcoal',
    contractTerm: 48,
    mileageCondition: '20000',
    conditionSnapshot: {
      credit: 'A',
      mileageCondition: '20000',
      maintenance: 'SELF',
      liability: 'STANDARD',
      extraDriver: 'NONE',
      feeRatePct: 0,
      costs: {
        policyId: 'policy-1',
        deliveryFee: 0,
        tintFee: 0,
        dashcamFee: 0,
        naviFee: 0,
        hipassFee: 0,
        totalPrepFee: 0,
      },
    },
    deposit: 0,
    prepayment: 0,
    depositRatePct: 0,
    prepaymentRatePct: 0,
    vehiclePriceSnapshot: { basePrice: 35020000 },
    optionPriceSnapshot: [{ optionId: 'opt_drivewise', price: 700000 }],
    totalVehiclePrice: 35720000,
    monthlyRental: 620000,
    pricingEngineVersion: 'freepass-standard/v1',
    calculationProvenance: {
      providerKey: 'freepass-standard',
      engineId: 'freepass-standard',
      engineVersion: 'freepass-standard/v1',
      evidence: 'test-fixture',
      verified: true,
    },
    sourceRevision: 'vehicle-master:r7',
  };
  const snapshotHash = stableDigest(snapshot);
  const { contract: _snapshotContract, ...facts } = snapshot;
  return {
    contract: 'freepass-quote/v2',
    quoteId: `q_${snapshotHash.slice(0, 24)}`,
    quoteVersion: 1,
    createdAt: '2026-09-27T10:00:00.000Z',
    ...facts,
    snapshotHash,
    revision: null,
    revisionHash: null,
  };
}

function shareEnvelope(quote: IssuedQuoteV2): ShareEnvelopeV1 {
  const quoteRefs = [{
    quoteId: quote.quoteId,
    quoteVersion: quote.quoteVersion,
    snapshotHash: quote.snapshotHash,
  }];
  const expiresAt = '2026-10-27T10:00:00.000Z';
  const snapshotHash = stableDigest({
    contract: SHARE_ENVELOPE_SNAPSHOT_CONTRACT,
    quoteRefs,
    expiresAt,
  });
  return {
    contract: 'freepass-share-envelope/v1',
    envelopeId: `se_${snapshotHash.slice(0, 24)}`,
    envelopeVersion: 1,
    createdAt: '2026-09-27T10:01:00.000Z',
    expiresAt,
    quoteRefs,
    snapshotHash,
  };
}

function memoryArtifacts(): EstimateArtifactStore & { quoteWrites: number; envelopeWrites: number } {
  const quotes = new Map<string, IssuedQuoteV2>();
  const envelopes = new Map<string, ShareEnvelopeV1>();
  return {
    quoteWrites: 0,
    envelopeWrites: 0,
    async putIssuedQuote(quote, key) {
      this.quoteWrites += 1;
      const id = `${quote.quoteId}:v${quote.quoteVersion}`;
      const prior = quotes.get(id);
      if (prior) {
        if (prior.snapshotHash !== quote.snapshotHash) throw Object.assign(new Error('QUOTE_REPOSITORY_CONFLICT'), { code: 'QUOTE_REPOSITORY_CONFLICT' });
        return {
          contract: QUOTE_WRITE_RECEIPT_CONTRACT,
          status: 'EXISTING',
          quoteId: quote.quoteId,
          quoteVersion: quote.quoteVersion,
          snapshotHash: quote.snapshotHash,
          idempotencyKey: key,
        };
      }
      quotes.set(id, structuredClone(quote));
      return {
        contract: QUOTE_WRITE_RECEIPT_CONTRACT,
        status: 'CREATED',
        quoteId: quote.quoteId,
        quoteVersion: quote.quoteVersion,
        snapshotHash: quote.snapshotHash,
        idempotencyKey: key,
      };
    },
    async getIssuedQuote(quoteId, quoteVersion = null): Promise<QuoteReadReceipt> {
      const versions = [...quotes.values()]
        .filter((quote) => quote.quoteId === quoteId)
        .sort((a, b) => b.quoteVersion - a.quoteVersion);
      const quote = quoteVersion == null
        ? versions[0]
        : versions.find((item) => item.quoteVersion === quoteVersion);
      if (!quote) return { contract: QUOTE_READ_RECEIPT_CONTRACT, status: 'NOT_FOUND', quoteId, quoteVersion };
      return {
        contract: QUOTE_READ_RECEIPT_CONTRACT,
        status: 'FOUND',
        quoteId,
        quoteVersion: quote.quoteVersion,
        snapshotHash: quote.snapshotHash,
        quote,
      };
    },
    async putShareEnvelope(envelope, key) {
      this.envelopeWrites += 1;
      for (const ref of envelope.quoteRefs) {
        const quote = quotes.get(`${ref.quoteId}:v${ref.quoteVersion}`);
        if (!quote) throw Object.assign(new Error('SHARE_ENVELOPE_QUOTE_NOT_PERSISTED'), { code: 'SHARE_ENVELOPE_QUOTE_NOT_PERSISTED' });
        if (quote.snapshotHash !== ref.snapshotHash) {
          throw Object.assign(new Error('SHARE_ENVELOPE_QUOTE_RECEIPT_MISMATCH'), { code: 'SHARE_ENVELOPE_QUOTE_RECEIPT_MISMATCH' });
        }
      }
      const id = `${envelope.envelopeId}:v${envelope.envelopeVersion}`;
      const prior = envelopes.get(id);
      if (prior) {
        if (prior.snapshotHash !== envelope.snapshotHash) throw Object.assign(new Error('SHARE_ENVELOPE_CONFLICT'), { code: 'SHARE_ENVELOPE_CONFLICT' });
        return {
          contract: SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT,
          status: 'EXISTING',
          envelopeId: envelope.envelopeId,
          envelopeVersion: envelope.envelopeVersion,
          snapshotHash: envelope.snapshotHash,
          idempotencyKey: key,
        };
      }
      envelopes.set(id, structuredClone(envelope));
      return {
        contract: SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT,
        status: 'CREATED',
        envelopeId: envelope.envelopeId,
        envelopeVersion: envelope.envelopeVersion,
        snapshotHash: envelope.snapshotHash,
        idempotencyKey: key,
      };
    },
    async getShareEnvelope(envelopeId, envelopeVersion = null): Promise<ShareEnvelopeReadReceipt> {
      const versions = [...envelopes.values()]
        .filter((envelope) => envelope.envelopeId === envelopeId)
        .sort((a, b) => b.envelopeVersion - a.envelopeVersion);
      const envelope = envelopeVersion == null
        ? versions[0]
        : versions.find((item) => item.envelopeVersion === envelopeVersion);
      if (!envelope) return { contract: SHARE_ENVELOPE_READ_RECEIPT_CONTRACT, status: 'NOT_FOUND', envelopeId, envelopeVersion };
      return {
        contract: SHARE_ENVELOPE_READ_RECEIPT_CONTRACT,
        status: 'FOUND',
        envelopeId,
        envelopeVersion: envelope.envelopeVersion,
        snapshotHash: envelope.snapshotHash,
        envelope,
      };
    },
  };
}

function gateway(store: EstimateArtifactStore) {
  return createConsumerGateway(
    projectionStore,
    [binding],
    new DataAccessGateway(new MemoryDataAccessLogStore()),
    undefined,
    undefined,
    undefined,
    store,
  );
}

describe('Estimate immutable artifact gateway', () => {
  it('registers Estimate master and artifact capabilities without exposing them to other consumers', () => {
    expect(parseConsumerBindings(JSON.stringify([{
      id: 'freepass-estimate',
      projectionId: 'estimate-newcar-master',
      token,
    }]))[0]?.capabilities).toEqual(['estimate-newcar-master', 'estimate-artifacts']);

    expect(() => parseConsumerBindings(JSON.stringify([{
      id: 'erp-com',
      projectionId: 'erp-public',
      token: token + 'x',
      capabilities: ['estimate-artifacts'],
    }]))).toThrow('Estimate artifact capability requires freepass-estimate');
  });

  it('authenticates before touching Estimate artifact storage', async () => {
    const store = memoryArtifacts();
    const app = gateway(store);
    const quote = issuedQuote();
    const key = quoteIdempotencyKey(quote);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/commands/freepass-estimate/issued-quotes',
      headers: { authorization: 'Bearer wrong', 'idempotency-key': key },
      payload: {
        command: 'PUT_ISSUED_QUOTE',
        contract: 'freepass-quote-repository/v1',
        idempotencyKey: key,
        quote,
      },
    });
    expect(response.statusCode).toBe(401);
    expect(store.quoteWrites).toBe(0);
    await app.close();
  });

  it('persists Quote v2 idempotently and reads the exact immutable version', async () => {
    const store = memoryArtifacts();
    const app = gateway(store);
    const quote = issuedQuote();
    const key = quoteIdempotencyKey(quote);
    const payload = {
      command: 'PUT_ISSUED_QUOTE',
      contract: 'freepass-quote-repository/v1',
      idempotencyKey: key,
      quote,
    };

    const created = await app.inject({
      method: 'POST',
      url: '/v1/commands/freepass-estimate/issued-quotes',
      headers: { ...headers, 'idempotency-key': key },
      payload,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ contract: QUOTE_WRITE_RECEIPT_CONTRACT, status: 'CREATED' });

    const existing = await app.inject({
      method: 'POST',
      url: '/v1/commands/freepass-estimate/issued-quotes',
      headers: { ...headers, 'idempotency-key': key },
      payload,
    });
    expect(existing.json().status).toBe('EXISTING');

    const read = await app.inject({
      url: `/v1/consumers/freepass-estimate/issued-quotes/${quote.quoteId}?quoteVersion=1`,
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      contract: QUOTE_READ_RECEIPT_CONTRACT,
      status: 'FOUND',
      quoteId: quote.quoteId,
      quoteVersion: 1,
      snapshotHash: quote.snapshotHash,
    });
    await app.close();
  });

  it('rejects a Quote whose immutable snapshot was changed without changing its hash', async () => {
    const store = memoryArtifacts();
    const app = gateway(store);
    const original = issuedQuote();
    const quote = { ...original, monthlyRental: Number(original.monthlyRental) + 1 };
    const key = quoteIdempotencyKey(original);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/commands/freepass-estimate/issued-quotes',
      headers: { ...headers, 'idempotency-key': key },
      payload: {
        command: 'PUT_ISSUED_QUOTE',
        contract: 'freepass-quote-repository/v1',
        idempotencyKey: key,
        quote,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('QUOTE_V2_INTEGRITY_MISMATCH');
    expect(store.quoteWrites).toBe(0);
    await app.close();
  });

  it('persists a Share Envelope only after every referenced Quote version exists', async () => {
    const store = memoryArtifacts();
    const app = gateway(store);
    const quote = issuedQuote();
    const envelope = shareEnvelope(quote);
    const envelopeKey = shareEnvelopeIdempotencyKey(envelope);
    const envelopePayload = {
      command: 'PUT_SHARE_ENVELOPE',
      contract: 'freepass-share-envelope-repository/v1',
      idempotencyKey: envelopeKey,
      envelope,
    };

    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/commands/freepass-estimate/share-envelopes',
      headers: { ...headers, 'idempotency-key': envelopeKey },
      payload: envelopePayload,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('SHARE_ENVELOPE_QUOTE_NOT_PERSISTED');

    const quoteKey = quoteIdempotencyKey(quote);
    await app.inject({
      method: 'POST',
      url: '/v1/commands/freepass-estimate/issued-quotes',
      headers: { ...headers, 'idempotency-key': quoteKey },
      payload: {
        command: 'PUT_ISSUED_QUOTE',
        contract: 'freepass-quote-repository/v1',
        idempotencyKey: quoteKey,
        quote,
      },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/commands/freepass-estimate/share-envelopes',
      headers: { ...headers, 'idempotency-key': envelopeKey },
      payload: envelopePayload,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      contract: SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT,
      status: 'CREATED',
      envelopeId: envelope.envelopeId,
    });

    const read = await app.inject({
      url: `/v1/consumers/freepass-estimate/share-envelopes/${envelope.envelopeId}`,
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      contract: SHARE_ENVELOPE_READ_RECEIPT_CONTRACT,
      status: 'FOUND',
      envelopeId: envelope.envelopeId,
      snapshotHash: envelope.snapshotHash,
    });
    await app.close();
  });
});

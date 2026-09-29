import { describe, expect, it, vi } from 'vitest';
import { runEstimateWriterCanary } from '../src/jobs/probe-estimate-writer-canary.js';

describe('Estimate writer synthetic canary', () => {
  it('requires create, idempotent replay and exact readback for both immutable artifacts', async () => {
    let quoteHash = '';
    let envelopeHash = '';
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.quote) {
        quoteHash = body.quote.snapshotHash;
        expect(body.quote.pricingEngineVersion).toBe('synthetic-canary/v1');
        expect(body.quote.calculationProvenance).toMatchObject({ evidence: 'SYNTHETIC_CANARY:run-123', verified: true });
        expect(body.quote.sourceRevision).toBe('synthetic-canary:run-123');
      }
      if (body?.envelope) envelopeHash = body.envelope.snapshotHash;
      const responses = [
        { status: 'CREATED', persistedAt: '2026-09-30T00:00:01.000Z' },
        { status: 'EXISTING', persistedAt: '2026-09-30T00:00:01.000Z' },
        { status: 'FOUND', snapshotHash: quoteHash },
        { status: 'CREATED', persistedAt: '2026-09-30T00:00:02.000Z' },
        { status: 'EXISTING', persistedAt: '2026-09-30T00:00:02.000Z' },
        { status: 'FOUND', snapshotHash: envelopeHash },
      ];
      return new Response(JSON.stringify(responses[call++]), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await runEstimateWriterCanary({ baseUrl: 'https://writer.example/', cloudRunIdToken: 'cloud-token', consumerToken: 'consumer-token', runId: 'run-123', now: new Date('2026-09-30T00:00:00.000Z'), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('PASS');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-Serverless-Authorization': 'Bearer cloud-token', Authorization: 'Bearer consumer-token' });
  });

  it('fails closed if the first immutable write was not newly created', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'EXISTING', persistedAt: 'x' }), { status: 200 }));
    await expect(runEstimateWriterCanary({ baseUrl: 'https://writer.example', cloudRunIdToken: 'cloud-token', consumerToken: 'consumer-token', runId: 'run-duplicate', now: new Date('2026-09-30T00:00:00.000Z'), fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow('QUOTE_CANARY_EVIDENCE_MISMATCH');
  });
});

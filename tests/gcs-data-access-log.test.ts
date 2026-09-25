import { describe, expect, it, vi } from 'vitest';
import { gcsDataAccessLogStore } from '../src/infra/gcs-data-access-log.js';
import type { DataAccessEvent } from '../src/domain/data-access.js';

const event: DataAccessEvent = {
  contractVersion: 'data-access-event-v1',
  eventId: 'evt_test',
  operationId: 'op_test',
  mode: 'READ',
  phase: 'STARTED',
  operation: 'READ_ERP5_SOURCE_CAPTURE',
  actor: { id: 'service:test', kind: 'SERVICE' },
  clientId: 'job:test',
  purpose: 'synthetic access audit',
  resource: { kind: 'SOURCE', name: 'synthetic/source' },
  startedAt: '2026-09-25T11:55:00.000Z',
  occurredAt: '2026-09-25T11:55:00.000Z'
};

describe('GCS Data access log store', () => {
  it('creates one immutable object without exposing the access token', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const store = gcsDataAccessLogStore({
      bucket: 'freepass-private-evidence',
      accessToken: 'synthetic-token',
      fetcher: fetcher as typeof fetch
    });

    await store.appendDataAccessEvent(event);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain(
      'name=access-events%2F2026%2F09%2F25%2Fevt_test.json'
    );
    expect(String(url)).toContain('ifGenerationMatch=0');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect((init?.headers as Record<string, string>).Authorization)
      .toBe('Bearer synthetic-token');
    expect(init?.body).toBe(JSON.stringify(event));
    expect(String(init?.body)).not.toContain('synthetic-token');
  });

  it('fails closed on invalid bucket or missing token before network access', () => {
    const fetcher = vi.fn();
    expect(() => gcsDataAccessLogStore({
      bucket: '../bad',
      accessToken: 'synthetic-token',
      fetcher: fetcher as typeof fetch
    })).toThrow('INVALID_DATA_ACCESS_LOG_BUCKET');
    expect(() => gcsDataAccessLogStore({
      bucket: 'freepass-private-evidence',
      accessToken: '',
      fetcher: fetcher as typeof fetch
    })).toThrow('MISSING_DATA_ACCESS_LOG_TOKEN');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails when append-only upload is rejected', async () => {
    const store = gcsDataAccessLogStore({
      bucket: 'freepass-private-evidence',
      accessToken: 'synthetic-token',
      fetcher: (async () => new Response('{}', { status: 412 })) as typeof fetch
    });

    await expect(store.appendDataAccessEvent(event))
      .rejects.toThrow('DATA_ACCESS_LOG_HTTP_412');
  });
});

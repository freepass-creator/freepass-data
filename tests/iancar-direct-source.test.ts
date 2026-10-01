import { describe, expect, it, vi } from 'vitest';
import {
  compareIancarInventory, IANCAR_DIRECT_ORIGIN, IANCAR_DIRECT_SOURCE_ID,
  prepareIancarDirectInventory, readOriginalIancarInventory
} from '../src/adapters/iancar-direct-source.js';

const NOW = '2026-09-30T10:05:00.000Z';
const full = () => ({
  total: 2, fleetTotal: 2, reservedTotal: 0, stale: false,
  syncedAt: '2026-09-30T10:00:00Z', reservedVehicles: [],
  models: [{
    name: 'test-model', units: [
      { plate: '12가 3456', vehicleNo: 'v1', status: 'available', mileage: 800 },
      { plate: '34나 5678', vehicleNo: 'v2', status: 'merchandising', mileage: 900 }
    ]
  }]
});

describe('FreePass Data native Iancar source boundary', () => {
  it('builds FULL/COMPLETE raw inventory from the original ERP, never a price or publication claim', () => {
    const result = prepareIancarDirectInventory(full(), NOW);
    expect(result.batch.source.sourceId).toBe(IANCAR_DIRECT_SOURCE_ID);
    expect(result.batch.coverage).toMatchObject({ mode: 'FULL', completeness: 'COMPLETE' });
    expect(result.batch.observedAt).toBe('2026-09-30T10:00:00.000Z');
    expect(result.batch.records.map(r => r.sourceRecordId)).toEqual(['12가3456', '34나5678']);
    expect(result.evidence).toMatchObject({
      readyForRawIngest: true, pricingVerified: false, canonicalWriteAuthorized: false,
      publicationAuthorized: false, modelUnits: 2
    });
    expect(result.batch.records[0]?.payload).not.toHaveProperty('rental');
    expect(result.batch.records[0]?.payload).not.toHaveProperty('deposit');
  });

  it('never turns a stale or partially counted 200 response into a FULL authoritative head', () => {
    const stale = prepareIancarDirectInventory({ ...full(), stale: true, total: 3 }, NOW);
    expect(stale.evidence.issues).toContain('UPSTREAM_STALE_OR_UNVERIFIED');
    expect(stale.evidence.issues).toContain('INVENTORY_COUNT_MISMATCH');
    expect(stale.batch.coverage).toMatchObject({ mode: 'PARTIAL', completeness: 'INCOMPLETE' });
    expect(stale.evidence.readyForRawIngest).toBe(false);
  });

  it('holds the source even if collection succeeded but its upstream sync age is unknown', () => {
    const source = prepareIancarDirectInventory({ ...full(), syncedAt: null }, NOW);
    expect(source.evidence.issues).toContain('UPSTREAM_FRESHNESS_UNVERIFIED');
    expect(source.batch.coverage.completeness).toBe('INCOMPLETE');
  });

  it('rejects duplicate inventory plates rather than overwriting one vehicle', () => {
    const raw = full();
    raw.models[0]!.units[1]!.plate = '12 가3456';
    expect(() => prepareIancarDirectInventory(raw, NOW)).toThrow('INVALID_OR_DUPLICATE_IANCAR_PLATE');
  });

  it('records reservations without reclassifying a contradictory available vehicle silently', () => {
    const raw = { ...full(), reservedTotal: 1, reservedVehicles: [{ plate: '12가3456' }] };
    const result = prepareIancarDirectInventory(raw, NOW);
    expect(result.batch.records).toHaveLength(2);
    expect(result.batch.records[0]?.payload.sourceStatus).toBe('reserved');
    expect(result.evidence.issues).toContain('RESERVATION_STATUS_CONFLICT');
    expect(result.batch.coverage.completeness).toBe('INCOMPLETE');
  });

  it('holds unknown supplier availability states without guessing they mean available', () => {
    const raw = full();
    raw.models[0]!.units[0]!.status = 'new-status';
    const result = prepareIancarDirectInventory(raw, NOW);
    expect(result.batch.records[0]?.payload.sourceStatus).toBe('new-status');
    expect(result.evidence.issues).toContain('UNKNOWN_SOURCE_STATUS');
    expect(result.evidence.publicationAuthorized).toBe(false);
  });

  it('detects both set directions and a per-plate status mismatch, not just total count', () => {
    const result = prepareIancarDirectInventory(full(), NOW);
    const parity = compareIancarInventory(result, [
      { plate: '12가3456', status: '계약중' },
      { plate: '56다7890', status: '출고가능' }
    ]);
    expect(parity).toMatchObject({
      sourceCount: 2, targetCount: 2, sourceOnly: 1, targetOnly: 1,
      statusMismatch: 1, status: 'HOLD_SOURCE_PARITY', publicationAuthorized: false
    });
    expect(compareIancarInventory(result, [
      { plate: '12가3456', status: '출고가능' },
      { plate: '34나5678', status: '출고협의' }
    ])).toMatchObject({ status: 'SOURCE_INVENTORY_PARITY_ONLY', pricingVerified: false });
  });

  it('flags duplicate target records rather than counting them as corroboration', () => {
    const result = prepareIancarDirectInventory(full(), NOW);
    expect(compareIancarInventory(result, [
      { plate: '12가3456', status: '출고가능' },
      { plate: '12가 3456', status: '출고가능' },
      { plate: '34나5678', status: '출고협의' }
    ])).toMatchObject({ duplicateTarget: 1, status: 'HOLD_SOURCE_PARITY' });
  });

  it('uses the ORIGINAL ERP login/session/inventory endpoints with no ERP4 runtime', async () => {
    const called: string[] = [];
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      called.push(`${options.method} ${url}`);
      expect(options.redirect).toBe('manual');
      if (url.endsWith('/api/auth/login'))
        return new Response('{}', { status: 200, headers: { 'set-cookie': 'eancar_session=synthetic; Path=/; HttpOnly' } });
      if (url.endsWith('/login')) return new Response('', { status: 200 });
      if (url.endsWith('/api/inventory')) {
        expect(String((options.headers as Record<string, string>).cookie)).toContain('eancar_session=');
        return new Response(JSON.stringify(full()), { status: 200 });
      }
      throw new Error('unexpected request');
    });
    const captured = await readOriginalIancarInventory({ email: 'synthetic', password: 'not-real' }, fetcher as typeof fetch);
    expect(captured).toMatchObject({ total: 2 });
    expect(called).toEqual([
      `GET ${IANCAR_DIRECT_ORIGIN}/login`,
      `POST ${IANCAR_DIRECT_ORIGIN}/api/auth/login`,
      `GET ${IANCAR_DIRECT_ORIGIN}/api/inventory`
    ]);
  });

  it('rejects login redirects and missing session cookies; no inventory call after denial', async () => {
    const unauthorized = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/login' } }));
    await expect(readOriginalIancarInventory({ email: 'a', password: 'b' }, unauthorized as typeof fetch))
      .rejects.toThrow('IANCAR_SOURCE_HTTP_SESSION_302');
    expect(unauthorized).toHaveBeenCalledTimes(1);
    const missing = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(readOriginalIancarInventory({ email: 'a', password: 'b' }, missing as typeof fetch))
      .rejects.toThrow('IANCAR_AUTH_SESSION_MISSING');
    expect(missing).toHaveBeenCalledTimes(2);
  });
});

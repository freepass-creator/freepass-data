import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { captureIancarSource, inspectIancarCapture, IANCAR_SHEET_TABS,
  iancarErpReadTransport, parseIancarErpInventory, buildIancarErpRawIntakeBatch } from '../src/adapters/iancar-source-capture.js';
import { canAssertSourceAbsence } from '../src/domain/source.js';
import { ingestRawSourceBatch } from '../src/application/ingest-raw-source.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';

const transport = (rateCoverageComplete = true, complete = true) => ({
  async readErp() { return { sourceRevision: 'erp:r1', observedAt: '2026-09-22T07:00:00Z', collectionComplete: complete,
    parserVersion: 'synthetic-parser/1', vehicles: [{ vehicleNo: 'private-1' }],
    rateQuotes: rateCoverageComplete ? [{ vehicleNo: 'private-1', months: 24, rent: 1 }] : [],
    rateCoverageComplete, raw: { source: 'synthetic', vehicles: [{ vehicleNo: 'private-1' }] } }; },
  async readSheetTab(tab: typeof IANCAR_SHEET_TABS[number]) { return { sourceRevision: `sheet:${tab.gid}`,
    observedAt: '2026-09-22T07:00:01Z', collectionComplete: complete, rowCount: 1, rawCsv: '차량번호\nprivate-1' }; }
});

const inventory = () => ({ models: [{ name: 'synthetic-model', count: 1,
  units: [{ vehicleNo: 'erp-only-new', plate: 'synthetic-plate', available: true, status: 'available' }] }],
  reservedVehicles: [{ vehicleNo: 'reserved-1', plate: 'reserved-plate' }],
  total: 1, reservedTotal: 1, fleetTotal: 950, stale: false, syncedAt: new Date().toISOString() });

describe('direct Iancar ERP ingestion', () => {
  it.each([true, false])('actual job preserves the write gate and requires ERP auth in dry-run (%s)', dryRun => {
    let failure = '';
    try {
      execFileSync(process.execPath, ['--import', 'tsx',
        fileURLToPath(new URL('../src/jobs/ingest-erp5-source.ts', import.meta.url)), '--iancar-erp',
        ...(dryRun ? ['--dry-run'] : [])], { encoding: 'utf8', stdio: 'pipe',
        timeout: 10_000, env: { ...process.env, ERP5_SOURCE_INGEST_APPROVED: 'false',
          FREEPASS_ERP5_READ_ACCESS_TOKEN: 'synthetic', FREEPASS_DATA_EVIDENCE_BUCKET: 'synthetic',
          IANKA_ACCOUNT_JSON: 'invalid' } });
    } catch (error) { failure = String((error as { stderr?: unknown }).stderr ?? ''); }
    expect(failure).toContain(dryRun ? 'IANCAR_CREDENTIAL_INVALID' : 'ERP5_SOURCE_INGEST_APPROVED=true required');
  });
  it('uses the existing intake store to retain raw/new vehicles, replay idempotently and forbid fleet absence', async () => {
    const store = new MemorySourceStore();
    const original = inventory();
    const batch = buildIancarErpRawIntakeBatch(parseIancarErpInventory(original));
    const run = await ingestRawSourceBatch(store, batch);
    const replay = await ingestRawSourceBatch(store, batch);
    expect(replay.runId).toBe(run.runId);
    expect(run).toMatchObject({ status: 'COMPLETED', headStatus: 'CURRENT', rawCount: 3, candidateCount: 0 });
    expect(canAssertSourceAbsence(run)).toBe(false);
    const rows = await store.listRaw(run.runId);
    expect(rows.find(row => row.sourceRecordId === '__inventory_snapshot')?.payload.raw).toEqual(original);
    expect(rows.find(row => row.sourceRecordId === 'vehicle:erp-only-new')?.payload.vehicle).toMatchObject({ vehicleNo: 'erp-only-new' });
  });
  it('includes ERP-only new and reserved vehicles without consulting any existing product or Sheet', () => {
    const capture = parseIancarErpInventory(inventory());
    const batch = buildIancarErpRawIntakeBatch(capture);
    expect(batch.source.kind).toBe('API');
    expect(batch.records.map(row => row.sourceRecordId)).toEqual(['__inventory_snapshot', 'vehicle:erp-only-new', 'vehicle:reserved-1']);
    expect(batch.records[1]?.payload.pricingState).toBe('UNKNOWN');
    expect(capture.rateQuotes).toEqual([]);
    expect(batch.coverage).toMatchObject({ mode: 'PARTIAL', completeness: 'COMPLETE' });
    expect(canAssertSourceAbsence({ status: 'COMPLETED', headStatus: 'CURRENT', coverage: batch.coverage } as never)).toBe(false);
  });
  it.each([true, false])('does not activate stale or over-age upstream (%s)', stale => {
    const raw = inventory();
    raw.stale = stale;
    if (!stale) raw.syncedAt = '2020-01-01T00:00:00Z';
    expect(buildIancarErpRawIntakeBatch(parseIancarErpInventory(raw)).coverage.completeness).toBe('INCOMPLETE');
  });
  it('rejects future observations and preserves original state instead of promoting availability', () => {
    const raw = inventory(); raw.syncedAt = '2099-01-01T00:00:00Z'; raw.models[0]!.units[0]!.status = 'unknown';
    const capture = parseIancarErpInventory(raw);
    expect(capture.collectionComplete).toBe(false);
    expect(capture.vehicles[0]).toMatchObject({ status: 'unknown' });
  });
  it('rejects truncated, duplicate and malformed inventory', () => {
    const wrongCount = inventory(); wrongCount.total = 2;
    expect(() => parseIancarErpInventory(wrongCount)).toThrow('COUNT_MISMATCH');
    const duplicate = inventory(); duplicate.reservedVehicles[0]!.vehicleNo = 'erp-only-new';
    expect(() => parseIancarErpInventory(duplicate)).toThrow('ID_INVALID');
    expect(() => parseIancarErpInventory({ models: [] })).toThrow('SHAPE_INVALID');
  });
  it('rejects derived payload tampering and does not claim invented rates', () => {
    const capture = parseIancarErpInventory(inventory()); capture.rateCoverageComplete = true;
    expect(() => buildIancarErpRawIntakeBatch(capture)).toThrow('DERIVATION_MISMATCH');
  });
  it('keeps captured completeness deterministic on delayed replay and rejects flag tampering', () => {
    const raw = inventory(); raw.syncedAt = '2026-09-30T07:00:00Z';
    const future = parseIancarErpInventory(raw, new Date('2026-09-30T06:59:00Z'));
    const fresh = parseIancarErpInventory(raw, new Date('2026-09-30T07:01:00Z'));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-30T07:30:00Z'));
      expect(buildIancarErpRawIntakeBatch(future).coverage.completeness).toBe('INCOMPLETE');
      const first = buildIancarErpRawIntakeBatch(fresh);
      vi.setSystemTime(new Date('2026-10-01T07:30:00Z'));
      expect(buildIancarErpRawIntakeBatch(fresh)).toEqual(first);
      future.collectionComplete = true;
      expect(() => buildIancarErpRawIntakeBatch(future)).toThrow('DERIVATION_MISMATCH');
    } finally { vi.useRealTimers(); }
  });
  it('authenticates on the fixed supplier origin and follows no redirects', async () => {
    const responses = [new Response('login'), new Response('{"ok":true}', {
      headers: { 'Set-Cookie': 'eancar_session=synthetic; HttpOnly; Secure' } }), new Response(JSON.stringify(inventory()))];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const capture = await iancarErpReadTransport({ accountJson: '{"email":"synthetic","password":"private"}', fetchImpl })();
    expect(capture.vehicles).toHaveLength(2);
    expect(vi.mocked(fetchImpl).mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual(['/login', '/api/auth/login', '/api/inventory']);
    expect(vi.mocked(fetchImpl).mock.calls.every(call => call[1]?.redirect === 'error')).toBe(true);
    expect(vi.mocked(fetchImpl).mock.calls[2]?.[1]?.headers).toMatchObject({ Cookie: 'eancar_session=synthetic' });
  });
  it('fails closed on missing credentials, auth-without-session, and body-bearing HTTP errors', async () => {
    expect(() => iancarErpReadTransport({ accountJson: 'bad' })).toThrow('CREDENTIAL_INVALID');
    const fetchImpl = vi.fn(async () => new Response('secret-body', { status: 403 })) as unknown as typeof fetch;
    await expect(iancarErpReadTransport({ accountJson: '{"email":"x","password":"secret"}', fetchImpl })()).rejects.toThrow('IANCAR_ERP_HTTP_403');
    const responses = [new Response(''), new Response('{"ok":true}')];
    const noSession = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    await expect(iancarErpReadTransport({ accountJson: '{"email":"x","password":"secret"}', fetchImpl: noSession })()).rejects.toThrow('AUTH_NOT_CONFIRMED');
  });
});

describe('Iancar two-source capture', () => {
  it('preserves independent ERP and both Sheet originals with a digest', async () => {
    const capture = await captureIancarSource(transport());
    expect(capture.erp.raw).toEqual({ source: 'synthetic', vehicles: [{ vehicleNo: 'private-1' }] });
    expect(capture.sheet.tabs.map(tab => tab.title)).toEqual(['이안카', '이안카 재렌트']);
    expect(capture.crossSourceConsistency).toBe('NON_ATOMIC');
    expect(capture.erp.rawDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(capture.sheet.tabs[0]?.rawCsv).toContain('private-1');
    expect(inspectIancarCapture(capture)).toMatchObject({ status: 'READY_FOR_MAPPING_REVIEW', canonicalWriteAuthorized: false });
  });
  it('detects any mutation of preserved source evidence', async () => {
    const capture = await captureIancarSource(transport());
    capture.erp.vehicles.push({ vehicleNo: 'changed' });
    expect(() => inspectIancarCapture(capture)).toThrow('IANCAR_CAPTURE_DIGEST_MISMATCH');
  });
  it('preserves incomplete evidence but holds mapping and price activation', async () => {
    expect(inspectIancarCapture(await captureIancarSource(transport(false, false)))).toMatchObject({
      status: 'HOLD', coverageComplete: false, pricingComplete: false, cutoverAuthorized: false
    });
  });
  it('keeps coverage and pricing holds independent', async () => {
    expect(inspectIancarCapture(await captureIancarSource(transport(false, true)))).toMatchObject({
      status: 'HOLD', coverageComplete: true, pricingComplete: false,
      remaining: ['ERP_RATE_COVERAGE_INCOMPLETE', 'NO_CANONICAL_WRITE_OR_CONSUMER_CUTOVER']
    });
  });
  it('fails the entire capture when either Sheet tab fails', async () => {
    const base = transport();
    await expect(captureIancarSource({ ...base, async readSheetTab(tab) {
      if (tab.gid === '126495265') throw new Error('synthetic sheet failure');
      return base.readSheetTab(tab);
    } })).rejects.toThrow('synthetic sheet failure');
  });
  it('rejects unsupported non-JSON ERP values instead of silently losing them', async () => {
    const base = transport();
    await expect(captureIancarSource({ ...base, async readErp() {
      return { ...(await base.readErp()), raw: { bad: undefined } } as never;
    } })).rejects.toThrow('INVALID_IANCAR_ERP_CAPTURE');
  });
  it('rejects non-plain ERP objects whose JSON representation could hide derivation changes', async () => {
    const base = transport();
    await expect(captureIancarSource({ ...base, async readErp() {
      return { ...(await base.readErp()), raw: new Date('2026-09-22T07:00:00Z') } as never;
    } })).rejects.toThrow('INVALID_IANCAR_ERP_CAPTURE');
  });
  it('persists once under the fixed private root and verifies the readback digest', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'iancar-capture-test-'));
    try {
      vi.resetModules();
      vi.doMock('node:os', () => ({ homedir: () => fakeHome }));
      const isolated = await import('../src/adapters/iancar-source-capture.js');
      const capture = await isolated.captureIancarSource(transport());
      const saved = await isolated.persistIancarCapture(capture);
      expect(saved.capturePath.startsWith(join(fakeHome, '.codex', 'private'))).toBe(true);
      expect(JSON.parse(await readFile(saved.capturePath, 'utf8')).digest).toBe(capture.digest);
    } finally {
      vi.doUnmock('node:os');
      vi.resetModules();
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { GoogleAuth } from 'google-auth-library';
import { aicaSourceAdapter, ironSourceAdapter, parseIronRawDetail, IRON_DETAIL_REQUEST_LIMITS,
  type AicaGridObservation, type SupplierGridCell } from '../src/adapters/supplier-source-capture.js';
import { collectSupplierSource } from '../src/domain/source-intake.js';
import { aicaSheetsGridReader, AICA_GRID_FIELDS } from '../src/infra/aica-sheet-reader.js';
import { buildIancarRelayServer, iancarRelayHandler, IANCAR_DISPATCH, type IancarRelayPorts,
  type RelayOutcome } from '../src/api/iancar-scheduler-relay.js';

const now = '2026-10-03T00:00:00.000Z';
const cell = (value: string): SupplierGridCell => ({ userEnteredValue: { stringValue: value } });
const rich = (value: string, url = 'https://example.invalid/gallery/a'): SupplierGridCell => ({
  ...cell(value), effectiveValue: { stringValue: value }, formattedValue: value,
  hyperlink: url, userEnteredFormat: { textFormat: { link: { uri: `${url}?format=1` } } },
  textFormatRuns: [{ startIndex: 0, format: { link: { uri: `${url}?run=1` } } }],
});
function grid(tabId = 1): AicaGridObservation {
  return { sheetId: 'fixture-sheet', tabId, range: `'재고 ${tabId}'!A1:C10`, plateColumn: 0,
    observedAt: now, revision: 'fixture/1', complete: true, expectedRows: 1, firstDataRow: 1,
    headers: [cell('차량번호'), cell('요금'), cell('보증금')], rows: [[rich('12가3456'), cell('90만원'), cell('협의')]] };
}
const captureAica = (grids: AicaGridObservation[]) => collectSupplierSource(aicaSourceAdapter({
  sourceId: 'fixture:RP004', bindings: grids.map(({ sheetId, tabId, range, plateColumn }) => ({ sheetId, tabId, range, plateColumn })),
  expectedFreshnessSeconds: 60, readGrid: async binding => grids.find(item => item.tabId === binding.tabId)!,
}), now);

describe('RP004 native rich-cell RAW', () => {
  it('reuses ADC with explicit target and read-only Sheets scope without a new key', async () => {
    const observed: unknown[] = [];
    const token = vi.spyOn(GoogleAuth.prototype, 'getAccessToken').mockImplementation(async function (this: GoogleAuth) {
      // Inspect configured scopes at the mocked credential boundary; never resolve real ADC.
      observed.push(Reflect.get(this, 'scopes')); return 'fixture-token';
    });
    const original = grid();
    vi.stubEnv('FIREBASE_PROJECT_ID', 'freepasserp5');
    try {
      await aicaSheetsGridReader({ now: () => now, fetcher: async () => new Response(JSON.stringify({
        spreadsheetId: original.sheetId, sheets: [{ properties: { sheetId: 1 }, data: [{
          rowData: [{ values: original.headers }, { values: original.rows[0] }],
        }] }],
      })) })(original);
      expect(observed).toEqual([['https://www.googleapis.com/auth/spreadsheets.readonly']]);
      expect(token).toHaveBeenCalledTimes(1);
    } finally { token.mockRestore(); vi.unstubAllEnvs(); }
  });
  it('preserves typed cells, every rich-link location and physical attribution without photo promotion', async () => {
    const original = grid(); original.firstDataRow = 7;
    original.rows[0]![1] = { userEnteredValue: { formulaValue: '=1+1' }, effectiveValue: { numberValue: 2 }, formattedValue: '2' };
    const result = await captureAica([original]);
    expect(result.evidence.status).toBe('RAW_READY');
    expect(result.batch.records[0]!.payload).toMatchObject({ cells: original.rows[0], row: 8, tabId: 1,
      plate: '12가3456', photoState: 'UNKNOWN', links: ['https://example.invalid/gallery/a',
        'https://example.invalid/gallery/a?format=1', 'https://example.invalid/gallery/a?run=1'] });
    expect(result.batch.records[0]!.payload).not.toHaveProperty('image_urls');
    (result.batch.records[0]!.payload.cells as SupplierGridCell[])[0]!.hyperlink = 'changed';
    expect(original.rows[0]![0]!.hyperlink).toBe('https://example.invalid/gallery/a');
  });
  it('holds duplicate/blank plates, shared links and short links without discarding rows', async () => {
    const first = grid(), second = grid(2);
    second.rows = [[rich('12 가 3456')], [rich('34나5678')], [rich('', 'https://bit.ly/fixture')]];
    second.expectedRows = 3;
    const { batch, evidence } = await captureAica([first, second]);
    expect(batch.records).toHaveLength(4);
    expect(batch.coverage).toMatchObject({ mode: 'PARTIAL', completeness: 'INCOMPLETE' });
    expect(new Set(batch.records.map(item => item.sourceRecordId)).size).toBe(4);
    expect(evidence.status).toBe('HOLD');
    expect(evidence.issues).toEqual(expect.arrayContaining(['AICA_EMPTY_PLATE', 'AICA_DUPLICATE_PLATE', 'AICA_SHARED_LINK', 'AICA_SHORT_LINK']));
    expect(batch.records.every(item => item.payload.photoState === 'UNKNOWN')).toBe(true);
  });
  it('rejects binding substitutions and propagates failure rather than empty success', async () => {
    const original = grid();
    const adapter = aicaSourceAdapter({ sourceId: 'fixture', bindings: [original], expectedFreshnessSeconds: 60,
      readGrid: async () => ({ ...original, tabId: 99 }) });
    await expect(adapter.read()).rejects.toThrow('AICA_GRID_BINDING_MISMATCH');
    adapter.read = aicaSourceAdapter({ sourceId: 'fixture', bindings: [original], expectedFreshnessSeconds: 60,
      readGrid: async () => { throw new Error('fixture-unavailable'); } }).read;
    await expect(adapter.read()).rejects.toThrow('fixture-unavailable');
  });
  it('does not hide future or incomplete secondary tabs behind oldest observation', async () => {
    const first = grid(), second = grid(2);
    second.observedAt = '2099-01-01T00:00:00Z'; second.complete = false;
    const result = await captureAica([first, second]);
    expect(result.evidence.issues).toEqual(expect.arrayContaining(['SOURCE_TIME_IN_FUTURE', 'SOURCE_COVERAGE_NOT_COMPLETE']));
  });
  it('uses one authenticated minimal-grid GET and does not invent supplier freshness/completeness', async () => {
    const original = grid();
    const response = { spreadsheetId: original.sheetId, sheets: [{ properties: { sheetId: 1 },
      data: [{ rowData: [{ values: original.headers }, ...original.rows.map(values => ({ values }))] }] }] };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response)));
    const accessToken = vi.fn(async () => 'fixture-token');
    const result = await aicaSheetsGridReader({ fetcher, accessToken, now: () => now })(original);
    expect(result.rows).toEqual(original.rows);
    expect(result).toMatchObject({ complete: false, expectedRows: null, observedAt: now });
    expect(accessToken).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe('https://sheets.googleapis.com');
    expect(url.searchParams.get('includeGridData')).toBe('true');
    expect(url.searchParams.get('fields')).toBe(AICA_GRID_FIELDS);
    expect(url.searchParams.get('ranges')).toBe(original.range);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { authorization: 'Bearer fixture-token' } });
    let nesting = 0;
    for (const c of AICA_GRID_FIELDS) { if (c === '(') nesting++; if (c === ')') nesting--; expect(nesting).toBeGreaterThanOrEqual(0); }
    expect(nesting).toBe(0);
  });
  it('holds auth/read errors without retries, credential leakage or false empty capture', async () => {
    const fetcher = vi.fn(async () => new Response('private upstream text', { status: 403 }));
    await expect(aicaSheetsGridReader({ fetcher, accessToken: async () => 'fixture-token' })(grid())).rejects.toThrow('AICA_GRID_HTTP_403');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(aicaSheetsGridReader({ fetcher, accessToken: async () => 'fixture-token' })({ ...grid(), range: 'C2:C10' }))
      .rejects.toThrow('AICA_GRID_RANGE_INVALID');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { spreadsheetId: 'wrong', sheets: [] },
    { spreadsheetId: 'fixture-sheet', sheets: [{ properties: { sheetId: 1 }, data: [{ startRow: 1, rowData: [] }] }] },
  ])('rejects a wrong or shifted grid response', async response => {
    await expect(aicaSheetsGridReader({ accessToken: async () => 'fixture-token',
      fetcher: async () => new Response(JSON.stringify(response)) })(grid())).rejects.toThrow('AICA_GRID_RESPONSE_INVALID');
  });
});

const target = { id: 'fixture-a', url: 'https://ironrentcar.com/vehicles/fixture-a', plate: '12가3456' };
const html = (deposit = '보증금 협의') => `<!doctype html><html><body><main>
  <h1 class="product-detail-title">Fixture</h1><dl><dt>차량번호</dt><dd>12가3456</dd></dl>
  <section class="product-detail-price-block--deposit"><span>${deposit}</span></section>
  <div class="product-detail-rent-row"><dt><b>72</b>개월</dt><dd>90만원</dd></div>
  <div class="product-detail-rent-row"><dt>84개월</dt><dd>800,000원</dd></div>
  <div class="product-detail-rent-row"><dt>53개월</dt><dd>협의</dd></div>
  <div class="product-detail-rent-mileage-note">연 2만 km</div>
  <div class="product-detail-gallery"><figure><img alt="a > b" src="/_next/image?url=%2Fa.jpg&amp;w=900"></figure><img src='/b.jpg'></div>
  <script>const fake = '<div class="product-detail-rent-row"><dt>1개월</dt><dd>0원</dd></div>';</script>
  </main></body></html>`;
describe('RP006 native detail RAW', () => {
  it('preserves nonstandard term tuples, units, gallery references and exact HTML', async () => {
    const original = html(); const fetchDetail = vi.fn(async () => ({ html: original, observedAt: now, revision: 'fixture/1' }));
    const result = await collectSupplierSource(ironSourceAdapter({ sourceId: 'fixture:RP006', targets: [target],
      expectedFreshnessSeconds: 60, fetchDetail }), now);
    const payload = result.batch.records[0]!.payload;
    expect(payload.html).toBe(original);
    expect(payload.terms).toEqual([
      expect.objectContaining({ periodRaw: '72개월', rentRaw: '90만원' }),
      expect.objectContaining({ periodRaw: '84개월', rentRaw: '800,000원' }),
      expect.objectContaining({ periodRaw: '53개월', rentRaw: '협의' }),
    ]);
    expect(payload.deposit).toEqual({ raw: ['보증금 협의'], state: 'UNKNOWN' });
    expect(payload.image_urls).toEqual(['/_next/image?url=%2Fa.jpg&amp;w=900', '/b.jpg']);
    expect(payload.captureIssues).toEqual([]);
    expect(result.evidence.status).toBe('HOLD'); // partial designated details, not whole inventory
    expect(fetchDetail).toHaveBeenCalledTimes(1);
  });
  it.each(['보증금 0원', '보증금 없음', '보증금 문의', ''])('keeps %s raw without substituting numeric zero', deposit => {
    expect(parseIronRawDetail(html(deposit), target).deposit).toEqual({ raw: [deposit], state: 'UNKNOWN' });
  });
  it('retains evidence on missing terms/photos and mismatched plate or malformed HTML', () => {
    expect(parseIronRawDetail('<main><dt>차량번호</dt><dd>99가9999</dd></main>', target).captureIssues)
      .toEqual(expect.arrayContaining(['IRON_PLATE_MISMATCH', 'IRON_TERMS_UNKNOWN', 'IRON_DEPOSIT_UNKNOWN', 'IRON_PHOTOS_UNKNOWN']));
    expect(parseIronRawDetail(html().replace('</figure>', ''), target).captureIssues).toContain('IRON_HTML_SHAPE_UNKNOWN');
  });
  it('validates all targets before fetch, forbids expanded hosts/duplicates and never retries failures', async () => {
    const fetchDetail = vi.fn(async () => { throw new Error('fixture fetch failed'); });
    const adapter = (targets: typeof target[]) => ironSourceAdapter({ sourceId: 'fixture', targets, expectedFreshnessSeconds: 60, fetchDetail });
    await expect(adapter([target, target]).read()).rejects.toThrow('IRON_TARGET_INVALID');
    await expect(adapter([{ ...target, url: 'https://other.invalid/vehicles/fixture-a' }]).read()).rejects.toThrow('IRON_TARGET_INVALID');
    expect(fetchDetail).not.toHaveBeenCalled();
    await expect(adapter([target]).read()).rejects.toThrow('fixture fetch failed');
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect(IRON_DETAIL_REQUEST_LIMITS).toEqual({ concurrency: 2, requestsPerVehicle: 1 });
  });
});

const jobName = 'projects/freepasserp5/locations/fixture-region/jobs/iancar-quarter-hour';
const request = (scheduleTime = now) => ({ authorization: 'Bearer fixture', jobName, scheduleTime, body: {} });
function relayFixture() {
  const claims = new Set<string>(), outcomes = new Map<string, { outcome: RelayOutcome; runId: string | null }>();
  let pending: string | null = null;
  const ports: IancarRelayPorts = {
    verifyScheduler: vi.fn(async authorization => authorization === 'Bearer fixture'),
    receipts: {
      createOnly: vi.fn(async receipt => { if (claims.has(receipt.key)) return 'EXISTS'; claims.add(receipt.key); return 'CREATED'; }),
      pending: vi.fn(async () => pending ? { key: pending, outcome: outcomes.get(pending)?.outcome ?? 'RESERVED' as const,
        runId: outcomes.get(pending)?.runId ?? null } : null),
      completePending: vi.fn(async (key, runId) => {
        if (pending !== key || outcomes.get(key)?.outcome !== 'ACCEPTED_PENDING' || outcomes.get(key)?.runId !== runId)
          throw new Error('wrong pending owner');
        pending = null;
      }),
      acquirePending: vi.fn(async key => { if (pending) return 'BUSY'; pending = key; return 'ACQUIRED'; }),
      recordOutcome: vi.fn(async (key, outcome, runId) => {
        if (outcomes.has(key)) throw new Error('already recorded');
        outcomes.set(key, { outcome, runId });
      }),
      releaseWithoutDispatch: vi.fn(async key => {
        if (pending !== key || outcomes.get(key)?.outcome !== 'SKIPPED_BUSY') throw new Error('wrong owner'); pending = null;
      }),
    },
    installationToken: vi.fn(async () => 'fixture-installation-token'), writerRuns: vi.fn(async () => 'IDLE' as const),
    runStatus: vi.fn(async () => 'INCOMPLETE' as const),
    dispatch: vi.fn(async () => ({ status: 'ACCEPTED' as const, runId: '1234' })),
  };
  return { ports, claims, outcomes, handle: iancarRelayHandler(ports, jobName) };
}
describe('RP031 scheduler relay port contract', () => {
  it('dispatches only fixed inputs once and retains pending admission until run reconciliation', async () => {
    const fixture = relayFixture();
    expect(await fixture.handle(request())).toMatchObject({ status: 'ACCEPTED_PENDING', runId: '1234' });
    expect(fixture.ports.dispatch).toHaveBeenCalledWith('fixture-installation-token', IANCAR_DISPATCH);
    expect(IANCAR_DISPATCH.inputs).toEqual({ iancar_only: 'true', iancar_apply: 'true', apply: 'false', target: 'ALL' });
    expect(await fixture.handle(request('2026-10-03T00:00:00Z'))).toMatchObject({ status: 'DUPLICATE' });
    expect(await fixture.handle(request('2026-10-03T00:15:00Z'))).toMatchObject({ status: 'SKIPPED_BUSY' });
    expect(fixture.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.ports.receipts.releaseWithoutDispatch).not.toHaveBeenCalled();
  });
  it('admits only one of concurrent requests across equal AND different schedule keys', async () => {
    const fixture = relayFixture();
    const results = await Promise.all([fixture.handle(request()), fixture.handle(request()), fixture.handle(request('2026-10-03T00:15:00Z'))]);
    expect(results.map(result => result.status).sort()).toEqual(['ACCEPTED_PENDING', 'DUPLICATE', 'SKIPPED_BUSY']);
    expect(fixture.ports.dispatch).toHaveBeenCalledTimes(1);
  });
  it('allows a later tick only after the exact accepted run completes and owner-checked release succeeds', async () => {
    const fixture = relayFixture();
    const first = await fixture.handle(request());
    fixture.ports.runStatus = vi.fn(async () => 'COMPLETED' as const);
    expect(await fixture.handle(request('2026-10-03T00:15:00Z'))).toMatchObject({ status: 'ACCEPTED_PENDING' });
    expect(fixture.ports.runStatus).toHaveBeenCalledWith('fixture-installation-token', '1234');
    expect(fixture.ports.receipts.completePending).toHaveBeenCalledWith(first.key, '1234');
    expect(fixture.ports.dispatch).toHaveBeenCalledTimes(2);
  });
  it('keeps an accepted admission when run status or completion persistence is unknown', async () => {
    for (const failure of ['status', 'completion']) {
      const fixture = relayFixture(); await fixture.handle(request());
      fixture.ports.runStatus = vi.fn(async () => failure === 'status' ? 'UNKNOWN' as const : 'COMPLETED' as const);
      fixture.ports.receipts.completePending = vi.fn(async () => { throw new Error('CAS unavailable'); });
      expect(await fixture.handle(request('2026-10-03T00:15:00Z'))).toMatchObject({ status: 'UNKNOWN' });
      expect(fixture.ports.dispatch).toHaveBeenCalledTimes(1);
    }
  });
  it.each(['BUSY', 'UNKNOWN'] as const)('does not dispatch when existing writer observation is %s', async state => {
    const fixture = relayFixture(); fixture.ports.writerRuns = vi.fn(async () => state);
    expect(await fixture.handle(request())).toMatchObject({ status: state === 'BUSY' ? 'SKIPPED_BUSY' : 'UNKNOWN' });
    expect(fixture.ports.dispatch).not.toHaveBeenCalled();
    expect(fixture.ports.receipts.releaseWithoutDispatch).toHaveBeenCalledTimes(state === 'BUSY' ? 1 : 0);
  });
  it.each(['timeout', 'missing-run', 'receipt-failure'])('keeps %s UNKNOWN without resend or clearing pending', async failure => {
    const fixture = relayFixture();
    fixture.ports.dispatch = vi.fn(async () => {
      if (failure === 'timeout') throw new Error('secret upstream response');
      return failure === 'missing-run' ? { status: 'ACCEPTED' as const } : { status: 'ACCEPTED' as const, runId: '1234' };
    });
    if (failure === 'receipt-failure') fixture.ports.receipts.recordOutcome = vi.fn(async () => { throw new Error('storage failed'); });
    const result = await fixture.handle(request());
    expect(result).toMatchObject({ status: 'UNKNOWN' });
    expect(JSON.stringify(result)).not.toMatch(/secret|fixture-installation-token/);
    expect(await fixture.handle(request())).toMatchObject({ status: 'DUPLICATE' });
    await fixture.handle(request('2026-10-03T00:15:00Z'));
    expect(fixture.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.ports.receipts.releaseWithoutDispatch).not.toHaveBeenCalled();
  });
  it('fails closed before token/dispatch when receipt or admission is uncertain', async () => {
    for (const phase of ['createOnly', 'acquirePending'] as const) {
      const fixture = relayFixture();
      fixture.ports.receipts[phase] = vi.fn(async () => { throw new Error('store unknown'); });
      expect(await fixture.handle(request())).toMatchObject({ status: 'UNKNOWN' });
      expect(fixture.ports.installationToken).not.toHaveBeenCalled();
      expect(fixture.ports.dispatch).not.toHaveBeenCalled();
    }
  });
  it('rejects unauthorized users, wrong jobs, invalid dates and caller-selected dispatch configuration', async () => {
    const fixture = relayFixture();
    expect(await fixture.handle({ ...request(), authorization: '' })).toEqual({ status: 'UNAUTHORIZED' });
    for (const change of [{ jobName: `${jobName}-other` }, { scheduleTime: 'invalid' }, { scheduleTime: '2026-02-30T00:00:00Z' },
      { body: { inputs: { apply: true } } }, { body: { ref: 'other' } }, { body: null }])
      expect(await fixture.handle({ ...request(), ...change })).toEqual({ status: 'INVALID_REQUEST' });
    expect(fixture.ports.receipts.createOnly).not.toHaveBeenCalled();
    expect(fixture.ports.installationToken).not.toHaveBeenCalled();
  });
  it('serves only the private POST route and acknowledges UNKNOWN without reporting refresh success', async () => {
    const fixture = relayFixture(); fixture.ports.dispatch = vi.fn(async () => ({ status: 'UNKNOWN' as const }));
    const server = buildIancarRelayServer(fixture.ports, jobName);
    try {
      expect((await server.inject({ method: 'POST', url: '/schedule', payload: {} })).statusCode).toBe(401);
      const response = await server.inject({ method: 'POST', url: '/schedule', payload: {}, headers: {
        authorization: 'Bearer fixture', 'x-cloudscheduler-jobname': jobName, 'x-cloudscheduler-scheduletime': now,
      } });
      expect(response.statusCode).toBe(200); expect(response.json().status).toBe('UNKNOWN');
      expect((await server.inject({ method: 'GET', url: '/schedule' })).statusCode).toBe(404);
    } finally { await server.close(); }
  });
});

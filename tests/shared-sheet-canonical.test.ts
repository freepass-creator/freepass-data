import { describe, expect, it, vi } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';
import { buildSharedSheetBatch, sharedSheetChannels, sharedSheetHeaders, sharedSheetCaptureDigest, type SharedSheetCapture, type SheetCell } from '../src/adapters/shared-sheet-source.js';
import { normalizeSharedSheet } from '../src/adapters/normalize-shared-sheet.js';
import { prepareRawSourceBatch } from '../src/application/ingest-raw-source.js';
import { planSharedSheetCanonical, runSharedSheetCanonical, preflightSharedSheetApply, writePrivateArtifact } from '../src/jobs/ingest-shared-sheet-canonical.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { queryCanonicalByPlate } from '../src/jobs/query-canonical-by-plate.js';
import type { SourceIngestionStore } from '../src/ports/source-store.js';
import { stableDigest } from '../src/shared/stable-digest.js';

const time = '2026-10-04T00:00:00.000Z';
function row(company: string, overrides: Record<string, SheetCell> = {}) {
  const data: Record<string, SheetCell> = { 회사명: company, 차량번호: 'TEST-FAKE-001', 차량상태: '출고가능', 상품구분: '중고렌트',
    제조사: '시험제조사', 모델: '시험모델', 세부모델: '시험세부모델', 세부트림: '시험트림', 연식: '26MY',
    최초등록일: '26.04', 연료: 'HEV', 주행거리: '1,234km', 배기량: '1,234cc', 인승: '5', 구동방식: 'AWD',
    단기보증: 101, 장기보증: 202, '1개월': 303, '12개월': 404, '24개월': 505, ...overrides };
  return sharedSheetHeaders.map(h => data[h] ?? '');
}
function capture(overrides: Record<string, SheetCell> = {}, company = '웰릭스'): SharedSheetCapture {
  const channel = sharedSheetChannels.find(x => x.companyName === company)!;
  return { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-sheet', layoutVersion: '2026-10-04-no-account',
    readTime: time, revision: 'synthetic-revision-1', tabs: [...new Set(sharedSheetChannels.map(x => x.tab))].map(title => {
      const values: SheetCell[][] = [[...sharedSheetHeaders], ...(title === channel.tab ? [row(company, overrides)] : [])];
      return { title, readTime: time, complete: true, rowCount: values.length, values };
    }) };
}
function normalized(c = capture()) { return normalizeSharedSheet(prepareRawSourceBatch(buildSharedSheetBatch(c)).rawRecords[0]!); }
async function stores() {
  const store = new MemoryDataStore();
  await store.seed({ catalogWriterOwnership: { scope: 'catalog', revision: 1, mode: 'EXCLUSIVE', primaryWriterId: 'service:freepass-data',
    allowedWriterIds: ['service:freepass-data'], previousWriterIds: [], effectiveAt: time, updatedAt: time,
    updatedBy: { id: 'service:freepass-data', kind: 'SERVICE' }, reason: 'synthetic ownership' } });
  // Both production ports share firestore-layout; mirror that shared physical layout in this test only.
  class SharedMemorySource extends MemorySourceStore {
    override async completeRun(input: Parameters<SourceIngestionStore['completeRun']>[0]) {
      const result = await super.completeRun(input);
      const run = (await this.getRun(input.runId))!;
      const head = await this.getSourceHead(run.sourceId);
      await store.seed({ sourceRuns: [run], ...(head ? { sourceHeads: [head] } : {}),
        candidates: await this.listCandidates(run.runId), rawRecords: await this.listRaw(run.runId), lineage: await this.listLineage(run.runId) });
      return result;
    }
  }
  return { store, source: new SharedMemorySource() };
}
async function apply(s: Awaited<ReturnType<typeof stores>>, c = capture()) {
  const p = await planSharedSheetCanonical(s.store, c, 'synthetic-target');
  const result = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
    plan: p.plan, expectedPlanDigest: p.report.planDigest });
  return { ...p, result };
}
function later(c: SharedSheetCapture) {
  c.readTime = '2026-10-04T00:15:00.000Z'; c.revision = 'synthetic-revision-2';
  for (const t of c.tabs) t.readTime = c.readTime;
  return c;
}
describe('shared sheet local source to Canonical', () => {
  it('creates only supplied periods and maps short/long deposits exactly', () => {
    const n = normalized(capture({ '6개월': '-', '36개월': '불가', '48개월': '' }));
    expect(n.record.candidate.priceTerms.map(x => [x.termMonths, x.deposit?.amount])).toEqual([[1, 101], [12, 101], [24, 202]]);
    expect(n.suppliedTerms).toBe(3);
  });
  it('normalizes model year, month precision, specs and explicit zero', () => {
    const n = normalized(capture({ 단기보증: '무보증', 배터리용량: '77.7kWh', 구동방식: 'FWD' }));
    const f = n.record.candidate.vehicleFacts!.fields;
    expect(f.modelYear!.value).toBe(2026); expect(f.firstRegistration!.value).toBe('2026-04');
    expect(f.displacementCc!.value).toBe(1234); expect(f.batteryKwh!.value).toBe(77.7); expect(f.drive!.value).toBe('2WD');
    expect(n.record.candidate.priceTerms[0]!.depositState).toBe('ZERO');
  });
  it.each(['26년식', '2026'])('accepts explicit year %s', value => expect(normalized(capture({ 연식: value })).record.candidate.vehicleFacts!.fields.modelYear!.value).toBe(2026));
  it('distinguishes company codes inside a shared tab', () => {
    const c = capture({}, '빌린카'), tab = c.tabs.find(x => x.title === '빌린카')!;
    tab.values.push(row('엘씨')); tab.rowCount++;
    const records = buildSharedSheetBatch(c).records;
    expect(records.map(x => x.payload.supplierCode)).toEqual(['RP021', 'PT-0026']);
    expect(records[0]!.sourceRecordId).not.toBe(records[1]!.sourceRecordId);
  });
  it('preserves all RAW cells without mutation and pins read time/revision/digest', async () => {
    const c = capture({ 비고: ' SYNTHETIC RAW ONLY ' }); const before = structuredClone(c);
    const s = await stores(); const p = await apply(s, c);
    expect(c).toEqual(before);
    const raw = (await s.source.listRaw(p.plan.runId))[0]!;
    expect(raw.payload.values).toEqual(c.tabs[0]!.values[1]);
    expect(raw.payload.rowDigest).toBe(stableDigest(raw.payload.values));
    expect(raw.observedAt).toBe(time); expect(raw.sourceRevision).toBe('synthetic-revision-1');
    await expect(s.source.appendRaw(raw)).rejects.toThrow('immutable');
    const f = (await s.store.listVehicleAssets())[0]!.sourceVehicleFacts!;
    expect(f.fields.modelYear!.evidence).toBe('26MY');
    expect((await s.store.listLineageByStage('NORMALIZED_TO_CANONICAL')).some(x => x.canonical?.fieldPath === 'sourceVehicleFacts')).toBe(true);
  });
  it('dry-run performs zero writes on either supplied store', async () => {
    const s = await stores(); const tx = vi.spyOn(s.store, 'transact');
    const mutations = ['upsertSource', 'beginRun', 'appendRaw', 'appendCandidate', 'appendLineage', 'completeRun', 'failRun'] as const;
    const spies = mutations.map(m => vi.spyOn(s.source, m));
    const result = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', capture: capture() });
    expect(result.report).toMatchObject({ writes: 0, reconciliation: { suppliedTerms: 3, economicsTerms: 3, equal: true } });
    expect(tx).not.toHaveBeenCalled(); for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(result.report)).not.toContain('TEST-FAKE');
  });
  it('commits economics for every term; unresolved fee is null, not zero', async () => {
    const s = await stores(); const p = await apply(s);
    expect(p.result.report).toMatchObject({ status: 'APPLIED', committed: 1 });
    const offer = (await s.store.listOffers())[0]!;
    expect(offer.internalEconomicsTerms).toHaveLength(offer.priceTerms.length);
    const unknown = offer.internalEconomicsTerms!.flatMap(x => [x.supplierBillingFee, x.channelPayoutFee]).filter(x => x.state === 'UNKNOWN');
    expect(unknown.length).toBeGreaterThan(0); expect(unknown.every(x => x.amount === null)).toBe(true);
  });
  it('replays exact plan without new Canonical revisions, RAW or audit', async () => {
    const s = await stores(); const p = await apply(s);
    const before = { audits: s.store.audits.length, revisions: (await s.store.listRevisionHistory()).length, raws: (await s.source.listRaw(p.plan.runId)).length };
    const again = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true, plan: p.plan, expectedPlanDigest: p.report.planDigest });
    expect(again.report).toMatchObject({ status: 'APPLIED', committed: 0, noChange: 1 });
    expect({ audits: s.store.audits.length, revisions: (await s.store.listRevisionHistory()).length, raws: (await s.source.listRaw(p.plan.runId)).length }).toEqual(before);
  });
  it('reviews subsequent rent and facts changes with exact revisions and immutable history', async () => {
    const s = await stores(); const first = await apply(s);
    const next = await apply(s, later(capture({ '12개월': 606, 배기량: '1,235cc' })));
    expect(next.plan.entries[0]!.action).toBe('CHANGE'); expect(next.result.report).toMatchObject({ status: 'APPLIED' });
    expect((await s.store.listOffers())[0]!.revision).toBe(2);
    expect((await s.store.listVehicleAssets())[0]!.sourceVehicleFacts!.fields.displacementCc!.value).toBe(1235);
    expect((await s.source.listRaw(first.plan.runId))[0]!.payload.values).toEqual(capture().tabs[0]!.values[1]);
  });
  it('a later status change (even HOLD→HOLD with a different asset state) is held, not silently diverged', async () => {
    const s = await stores(); await apply(s, capture({ 차량상태: '상품화중' }));
    const next = await planSharedSheetCanonical(s.store, later(capture({ 차량상태: '계약중' })), 'synthetic-target');
    expect(next.plan.entries[0]).toMatchObject({ action: 'HOLD', reasons: expect.arrayContaining(['STATUS_CHANGE_REQUIRES_REVIEW']) });
  });
  it('HOLDs refinement order violations and preserves missing upstream cells', async () => {
    const c = capture({ 모델: '' }); const n = normalized(c);
    expect(n.record.candidate.issues).toContain('REFINEMENT_ORDER_VIOLATION');
    expect(n.record.candidate.subModel).toBeUndefined(); expect(n.record.candidate.trimName).toBeUndefined();
    const s = await stores(); const p = await apply(s, c);
    expect(p.result.report).toMatchObject({ status: 'PARTIAL_HOLD', held: 1 }); expect(await s.store.listOffers()).toHaveLength(0);
    expect(await s.source.listRaw(p.plan.runId)).toHaveLength(1);
  });
  it.each([{ 최초등록일: '26.02.30' }, { 최초등록일: '25.04' }, { '12개월': '협의' }, { 단기보증: '10~20' }])('HOLDs ambiguous values without guessing', data => {
    expect(normalized(capture(data)).record.status).toBe('REJECTED');
  });
  it('rejects missing tabs, reordered headers and wrong digest; a malformed row is quarantined, not the batch', () => {
    const a = capture(); a.tabs.pop(); expect(() => buildSharedSheetBatch(a)).toThrow();
    const b = capture(); b.tabs[0]!.values[0]!.reverse(); expect(() => buildSharedSheetBatch(b)).toThrow();
    const c = capture(); c.tabs[0]!.values[1]!.pop(); c.tabs[0]!.values.push(row('웰릭스', { 차량번호: 'TEST-FAKE-009' })); c.tabs[0]!.rowCount++;
    c.digest = sharedSheetCaptureDigest(c);
    const rc = prepareRawSourceBatch(buildSharedSheetBatch(c)).rawRecords.map(normalizeSharedSheet);
    expect(rc.map(x => x.record.candidate.issues.includes('ROW_SHAPE_INVALID')).sort()).toEqual([false, true]);
    const d = capture(); d.digest = 'wrong'; expect(() => buildSharedSheetBatch(d)).toThrow();
    const e = capture(); delete e.revision; e.digest = sharedSheetCaptureDigest(e); expect(buildSharedSheetBatch(e).records).toHaveLength(1);
  });
  it('quarantines every row of a duplicate supplier/plate identity and keeps the rest', () => {
    const c = capture(); c.tabs[0]!.values.push(row('웰릭스', { 차량번호: ' test-fake-001 ' }), row('웰릭스', { 차량번호: 'TEST-FAKE-002' }));
    c.tabs[0]!.rowCount += 2; c.digest = sharedSheetCaptureDigest(c);
    const batch = buildSharedSheetBatch(c);
    expect(new Set(batch.records.map(r => r.sourceRecordId)).size).toBe(3);
    const issues = prepareRawSourceBatch(batch).rawRecords.map(normalizeSharedSheet).map(x => x.record.candidate.issues.includes('DUPLICATE_IDENTITY'));
    expect(issues.filter(Boolean)).toHaveLength(2); expect(issues).toHaveLength(3);
  });
  it('stores every sheet status; only 출고가능/즉시출고 are exposed, an unlisted status is held', async () => {
    for (const [status, product, asset] of [['출고가능', 'ACTIVE', 'AVAILABLE'], ['출고불가', 'HOLD', 'RESERVED'], ['상품화중', 'HOLD', 'MAINTENANCE']] as const) {
      const s = await stores();
      const p = await planSharedSheetCanonical(s.store, capture({ 차량상태: status }), 'synthetic-target');
      expect(p.plan.entries[0]).toMatchObject({ action: 'CREATE', create: { decision: { productStatus: product, vehicleAsset: { status: asset } } } });
    }
    const s = await stores();
    for (const unlisted of ['알수없음', 'constructor', '__proto__', 'toString']) {
      const held = await planSharedSheetCanonical(s.store, capture({ 차량상태: unlisted }), 'synthetic-target');
      expect(held.plan.entries[0]!.action).toBe('HOLD');
    }
  });
  it('rejects missing/tampered plans and ownership before intake', async () => {
    const s = await stores(); const begin = vi.spyOn(s.source, 'beginRun');
    await expect(runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true })).rejects.toThrow();
    const p = await planSharedSheetCanonical(s.store, capture(), 'synthetic-target');
    p.plan.entries[0]!.create!.decision.supplierId = 'FAKE-CODE';
    await expect(runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true, plan: p.plan, expectedPlanDigest: stableDigest(p.plan) })).rejects.toThrow('PLAN_STALE');
    const p2 = await planSharedSheetCanonical(s.store, capture(), 'synthetic-target'); await s.store.seed({ catalogWriterOwnership: null });
    await expect(runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true, plan: p2.plan, expectedPlanDigest: p2.report.planDigest })).rejects.toThrow('EXCLUSIVE_WRITER');
    expect(begin).not.toHaveBeenCalled();
  });
  it('HOLDs period shape changes through existing structural review', async () => {
    const s = await stores(); await apply(s);
    const p = await planSharedSheetCanonical(s.store, later(capture({ '36개월': 707 })), 'synthetic-target');
    expect(p.plan.entries[0]!.action).toBe('HOLD');
  });
  it('query returns saved values using reads only', async () => {
    const s = await stores(); await apply(s); const tx = vi.spyOn(s.store, 'transact');
    const result = await queryCanonicalByPlate(s.store, ' test-fake-001 ');
    expect(result.matchedAssets).toBe(1); expect(result.results[0]!.terms).toHaveLength(3);
    expect(result.results[0]!.vehicle.facts!.fields.modelYear!.value).toBe(2026); expect(tx).not.toHaveBeenCalled();
  });
  it('keeps first observation from a previously held RAW row', async () => {
    const s = await stores(); await apply(s, capture({ 세부트림: '' }));
    const next = await apply(s, later(capture()));
    expect(next.result.report).toMatchObject({ status: 'APPLIED' });
    expect((await s.source.listRaw(next.plan.runId))[0]!.firstObservedAt).toBe(time);
    expect((await s.store.listVehicleAssets())[0]!.sourceFirstObservedAt).toBe(time);
  });
  it('keeps RAW observation history through absence and reappearance without deletion', async () => {
    const s = await stores(); await apply(s);
    const empty = later(capture()); empty.tabs[0]!.values.pop(); empty.tabs[0]!.rowCount--;
    await apply(s, empty);
    const c = later(capture()); c.readTime = '2026-10-04T00:30:00.000Z'; c.revision = 'synthetic-revision-3';
    for (const tab of c.tabs) tab.readTime = c.readTime;
    const p = await apply(s, c);
    expect((await s.source.listRaw(p.plan.runId))[0]!.firstObservedAt).toBe(time);
    expect(await s.store.listOffers()).toHaveLength(1);
  });
  it('rejects stale expectedRevision before RAW intake', async () => {
    const s = await stores(); await apply(s);
    const p = await planSharedSheetCanonical(s.store, later(capture({ '12개월': 808 })), 'synthetic-target');
    const offer = (await s.store.listOffers())[0]!; await s.store.seed({ offers: [{ ...offer, revision: offer.revision + 1 }] });
    const begin = vi.spyOn(s.source, 'beginRun');
    await expect(runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
      plan: p.plan, expectedPlanDigest: p.report.planDigest })).rejects.toThrow('PLAN_STALE');
    expect(begin).not.toHaveBeenCalled();
  });
  it('checks planned ownership inside the Canonical transaction', async () => {
    const s = await stores(); const original = s.store.transact.bind(s.store);
    vi.spyOn(s.store, 'transact').mockImplementationOnce(async fn => {
      const ownership = (await s.store.getCatalogWriterOwnership())!;
      await s.store.seed({ catalogWriterOwnership: { ...ownership, revision: 2, mode: 'SHARED_MIGRATION' } });
      return original(fn);
    });
    const result = await apply(s);
    expect(result.result.report).toMatchObject({ status: 'HOLD', reason: 'CANONICAL_COMMAND_REJECTED' });
    expect(await s.store.listOffers()).toHaveLength(0);
  });
  it('resumes a partial commit only with the same immutable plan and receipts', async () => {
    const s = await stores(); const c = capture(); c.tabs[0]!.values.push(row('웰릭스', { 차량번호: 'TEST-FAKE-002' })); c.tabs[0]!.rowCount++;
    const original = s.store.transact.bind(s.store); let calls = 0;
    const spy = vi.spyOn(s.store, 'transact').mockImplementation(async fn => {
      if (++calls === 2) throw new Error('SYNTHETIC_TRANSIENT');
      return original(fn);
    });
    const first = await apply(s, c); expect(first.result.report).toMatchObject({ status: 'HOLD', committed: 1 });
    spy.mockRestore();
    const retry = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
      plan: first.plan, expectedPlanDigest: first.report.planDigest });
    expect(retry.report).toMatchObject({ status: 'APPLIED', committed: 1, noChange: 1,
      reconciliation: { stage: 'CANONICAL_READBACK', suppliedTerms: 6, storedTerms: 6, equal: true } });
    expect(await s.store.listOffers()).toHaveLength(2);
  });
  it('HOLDs explicit identity review labels without inferring a downstream trim', () => {
    const c = normalized(capture({ 세부모델: '확인 필요' })).record.candidate;
    expect(c.issues).toContain('VEHICLE_IDENTITY_REVIEW_REQUIRED'); expect(c.trimName).toBeUndefined();
  });
  it('extracts only an explicit transmission phrase', () => {
    expect(normalized(capture({ '옵션 원문': '변속기: DCT; 합성 시험' })).record.candidate.vehicleFacts!.fields.transmission!.value).toBe('DCT');
    expect(normalized(capture({ '옵션 원문': '고급 자동 옵션' })).record.candidate.vehicleFacts!.fields.transmission!.value).toBeNull();
  });
  it('preserves tab-specific read times and rejects capture skew', () => {
    const c = capture(); c.tabs[0]!.readTime = '2026-10-04T00:01:00.000Z';
    expect(buildSharedSheetBatch(c).records[0]!.payload.readTime).toBe(c.tabs[0]!.readTime);
    c.tabs[0]!.readTime = '2026-10-04T01:01:00.000Z'; expect(() => buildSharedSheetBatch(c)).toThrow();
  });
  it('does not silently retain a previously known fact after source removal', async () => {
    const s = await stores(); await apply(s);
    const p = await planSharedSheetCanonical(s.store, later(capture({ 연료: '' })), 'synthetic-target');
    expect(p.plan.entries[0]!.reasons).toContain('MISSING_PREVIOUSLY_KNOWN_FACT_REQUIRES_REVIEW');
    expect(p.plan.entries[0]!.action).toBe('HOLD');
  });
  it('does not create a duplicate supplier/plate through a second source', async () => {
    const s = await stores(); await apply(s);
    const c = capture(); c.spreadsheetId = 'synthetic-other-sheet';
    const p = await planSharedSheetCanonical(s.store, c, 'synthetic-target');
    expect(p.plan.entries[0]!.reasons).toContain('EXISTING_IDENTITY_REQUIRES_SOURCE_LINK');
    expect(p.plan.entries[0]!.action).toBe('HOLD');
  });
});

describe('shared sheet apply/output guards (Codex review)', () => {
  it('preflight rejects an apply without a reviewed plan before any store call', async () => {
    const store = new MemoryDataStore();
    const spy = vi.spyOn(store, 'getCatalogWriterOwnership');
    await expect(preflightSharedSheetApply(store, undefined, undefined, 'memory')).rejects.toThrow('SHARED_SHEET_PLAN_REQUIRED_OR_CHANGED');
    expect(spy).not.toHaveBeenCalled();
  });
  it('private output refuses this repository even when cwd is elsewhere, and accepts a temp dir', async () => {
    const cwd = process.cwd();
    const outside = await mkdtemp(join(tmpdir(), 'fp-private-'));
    try {
      process.chdir(outside);
      await expect(writePrivateArtifact(resolve(cwd, 'plan-leak.json'), {})).rejects.toThrow('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT');
      await expect(writePrivateArtifact(resolve(cwd, 'src', 'plan-leak.json'), {})).rejects.toThrow('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT');
      await expect(writePrivateArtifact(join(outside, 'plan.json'), { ok: true })).resolves.toBeUndefined();
    } finally { process.chdir(cwd); }
  });
});

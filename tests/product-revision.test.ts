import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertProductRevisionActor, buildProductRevision, productRevisionId, productRevisionModeOf, revisionValue,
  type ProductRevisionActor, type ProductRevisionInput,
} from '../src/domain/product-revision.js';
import { adminProductRevisionSink, localProductRevisionSink, productRevisionSinkOf, recordProductRevision, restProductRevisionSink } from '../src/infra/product-revision-writer.js';
import { firestoreCycleCommands, encodeFields, decodeFields } from '../src/infra/source-cycle-firestore.js';
import { planSourceCycle, applySourceCycle } from '../src/application/source-cycle.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const tmp = async (prefix: string) => { const d = await mkdtemp(join(tmpdir(), prefix)); dirs.push(d); return d; };

const engine: ProductRevisionActor = { kind: 'ENGINE', id: 'source-cycle', role: 'SERVICE', via: 'source-cycle' };
const input = (over: Partial<ProductRevisionInput> = {}): ProductRevisionInput => ({
  uid: '12가1001', operationId: 'op-1', kind: 'UPDATE', actor: engine, tool: { name: 'source-cycle' }, reason: '합성 변경',
  before: { status: '출고가능', price: { 36: { rent: 500000 } } }, after: { status: '계약중', price: { 36: { rent: 500000 } } },
  at: '2026-10-25T00:00:00.000Z', mode: 'shadow', ...over,
});

describe('product revision 순수 규칙', () => {
  it('mode 는 기본 off, shadow 만 열고 on·오타는 거부한다', () => {
    expect(productRevisionModeOf(undefined)).toBe('off');
    expect(productRevisionModeOf({ PRODUCT_REVISIONS: '' })).toBe('off');
    expect(productRevisionModeOf({ PRODUCT_REVISIONS: 'shadow' })).toBe('shadow');
    expect(() => productRevisionModeOf({ PRODUCT_REVISIONS: 'on' })).toThrow('PRODUCT_REVISIONS_MODE_INVALID');
    expect(() => productRevisionModeOf({ PRODUCT_REVISIONS: 'shdow' })).toThrow('PRODUCT_REVISIONS_MODE_INVALID');
  });

  it('쓰기 주체는 프리패스 직원·서비스뿐 — 영업자·공급사 역할은 거부, 요청 출처는 onBehalfOf 로만', () => {
    expect(() => assertProductRevisionActor({ kind: 'STAFF', id: 'u1', role: 'FREEPASS_STAFF', via: 'admin-sheet' })).not.toThrow();
    expect(() => assertProductRevisionActor({ kind: 'STAFF', id: 'u1', role: 'FREEPASS_ADMIN', via: 'admin-sheet', onBehalfOf: { kind: 'SUPPLIER', id: 'RP012' } })).not.toThrow();
    expect(() => assertProductRevisionActor({ kind: 'STAFF', id: 'u1', role: 'SALES' as never, via: 'admin-sheet' })).toThrow('ACTOR_ROLE_NOT_WRITER');
    expect(() => assertProductRevisionActor({ kind: 'STAFF', id: 'u1', role: 'SUPPLIER' as never, via: 'admin-sheet' })).toThrow('ACTOR_ROLE_NOT_WRITER');
    expect(() => assertProductRevisionActor({ kind: 'STAFF', id: 'u1', role: 'SERVICE', via: 'admin-sheet' })).toThrow('ACTOR_ROLE_NOT_WRITER');
    expect(() => assertProductRevisionActor({ kind: 'ENGINE', id: 'e', role: 'FREEPASS_STAFF', via: 'x' })).toThrow('ACTOR_ROLE_NOT_WRITER');
    expect(() => assertProductRevisionActor({ kind: 'SALES' as never, id: 'a', role: 'SERVICE', via: 'x' })).toThrow('ACTOR_INVALID');
    expect(() => assertProductRevisionActor({ ...engine, onBehalfOf: { kind: 'CUSTOMER' as never, id: 'x' } })).toThrow('ACTOR_ON_BEHALF_INVALID');
  });

  it('revId 는 uid+operationId 로만 정해진다(재시도 멱등), 바뀐 칸만 changes 에 남는다', () => {
    const a = buildProductRevision(input()), b = buildProductRevision(input({ at: '2026-10-26T00:00:00.000Z' }));
    expect(a.revId).toBe(productRevisionId('12가1001', 'op-1'));
    expect(b.revId).toBe(a.revId);
    expect(b.inputDigest).toBe(a.inputDigest);          // 기록 시각은 digest 에 들어가지 않는다
    expect(a.changes).toEqual([{ path: 'status', before: '출고가능', after: '계약중', beforePresent: true, afterPresent: true }]);
    expect(a.official).toBe(false);
    expect(buildProductRevision(input({ operationId: 'op-2' })).revId).not.toBe(a.revId);
  });

  it('새 문서·없던 칸은 beforePresent=false 로 구분한다(null 과 «없음»을 섞지 않는다)', () => {
    const created = buildProductRevision(input({ before: null, kind: 'CREATE' }));
    expect(created.changes.every(c => !c.beforePresent)).toBe(true);
    const nulled = buildProductRevision(input({ before: { status: null }, after: { status: null } }));
    expect(nulled.changes).toEqual([]);
  });

  it('전체 교체(롤백)는 사라진 칸을 afterPresent=false 로 남기고 전후 digest 가 달라진다(Codex #6 P2)', () => {
    const partial = buildProductRevision(input({ before: { status: 'ok', added: 123 }, after: { status: 'ok' } }));
    expect(partial.changes).toEqual([]);                         // 부분 갱신: 쓴 칸만 본다
    const replaced = buildProductRevision(input({ kind: 'ROLLBACK', replace: true, before: { status: 'ok', added: 123 }, after: { status: 'ok' } }));
    expect(replaced.changes).toEqual([{ path: 'added', before: 123, after: null, beforePresent: true, afterPresent: false }]);
    expect(replaced.beforeDigest).not.toBe(replaced.afterDigest);
  });

  it('같은 작업 id 라도 작성자·근거가 다르면 다른 기록(충돌), 재시도마다 바뀌는 칸(at·runId·host)은 같은 기록(Codex #6 P2)', async () => {
    const dir = await tmp('rev-meaning-'), sink = localProductRevisionSink(dir);
    expect(await sink.create(buildProductRevision(input({ tool: { name: 'source-cycle', runId: 'r1' }, actor: { ...engine, host: 'PC3' } })))).toBe('CREATED');
    expect(await sink.create(buildProductRevision(input({ tool: { name: 'source-cycle', runId: 'r2' }, actor: { ...engine, host: 'PC1' }, at: '2026-10-27T00:00:00.000Z' })))).toBe('ALREADY_RECORDED');
    await expect(sink.create(buildProductRevision(input({ actor: { kind: 'STAFF', id: 'u9', role: 'FREEPASS_STAFF', via: 'admin-sheet' } })))).rejects.toThrow('REVISION_CONFLICT');
    await expect(sink.create(buildProductRevision(input({ reason: '다른 근거' })))).rejects.toThrow('REVISION_CONFLICT');
  });

  it('Admin SDK 특수값(FieldValue·Timestamp)은 이름·시각만 남기고 값을 지어내지 않는다', () => {
    class ServerTimestampTransform {}
    expect(revisionValue(new ServerTimestampTransform())).toEqual({ $sentinel: 'ServerTimestampTransform' });
    class Timestamp { toDate() { return new Date('2026-10-25T01:02:03.000Z'); } }
    expect(revisionValue(new Timestamp())).toEqual({ $timestamp: '2026-10-25T01:02:03.000Z' });
    expect(revisionValue({ a: undefined, b: [1, NaN] })).toEqual({ b: [1, { $unserializable: 'NUMBER' }] });
  });

  it('필수 근거가 없거나 리비전이 1MiB 에 가까우면 만들지 않는다', () => {
    expect(() => buildProductRevision(input({ operationId: '' }))).toThrow('REVISION_OPERATION_ID_REQUIRED');
    expect(() => buildProductRevision(input({ reason: ' ' }))).toThrow('REVISION_REASON_REQUIRED');
    expect(() => buildProductRevision(input({ uid: 'a/b' }))).toThrow('REVISION_UID_INVALID');
    expect(() => buildProductRevision(input({ after: { big: 'x'.repeat(950_000) } }))).toThrow('REVISION_TOO_LARGE');
  });
});

describe('기록소(sink)와 공용 기록 함수', () => {
  it('로컬 기록은 한 번만 만들고, 같은 입력 재시도는 ALREADY_RECORDED, 다른 입력이면 충돌', async () => {
    const dir = await tmp('rev-local-'), sink = localProductRevisionSink(dir);
    const r = buildProductRevision(input());
    expect(await sink.create(r)).toBe('CREATED');
    expect(await sink.create(r)).toBe('ALREADY_RECORDED');
    await expect(sink.create({ ...r, inputDigest: 'other' })).rejects.toThrow('REVISION_CONFLICT');
  });

  it('off 는 입력을 만들지도 않고, shadow 에서 입력 생성(작성자·호스트 조회)이 실패해도 던지지 않는다(Codex #6 P1)', async () => {
    let called = 0;
    const throwing = () => { called++; throw new Error('HOSTNAME_FAILED'); };
    expect(await recordProductRevision('off', { kind: 'local', create: async () => 'CREATED' }, throwing)).toEqual({ status: 'OFF' });
    expect(called).toBe(0);
    expect(await recordProductRevision('shadow', { kind: 'local', create: async () => 'CREATED' }, throwing)).toEqual({ status: 'SHADOW_FAILED', error: 'HOSTNAME_FAILED' });
    expect(await recordProductRevision('shadow', () => { throw new Error('SINK_INIT'); }, input())).toEqual({ status: 'SHADOW_FAILED', error: 'SINK_INIT' });
  });

  it('off 는 아무것도 하지 않고, shadow 실패는 던지지 않고 결과로만 알린다', async () => {
    const dir = await tmp('rev-off-');
    expect(await recordProductRevision('off', localProductRevisionSink(dir), input())).toEqual({ status: 'OFF' });
    expect(await readdir(dir)).toEqual([]);
    const broken = { kind: 'local' as const, create: async () => { throw new Error('DISK_FULL'); } };
    expect(await recordProductRevision('shadow', broken, input())).toEqual({ status: 'SHADOW_FAILED', error: 'DISK_FULL' });
    expect(await recordProductRevision('shadow', localProductRevisionSink(dir), input({ actor: { ...engine, role: 'SALES' as never } })))
      .toEqual({ status: 'SHADOW_FAILED', error: 'ACTOR_ROLE_NOT_WRITER' });
  });

  it('기록소 기본값은 로컬(shadow 를 켜도 운영 DB 쓰기 0), firestore 는 명시할 때만', () => {
    const local = { kind: 'local' as const, create: async () => 'CREATED' as const };
    const remote = { kind: 'rest' as const, create: async () => 'CREATED' as const };
    expect(productRevisionSinkOf({}, { local: () => local, firestore: () => remote })).toBe(local);
    expect(productRevisionSinkOf({ PRODUCT_REVISIONS_SINK: 'firestore' }, { local: () => local, firestore: () => remote })).toBe(remote);
    expect(() => productRevisionSinkOf({ PRODUCT_REVISIONS_SINK: 'bigquery' }, { local: () => local })).toThrow('PRODUCT_REVISIONS_SINK_INVALID');
  });

  it('REST 기록소: exists=false 로 만들고, 이미 있으면 같은 입력일 때만 멱등 성공', async () => {
    const store = new Map<string, any>(); const calls: string[] = [];
    const request = async (path: string, method = 'GET', body?: any) => {
      calls.push(`${method} ${path}`);
      const id = decodeURIComponent(path.split('?')[0]!.split('/').at(-1)!);
      if (method === 'GET') return store.get(id) ?? null;
      if (store.has(id)) throw new Error('CAS_CONFLICT');
      store.set(id, { fields: body.fields }); return {};
    };
    const sink = restProductRevisionSink({ request, encodeFields: v => encodeFields(v as never), decodeFields: f => decodeFields(f as never) });
    const r = buildProductRevision(input());
    expect(await sink.create(r)).toBe('CREATED');
    expect(calls[0]).toBe(`PATCH /product_revisions/${r.revId}?currentDocument.exists=false`);
    expect(await sink.create(r)).toBe('ALREADY_RECORDED');
    await expect(sink.create({ ...r, inputDigest: 'other' })).rejects.toThrow('REVISION_CONFLICT');
  });

  it('Admin 기록소: ALREADY_EXISTS 면 같은 입력인지 대조', async () => {
    const store = new Map<string, unknown>();
    const db = { collection: () => ({ doc: (id: string) => ({
      create: async (data: unknown) => { if (store.has(id)) throw Object.assign(new Error('exists'), { code: 6 }); store.set(id, data); },
      get: async () => ({ exists: store.has(id), data: () => store.get(id) }),
    }) }) };
    const sink = adminProductRevisionSink(db), r = buildProductRevision(input());
    expect(await sink.create(r)).toBe('CREATED');
    expect(await sink.create(r)).toBe('ALREADY_RECORDED');
    await expect(sink.create({ ...r, inputDigest: 'x' })).rejects.toThrow('REVISION_CONFLICT');
  });
});

// 엔진 연결: shadow 는 상품 쓰기·되읽기가 끝난 뒤 로컬에 리비전을 남기고, 운영 Firestore 에는 product_revisions 쓰기가 없다.
const time = '2026-10-14T11:00:00.000Z', now = Date.parse('2026-10-14T11:05:00.000Z'), source = 'RP012';
const rec = (plate: string, raw: string, observedAt = time): SourceProductRecord => ({ sourceId: source, uid: plate, plate, vehicleText: '합성 차명',
  status: { raw, saleAvailable: true }, observedAt, vehicleHold: [], raw: { source: 'sonogong-partner-api', product_type: '중고렌트', product_group: 'LONG_TERM' },
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'UNKNOWN', value: null }, mileage: null, raw: { priceType: 'BUYOUT' } }] });
function fakeFirestore() {
  const docs = new Map<string, any>(), writes: string[] = []; let version = 0;
  const doc = (uid: string, fields: any) => ({ name: `projects/synthetic-test/databases/(default)/documents/products/${uid}`, updateTime: `${time}:${++version}`, fields });
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), uid = decodeURIComponent(url.pathname.split('/').at(-1)!);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (!init.method || init.method === 'GET') {
      let result: any = uid === 'products' ? { documents: [...docs.values()] } : docs.get(uid);
      if (!result) return new Response('{}', { status: 404 });
      result = structuredClone(result);
      const masked = url.searchParams.getAll('mask.fieldPaths').map(p => p.replace(/`/g, ''));
      if (uid === 'products' && masked.length) for (const d of result.documents) d.fields = Object.fromEntries(Object.entries(d.fields ?? {}).filter(([k]) => masked.includes(k)));
      return Response.json(result);
    }
    writes.push(url.pathname);
    const current = docs.get(uid);
    if (url.searchParams.get('currentDocument.exists') === 'false' ? !!current : current?.updateTime !== url.searchParams.get('currentDocument.updateTime')) return new Response('{}', { status: 412 });
    const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
    const after = doc(uid, fields); docs.set(uid, after); return Response.json(after);
  }) as unknown as typeof fetch;
  return { docs, writes, fetcher };
}
async function engineRun(env: Record<string, string>) {
  const dir = await tmp('rev-engine-'), fake = fakeFirestore();
  const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test', ...env }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
    supplierDefaults: { RP012: { provider_name: '합성손오공', policy_code: 'SYNTHETIC_POLICY' } } });
  const run = async (records: SourceProductRecord[], at = now) => {
    const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records, observedAt: records[0]!.observedAt, heldCount: 0, complete: true }, await commands.list(source), at);
    return applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now: at });
  };
  return { dir, fake, commands, run };
}

describe('엔진 shadow 연결', () => {
  it('off(기본)면 리비전을 남기지 않는다 — 기존 동작 그대로', async () => {
    const e = await engineRun({});
    expect(await e.run([rec('12가1001', '출고가능')])).toMatchObject({ status: 'APPLIED', verified: 1 });
    expect((await readdir(e.dir)).includes('revisions')).toBe(false);
    expect(e.commands.revisionResults()).toEqual([{ status: 'OFF' }]);
  });

  it('shadow 면 편입·갱신마다 로컬 리비전 1건, 운영 DB 에는 상품 쓰기만 있다', async () => {
    const e = await engineRun({ PRODUCT_REVISIONS: 'shadow' });
    expect(await e.run([rec('12가1001', '계약중'), rec('12가1002', '출고가능')])).toMatchObject({ status: 'APPLIED', verified: 2 });
    const later = '2026-10-14T12:00:00.000Z';
    expect(await e.run([rec('12가1001', '출고가능', later), rec('12가1002', '출고가능', later)], Date.parse('2026-10-14T12:05:00.000Z'))).toMatchObject({ status: 'APPLIED', verified: 1 });
    const files = await readdir(join(e.dir, 'revisions'));
    expect(files).toHaveLength(3);
    const revs = await Promise.all(files.map(async f => JSON.parse(await readFile(join(e.dir, 'revisions', f), 'utf8'))));
    expect(revs.map(r => r.kind).sort()).toEqual(['CREATE', 'CREATE', 'UPDATE']);
    const update = revs.find(r => r.kind === 'UPDATE');
    expect(update).toMatchObject({ uid: '12가1001', official: false, actor: { kind: 'ENGINE', role: 'SERVICE' }, schema: 'product-revision/v1' });
    expect(update.changes.find((c: any) => c.path === 'status')).toMatchObject({ before: '계약중', after: '출고가능', beforePresent: true });
    expect(update.committedUpdateTime).toBe(e.fake.docs.get('12가1001').updateTime);
    expect(e.fake.writes.every(p => p.includes('/documents/products/'))).toBe(true);
    expect(e.commands.revisionResults().map(r => r.status)).toEqual(['CREATED', 'CREATED', 'CREATED']);
  });
});

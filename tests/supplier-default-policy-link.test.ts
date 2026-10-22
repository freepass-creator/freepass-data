import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSourceCycle, applySourceCycle, type CycleProduct } from '../src/application/source-cycle.js';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
import { SUPPLIER_POLICY_LINK_RULES, policyLinkCodeFor, policyLinkReason } from '../src/domain/supplier-default-policy-link.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';

// 공급사 기본 정책 연결 규칙(대표 2026-10-22). 모든 값은 합성이다.
const cycleTime = '2026-10-22T03:00:00.000Z', cycleNow = Date.parse('2026-10-22T03:02:00.000Z');

describe('policyLinkCodeFor (pure rule)', () => {
  it('links only an EMPTY policy of a rule-table supplier; a car-row value always wins', () => {
    expect(policyLinkCodeFor('RP004', null)).toBe('RP004_P01');
    expect(policyLinkCodeFor('RP004', undefined)).toBe('RP004_P01');
    expect(policyLinkCodeFor('RP004', '')).toBe('RP004_P01');
    expect(policyLinkCodeFor(' RP004 ', '   ')).toBe('RP004_P01');
    // 차 줄 값 우선: 이미 정책이 있으면(다른 코드든 같은 코드든) 건드리지 않는다
    expect(policyLinkCodeFor('RP004', 'RP004_P02')).toBeNull();
    expect(policyLinkCodeFor('RP004', 'RP004_P01')).toBeNull();
    // 모르는 모양(숫자·객체)은 건드리지 않는다
    expect(policyLinkCodeFor('RP004', 0)).toBeNull();
    expect(policyLinkCodeFor('RP004', {})).toBeNull();
  });
  it('does not link suppliers outside the table (ambiguous or dedicated-job suppliers)', () => {
    for (const provider of ['RP031', 'RP012', 'RP015', 'PT-0001', 'RP006', 'RP023', '', null, undefined, 4]) expect(policyLinkCodeFor(provider, null)).toBeNull();
    expect(SUPPLIER_POLICY_LINK_RULES.map(r => r.provider)).toEqual(['RP004']);
    expect(policyLinkReason('RP004_P01')).toContain('RP004_P01');
    expect(policyLinkReason('NOPE')).toBe('');
  });
});

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
function fakeFirestore(initial: Array<{ id: string; fields: Record<string, unknown>; updateTime: string }>) {
  const docs = new Map<string, any>(); let clock = Date.parse('2026-10-22T02:30:00.000Z');
  const name = (uid: string) => `projects/synthetic-test/databases/(default)/documents/products/${uid}`;
  for (const d of initial) docs.set(d.id, { name: name(d.id), updateTime: d.updateTime, fields: encodeFields(d.fields as never) });
  const masked = (fields: Record<string, any>, paths: string[]) => {
    const out: Record<string, any> = {};
    for (const path of paths) {
      const [head, ...rest] = path.replace(/`/g, '').split('.');
      if (!(head! in fields)) continue;
      if (!rest.length) { out[head!] = fields[head!]; continue; }
      const inner = fields[head!]?.mapValue?.fields?.[rest[0]!];
      if (inner !== undefined) out[head!] = { mapValue: { fields: { ...(out[head!]?.mapValue?.fields ?? {}), [rest[0]!]: inner } } };
    }
    return out;
  };
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), uid = decodeURIComponent(url.pathname.split('/').at(-1)!);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (!init.method || init.method === 'GET') {
      let result: any = uid === 'products' ? { documents: [...docs.values()] } : docs.get(uid);
      if (!result) return new Response('{}', { status: 404 });
      result = structuredClone(result);
      const paths = url.searchParams.getAll('mask.fieldPaths');
      if (uid === 'products' && paths.length) for (const d of result.documents) d.fields = masked(d.fields ?? {}, paths);
      return Response.json(result);
    }
    const current = docs.get(uid);
    if (url.searchParams.get('currentDocument.exists') === 'false' ? !!current : current?.updateTime !== url.searchParams.get('currentDocument.updateTime')) return new Response('{}', { status: 412 });
    const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
    const after = { name: name(uid), updateTime: new Date(clock += 1000).toISOString(), fields }; docs.set(uid, after); return Response.json(after);
  }) as unknown as typeof fetch;
  return { docs, fetcher };
}
async function setup(initial: Parameters<typeof fakeFirestore>[0]) {
  const dir = await mkdtemp(join(tmpdir(), 'policy-link-')); dirs.push(dir);
  const fake = fakeFirestore(initial);
  const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
    supplierDefaults: { RP004: { provider_name: '합성아이카', policy_code: null }, RP012: { provider_name: '합성손오공', policy_code: null } } });
  return { commands, fake };
}
const record = (sourceId: string, plate: string): SourceProductRecord => ({ sourceId, uid: plate, plate, vehicleText: '합성', status: { raw: '출고협의', saleAvailable: true },
  observedAt: cycleTime, raw: {}, vehicleHold: [],
  terms: [{ months: 24, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'KNOWN', value: 700000 }, mileage: '20000km/year', raw: {} }] });
const engineDoc = (sourceId: string, plate: string, extra: Record<string, unknown> = {}) => {
  const before: CycleProduct = { record: record(sourceId, plate), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null };
  return { ...nativeCycleFields(before), provider_name: sourceId === 'RP004' ? '합성아이카' : '합성손오공', ...extra };
};
const cycle = async (commands: Awaited<ReturnType<typeof setup>>['commands'], sourceId: string, records: SourceProductRecord[]) => {
  const built = planSourceCycle({ sourceId, family: 'OTHER', maxDowngradeRatio: 1 }, { records, observedAt: cycleTime, heldCount: 0, complete: true },
    await commands.list(sourceId), cycleNow);
  return { built, applied: await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now: cycleNow }) };
};
const t = '2026-10-22T02:00:00.000Z';

describe('POLICY_LINK through the engine (plan, write, readback)', () => {
  it('links an empty-policy listed engine document once; keeps a car-row policy; leaves other suppliers alone', async () => {
    const { commands, fake } = await setup([
      { id: '10가1001', fields: engineDoc('RP004', '10가1001'), updateTime: t },                                                      // 정책 없음 → 연결
      { id: '10가1002', fields: engineDoc('RP004', '10가1002', { policy_code: 'RP004_P02' }), updateTime: t },                      // 차 줄 값 → 유지
      { id: '10가1003', fields: engineDoc('RP004', '10가1003', { policy_code: '' }), updateTime: t },                               // 빈 문자열 → 연결
    ]);
    const listed = (await commands.list('RP004')).products;
    const by = Object.fromEntries(listed.map(p => [p.record.uid, p]));
    expect(by['10가1001']!.rewriteReasons).toEqual(['POLICY_LINK']);
    expect(by['10가1001']!.policyLinkCode).toBe('RP004_P01');
    expect(by['10가1002']!.rewriteReasons).toBeUndefined();
    expect(by['10가1002']!.policyLinkCode).toBeUndefined();
    expect(by['10가1003']!.policyLinkCode).toBe('RP004_P01');
    const first = await cycle(commands, 'RP004', ['10가1001', '10가1002', '10가1003'].map(p => record('RP004', p)));
    expect(first.built.plan.entries.map(e => [e.kind, e.after.record.uid]).sort()).toEqual([['UPDATE', '10가1001'], ['UPDATE', '10가1003']]);
    expect(first.applied, JSON.stringify((first.applied as any).uncertainDetail ?? first.applied)).toMatchObject({ status: 'APPLIED', verified: 2 });
    const stored = (id: string) => decodeFields(fake.docs.get(id).fields);
    expect(stored('10가1001')).toMatchObject({ policy_code: 'RP004_P01' });
    expect(String(stored('10가1001').policy_code_linked_reason)).toContain('RP004_P01');
    expect(stored('10가1003').policy_code).toBe('RP004_P01');
    expect(stored('10가1002').policy_code).toBe('RP004_P02');               // 차 줄 값 불변
    expect(stored('10가1002').policy_code_linked_reason).toBeUndefined();
    // 되풀이 없음
    expect((await cycle(commands, 'RP004', ['10가1001', '10가1002', '10가1003'].map(p => record('RP004', p)))).built.plan.entries).toEqual([]);
  });
  it('never links outside the rule table, unlisted documents, contract-locked documents or documents without an engine record', async () => {
    const { commands } = await setup([
      { id: '20가2001', fields: engineDoc('RP012', '20가2001'), updateTime: t },                                                      // 표에 없는 공급사
      { id: '10가2002', fields: engineDoc('RP004', '10가2002', { listable: false }), updateTime: t },                              // 비노출
      { id: '10가2003', fields: engineDoc('RP004', '10가2003', { locked_by_contract: '계약' }), updateTime: t },                     // 계약 잠금
      { id: '10가2004', fields: (() => { const f: Record<string, unknown> = engineDoc('RP004', '10가2004'); delete f.source_cycle_record; return f; })(), updateTime: t },  // 엔진 기록 없음
    ]);
    expect((await commands.list('RP012')).products.every(p => p.policyLinkCode === undefined && !p.rewriteReasons?.includes('POLICY_LINK'))).toBe(true);
    const rp004 = await commands.list('RP004');
    expect(rp004.products.some(p => p.policyLinkCode !== undefined)).toBe(false);
    expect(rp004.products.every(p => !p.rewriteReasons?.includes('POLICY_LINK'))).toBe(true);
  });
  it('writes the code only while the stored policy is still empty (write-time recheck), and drops it for a downgrade', async () => {
    const planned: CycleProduct = { record: record('RP004', '10가3001'), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null, policyLinkCode: 'RP004_P01' };
    expect(nativeCycleFields(planned, { policy_code: '' })).toMatchObject({ policy_code: 'RP004_P01' });
    expect(nativeCycleFields(planned, {})).toMatchObject({ policy_code: 'RP004_P01' });
    // 계획 뒤 누가 정책을 채웠다 → 쓰지 않는다(차 줄 값 우선)
    expect('policy_code' in nativeCycleFields(planned, { policy_code: 'RP004_P02' })).toBe(false);
    // 코드가 규칙 표와 어긋나면(다른 공급사에 붙은 코드) 쓰지 않는다
    expect('policy_code' in nativeCycleFields({ ...planned, record: record('RP012', '20가3002') }, {})).toBe(false);
    expect('policy_code' in nativeCycleFields({ ...planned, policyLinkCode: 'POL-0020' }, {})).toBe(false);
    // 원천에서 사라져 내려가는 항목에는 정책을 새로 붙이지 않는다
    const { commands } = await setup([{ id: '10가3003', fields: engineDoc('RP004', '10가3003'), updateTime: t }]);
    const built = planSourceCycle({ sourceId: 'RP004', family: 'OTHER', maxDowngradeRatio: 1 }, { records: [record('RP004', '10가9999')], observedAt: cycleTime, heldCount: 0, complete: true },
      await commands.list('RP004'), cycleNow);
    const down = built.plan.entries.find(e => e.kind === 'DOWNGRADE');
    expect(down).toBeDefined();
    expect(down!.after.policyLinkCode).toBeUndefined();
  });
  it('links a document without a supplier name and with a whitespace policy; skips a monthly-rent model row even when the stored product group is empty', async () => {
    const noName: Record<string, unknown> = engineDoc('RP004', '10가4001', { policy_code: '   ' }); delete noName.provider_name;
    const { commands, fake } = await setup([
      { id: '10가4001', fields: noName, updateTime: t },
      { id: '10가4002', fields: engineDoc('RP004', '10가4002'), updateTime: t },
    ]);
    const monthly = { ...record('RP004', '10가4002'), raw: { product_group: 'MONTHLY_RENT' } };
    const run = await cycle(commands, 'RP004', [record('RP004', '10가4001'), monthly]);
    expect(run.built.plan.entries.map(e => [e.after.record.uid, e.after.policyLinkCode])).toContainEqual(['10가4001', 'RP004_P01']);
    expect(run.built.plan.entries.find(e => e.after.record.uid === '10가4002')?.after.policyLinkCode).toBeUndefined();
    expect(run.applied, JSON.stringify((run.applied as any).uncertainDetail ?? '')).toMatchObject({ status: 'APPLIED' });
    expect(decodeFields(fake.docs.get('10가4001').fields).policy_code).toBe('RP004_P01');
    expect(decodeFields(fake.docs.get('10가4002').fields).policy_code ?? null).toBeNull();
    expect('policy_code' in nativeCycleFields({ record: monthly, listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null, policyLinkCode: 'RP004_P01' }, {})).toBe(false);
  });
});

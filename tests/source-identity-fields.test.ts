import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields, sourceIdentityFields, sourceSpecFillFields, engineIdentityHold } from '../src/infra/source-cycle-firestore.js';
import { planSourceCycle, applySourceCycle, OPTIONS_REWRITE_CAP } from '../src/application/source-cycle.js';
import { compactRaw, compactRecord, type SourceProductRecord } from '../src/domain/source-engine.js';
import type { VehicleIdentityRefiner } from '../src/ports/source-cycle.js';
import { identityProductsFromPlainDocs } from '../src/adapters/identity-snapshot.js';

// 입구 매핑(대표 2026-10-16): 손오공 brand·model → 빈 maker·model 에만. 기본 꺼짐, 공급사별 허용. 값은 전부 합성.
const time = '2026-10-16T05:00:00.000Z', now = Date.parse('2026-10-16T05:05:00.000Z'), source = 'RP012';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const rec = (plate: string, brand: string | null = '현대', model: string | null = '아반떼', rent = 500000): SourceProductRecord => ({ sourceId: source, uid: plate, plate,
  vehicleText: `${brand ?? ''}_${model ?? ''}_가솔린 1.6`, status: { raw: '출고가능', saleAvailable: true }, observedAt: time, vehicleHold: [],
  raw: { source: 'sonogong-partner-api', product_type: '중고렌트', ...(brand ? { source_maker: brand } : {}), ...(model ? { source_model: model } : {}) },
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: rent }, deposit: { state: 'ZERO', value: 0 }, mileage: null, raw: { priceType: 'RENT_RETURN' } }] });

function fakeFirestore() {
  const docs = new Map<string, any>(); let version = 0;
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
    const current = docs.get(uid);
    if (url.searchParams.get('currentDocument.exists') === 'false' ? !!current : current?.updateTime !== url.searchParams.get('currentDocument.updateTime')) return new Response('{}', { status: 409 });
    const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
    const after = doc(uid, fields); docs.set(uid, after); return Response.json(after);
  }) as unknown as typeof fetch;
  return { docs, fetcher, put: (uid: string, f: Record<string, unknown>) => docs.set(uid, doc(uid, encodeFields(f as never))) };
}
const knownMakers: VehicleIdentityRefiner = { digest: 't', match: () => null, makers: ['현대', '기아'] };
async function setup(sourceIdentitySources: string[] = ['RP012'], identity: VehicleIdentityRefiner | undefined = knownMakers) {
  const dir = await mkdtemp(join(tmpdir(), 'source-identity-')); dirs.push(dir);
  const fake = fakeFirestore();
  const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
    supplierDefaults: { RP012: { provider_name: '합성손오공', policy_code: 'SYNTHETIC_POLICY' } }, sourceIdentitySources,
    identity: async () => identity });
  return { commands, fake };
}
const run = async (commands: Awaited<ReturnType<typeof setup>>['commands'], records: SourceProductRecord[]) => {
  const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records, observedAt: time, heldCount: 0, complete: true },
    await commands.list(source), now);
  const applied = built.plan.entries.length ? await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now }) : null;
  return { kinds: built.plan.entries.map(e => e.kind), warnings: built.plan.warnings, applied };
};
/** 이번 변경 전에 쓰인 엔진 문서: 제조사·모델 빈칸, 세부모델=원문 차명, 검토 필요, 저장 기록에는 source_maker·source_model 없음. */
const legacyDoc = (r: SourceProductRecord, extra: Record<string, unknown> = {}) => {
  const old = { ...r, raw: Object.fromEntries(Object.entries(r.raw).filter(([k]) => k !== 'source_maker' && k !== 'source_model')) } as SourceProductRecord;
  const fields = nativeCycleFields({ record: compactRecord(old), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null },
    { car_number: r.plate, provider_company_code: source, provider_name: '합성손오공' });
  return { provider_name: '합성손오공', ...fields, maker: '', model: '', sub_model: r.vehicleText, trim_name: '', vehicle_review_required: true,
    vehicle_title_source: 'RAW_VEHICLE_TEXT', 원문: { 차명: r.vehicleText }, source_cycle_record: { ...compactRecord(old), raw: compactRaw(old.raw) }, ...extra };
};

describe('sourceIdentityFields(순수)', () => {
  it('빈 제조사·모델에만 원천 값을 채우고 표식을 남긴다; 기존 값·마스터 확정·표식 있는 문서는 건드리지 않는다', () => {
    const makers = new Set(['현대', '기아']);
    expect(sourceIdentityFields(rec('12가1'), {}, false, makers)).toEqual({ maker: '현대', model: '아반떼', vehicle_maker_model_source: 'SOURCE_FIELDS', vehicle_maker_model_filled: { maker: '현대', model: '아반떼' } });
    // Codex #685 (c): 마스터에 없는 제조사 표기(옛 표기)·마스터 미로드는 채우지 않고 표식만
    expect(sourceIdentityFields(rec('12가1', '르노삼성', 'QM6'), {}, false, makers)).toEqual({ vehicle_maker_model_source: 'UNMAPPED' });
    expect(sourceIdentityFields(rec('12가1'), {}, false, null)).toEqual({ vehicle_maker_model_source: 'UNMAPPED' });
    expect(sourceIdentityFields(rec('12가1'), { maker: '기아' }, false, makers)).toEqual({});
    expect(sourceIdentityFields(rec('12가1'), { model: 'K5' }, false, makers)).toEqual({});
    expect(sourceIdentityFields(rec('12가1'), {}, true, makers)).toEqual({});   // 이번 회차 마스터 확정이 이긴다
    expect(sourceIdentityFields(rec('12가1', null, null), {}, false, makers)).toEqual({ vehicle_maker_model_source: 'ABSENT' });
    expect(sourceIdentityFields(rec('12가1'), { vehicle_maker_model_source: 'ABSENT' }, false, makers)).toEqual({});
    // 이미 원천으로 채운 문서는 원천 값이 바뀌면 갱신(제조사·모델이 여전히 «원천 값» 일 때만)
    expect(sourceIdentityFields(rec('12가1', '현대', '그랜저'), { maker: '현대', model: '아반떼', vehicle_maker_model_source: 'SOURCE_FIELDS' }, false, makers)).toEqual({});
  });
  it('원천 필드로 채운 문서도 여전히 엔진 정체성 보류다(마스터 정제가 덮어쓴다)', () => {
    const mark = { source_cycle_record: {}, vehicle_review_required: true, vehicle_maker_model_source: 'SOURCE_FIELDS', vehicle_maker_model_filled: { maker: '현대', model: '아반떼' } };
    expect(engineIdentityHold({ ...mark, maker: '현대', model: '아반떼' })).toBe(true);
    expect(engineIdentityHold({ source_cycle_record: {}, vehicle_review_required: true, maker: '현대', model: '아반떼' })).toBe(false);
    // Codex #685 (a): 사람이 고친 뒤 표식만 남은 문서는 보류가 아니다(마스터 정제가 덮어쓰지 않음)
    expect(engineIdentityHold({ ...mark, maker: '현대자동차', model: '아반떼' })).toBe(false);
    expect(engineIdentityHold({ ...mark, maker: '현대', model: '아반떼 CN7' })).toBe(false);
  });
});

describe('입구 매핑 쓰기(기본 꺼짐·공급사별)', () => {
  it('허용 공급사가 없으면(기본) 쓰기·사유 모두 없다', async () => {
    const { commands, fake } = await setup([]);
    fake.put('12가2001', legacyDoc(rec('12가2001')));
    const r = await run(commands, [rec('12가2001')]);
    expect(r.kinds).toEqual([]);
    expect(decodeFields(fake.docs.get('12가2001').fields)).toMatchObject({ maker: '' });
  });

  it('새 문서는 편입할 때 채우고, 기존 빈칸 문서는 한 번 채우며 되풀이하지 않고, 세부모델·트림·가격은 불변', async () => {
    const { commands, fake } = await setup();
    expect((await run(commands, [rec('12가2002')])).kinds).toEqual(['ENROLL']);
    expect(decodeFields(fake.docs.get('12가2002').fields)).toMatchObject({ maker: '현대', model: '아반떼', vehicle_maker_model_source: 'SOURCE_FIELDS', vehicle_review_required: true });
    fake.put('12가2003', legacyDoc(rec('12가2003')));
    const before = decodeFields(fake.docs.get('12가2003').fields);
    const first = await run(commands, [rec('12가2002'), rec('12가2003')]);
    expect(first.kinds).toEqual(['UPDATE']);
    expect(first.warnings).toContain('SOURCE_IDENTITY_REWRITE:1');
    const after = decodeFields(fake.docs.get('12가2003').fields);
    expect(after).toMatchObject({ maker: '현대', model: '아반떼', vehicle_maker_model_source: 'SOURCE_FIELDS', sub_model: before.sub_model, trim_name: '', price: before.price });
    expect((await run(commands, [rec('12가2002'), rec('12가2003')])).kinds).toEqual([]);
  });

  it('사람이 채운 제조사·모델·마스터 확정 문서는 제조사·모델·세부모델을 건드리지 않는다(제원 확인 표식만 한 번)', async () => {
    const { commands, fake } = await setup();
    fake.put('12가2004', legacyDoc(rec('12가2004'), { maker: '기아', model: 'K5', sub_model: '더 뉴 K5 DL3', vehicle_review_required: false, vehicle_title_source: 'MASTER_MATCH' }));
    expect((await run(commands, [rec('12가2004')])).kinds).toEqual(['UPDATE']);   // 제원 빈 칸 확인 표식(vehicle_spec_source_checked) 한 번
    expect(decodeFields(fake.docs.get('12가2004').fields)).toMatchObject({ maker: '기아', model: 'K5', sub_model: '더 뉴 K5 DL3', vehicle_title_source: 'MASTER_MATCH', vehicle_spec_source_checked: true });
    expect((await run(commands, [rec('12가2004')])).kinds).toEqual([]);
  });

  it('이번 회차에 마스터로 확정되면 마스터 이름이 이긴다(원천 값으로 먼저 채우지 않음)', async () => {
    const refiner: VehicleIdentityRefiner = { digest: 'd', match: () => ({ maker: '현대', model: '아반떼', sub_model: '아반떼 CN7', trim_name: null, master_id: 'm1' }) };
    const { commands, fake } = await setup(['RP012'], refiner);
    await run(commands, [rec('12가2005', '현대자동차', '아반떼')]);
    expect(decodeFields(fake.docs.get('12가2005').fields)).toMatchObject({ maker: '현대', model: '아반떼', sub_model: '아반떼 CN7', vehicle_title_source: 'MASTER_MATCH', vehicle_review_required: false });
    expect(decodeFields(fake.docs.get('12가2005').fields).vehicle_maker_model_source).toBeUndefined();
  });

  it('입구 매핑만 채우는 다시 쓰기는 옵션 쓰기와 같은 회차 상한 안에서 이월된다', async () => {
    const { commands, fake } = await setup();
    const total = OPTIONS_REWRITE_CAP + 7, plates = Array.from({ length: total }, (_, i) => `34나${String(7000 + i)}`);
    for (const p of plates) fake.put(p, legacyDoc(rec(p)));
    const first = await run(commands, plates.map(p => rec(p)));
    expect(first.kinds).toHaveLength(OPTIONS_REWRITE_CAP);
    expect(first.warnings.some(w => w.startsWith('API_OPTIONS_DEFERRED:7:'))).toBe(true);
    expect((await run(commands, plates.map(p => rec(p)))).kinds).toHaveLength(7);
  }, 60_000);

  it('Codex #685 (b): 가격 변경과 겹친 문서도 채움은 회차 상한(100) 안 — 초과분은 쓰기는 하되 채움만 미룬다', async () => {
    const { commands, fake } = await setup();
    const total = OPTIONS_REWRITE_CAP + 6, plates = Array.from({ length: total }, (_, i) => `56다${String(8000 + i)}`);
    for (const p of plates) fake.put(p, legacyDoc(rec(p)));
    const changed = plates.map(p => rec(p, '현대', '아반떼', 510000));   // 모두 가격도 바뀜 → 쓰기는 전부 일어난다
    const r = await run(commands, changed);
    expect(r.kinds).toHaveLength(total);
    expect(r.warnings.some(w => w.startsWith('SOURCE_IDENTITY_DEFERRED:6:'))).toBe(true);
    const filled = plates.filter(p => decodeFields(fake.docs.get(p).fields).vehicle_maker_model_source === 'SOURCE_FIELDS');
    expect(filled).toHaveLength(OPTIONS_REWRITE_CAP);
  }, 60_000);

  it('Codex #685 (c): 마스터에 없는 제조사 표기는 maker 에 들어가지 않는다(UNMAPPED 표식, 교정 대상에서 빠지지 않음)', async () => {
    const { commands, fake } = await setup();
    fake.put('78라9001', legacyDoc(rec('78라9001', '르노삼성', 'QM6')));
    await run(commands, [rec('78라9001', '르노삼성', 'QM6')]);
    expect(decodeFields(fake.docs.get('78라9001').fields)).toMatchObject({ maker: '', model: '', vehicle_maker_model_source: 'UNMAPPED' });
  });
});

describe('제원 입구 매핑(기존 문서의 빈 칸에만)', () => {
  const specRec = (plate: string, spec: Record<string, unknown>): SourceProductRecord => ({ ...rec(plate), raw: { ...rec(plate).raw, spec } });
  it('빈 칸에만 채우고, 기존 값·긴 문자열·문자열이 아닌 값은 건드리지 않는다', () => {
    expect(sourceSpecFillFields({ ext_color: '흰색', fuel_type: '가솔린', year: '2023', mileage: '12000', engine_cc: '1598', first_registration_date: '2023-05' }, {}))
      .toEqual({ ext_color: '흰색', fuel_type: '가솔린', year: '2023', mileage: '12000', engine_cc: '1598', first_registration_date: '2023-05' });
    expect(sourceSpecFillFields({ ext_color: '흰색', fuel_type: '가솔린' }, { ext_color: '검정', fuel_type: '' })).toEqual({ fuel_type: '가솔린' });
    expect(sourceSpecFillFields({ ext_color: 'x'.repeat(41), mileage: 5 }, {})).toEqual({});
    expect(sourceSpecFillFields(null, {})).toEqual({});
    expect(sourceSpecFillFields({ year: '2023' }, { year: 2022 })).toEqual({});   // 숫자 기존 값도 값이다
  });

  it('제조사·모델이 이미 있는 기존 문서도 제원 빈 칸을 한 번 채우고 되풀이하지 않으며 기존 값은 그대로', async () => {
    const { commands, fake } = await setup();
    const r = specRec('12가3001', { ext_color: '흰색', fuel_type: '가솔린', mileage: '12000' });
    fake.put('12가3001', legacyDoc(r, { maker: '현대', model: '아반떼', vehicle_review_required: false, vehicle_title_source: 'MASTER_MATCH', ext_color: '검정' }));
    const first = await run(commands, [r]);
    expect(first.kinds).toEqual(['UPDATE']);
    expect(decodeFields(fake.docs.get('12가3001').fields)).toMatchObject({ ext_color: '검정', fuel_type: '가솔린', mileage: '12000', maker: '현대', model: '아반떼' });
    expect((await run(commands, [r])).kinds).toEqual([]);
  });

  it('허용 공급사가 없으면 제원 사유도 쓰기도 없다', async () => {
    const { commands, fake } = await setup([]);
    const r = specRec('12가3002', { ext_color: '흰색' });
    fake.put('12가3002', legacyDoc(r, { maker: '현대', model: '아반떼', vehicle_review_required: false }));
    expect((await run(commands, [r])).kinds).toEqual([]);
  });
});

describe('Codex #685 두 번째 지적', () => {
  it('(a) 스냅샷: 표식 + «이 경로가 쓴 값 그대로»일 때만 원천 채움으로 본다(사람이 고친 값은 현재 값 그대로 대조)', () => {
    const base = { car_number: '12가3456', provider_company_code: 'RP012', vehicle_review_required: true, vehicle_title_source: 'RAW_VEHICLE_TEXT', 원문: { 차명: '현대_아반떼_가솔린' },
      sub_model: '현대_아반떼_가솔린', vehicle_maker_model_source: 'SOURCE_FIELDS', vehicle_maker_model_filled: { maker: '현대', model: '아반떼' } };
    const items = identityProductsFromPlainDocs([
      { id: 'a', data: { ...base, maker: '현대', model: '아반떼' } },          // 쓴 값 그대로 → 원천 채움
      { id: 'b', data: { ...base, maker: '현대자동차', model: '아반떼' } },    // 사람이 고침 → 아님
      { id: 'c', data: { ...base, maker: '현대', model: '아반떼', vehicle_maker_model_filled: undefined } },   // 표식만 → 아님
    ], { includeAll: true });
    const byId = Object.fromEntries(items.map(i => [i.id, i]));
    expect(byId.a!.makerModelFromSource).toBe(true);
    expect(byId.b!.makerModelFromSource).toBeUndefined();
    expect(byId.c!.makerModelFromSource).toBeUndefined();
  });

  it('(b) 신규 편입(ENROLL)도 채움 상한에 센다: 편입 + 기존 보정 합산이 100대를 넘지 않는다', async () => {
    const { commands, fake } = await setup();
    const existing = Array.from({ length: 60 }, (_, i) => `71가${String(1000 + i)}`), fresh = Array.from({ length: 60 }, (_, i) => `72나${String(2000 + i)}`);
    for (const p of existing) fake.put(p, legacyDoc(rec(p)));
    const r = await run(commands, [...existing, ...fresh].map(p => rec(p)));
    expect(r.kinds.filter(k => k === 'ENROLL')).toHaveLength(60);
    expect(r.warnings.join('|')).toContain('API_OPTIONS_DEFERRED:20:');   // 쓰기 상한: 편입 60 + 기존 보정 40 만, 나머지 20 이월(120 중 100 만 채움)
    const filled = [...existing, ...fresh].filter(p => decodeFields(fake.docs.get(p)?.fields ?? {}).vehicle_maker_model_source === 'SOURCE_FIELDS');
    expect(filled).toHaveLength(OPTIONS_REWRITE_CAP);
  }, 60_000);
});

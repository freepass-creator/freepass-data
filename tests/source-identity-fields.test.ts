import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields, sourceIdentityFields, sourceSpecFillFields, engineIdentityHold, sourceModelsOf } from '../src/infra/source-cycle-firestore.js';
import { planSourceCycle, applySourceCycle, OPTIONS_REWRITE_CAP } from '../src/application/source-cycle.js';
import { compactRaw, compactRecord, type SourceProductRecord } from '../src/domain/source-engine.js';
import type { VehicleIdentityRefiner } from '../src/ports/source-cycle.js';
import { identityProductsFromPlainDocs } from '../src/adapters/identity-snapshot.js';
import { modelTablesFromMasters } from '../src/runtime/source-cycle-runtime.js';

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
const MODELS = { 현대: ['아반떼', '그랜저', '쏘나타'], 기아: ['K5', '카니발', '스포티지'] };
const knownMakers: VehicleIdentityRefiner = { digest: 't', match: () => null, makers: ['현대', '기아'], models: MODELS };
async function setup(sourceIdentitySources: string[] = ['RP012'], identity: VehicleIdentityRefiner | undefined = knownMakers, extra: { identityRefineSources?: string[]; specFillSources?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'source-identity-')); dirs.push(dir);
  const fake = fakeFirestore();
  const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
    supplierDefaults: { RP012: { provider_name: '합성손오공', policy_code: 'SYNTHETIC_POLICY' } }, sourceIdentitySources,
    ...(extra.identityRefineSources ? { identityRefineSources: extra.identityRefineSources } : {}),
    ...(extra.specFillSources ? { specFillSources: extra.specFillSources } : {}),
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
    const makers = new Set(['현대', '기아']); const models = sourceModelsOf(MODELS);
    expect(sourceIdentityFields(rec('12가1'), {}, false, makers, '', models)).toEqual({ maker: '현대', model: '아반떼', vehicle_maker_model_source: 'SOURCE_FIELDS', vehicle_maker_model_filled: { maker: '현대', model: '아반떼', sub_model: '' } });
    // Codex #685 (c): 마스터에 없는 제조사 표기(옛 표기)·마스터 미로드는 채우지 않고 표식만
    expect(sourceIdentityFields(rec('12가1', '르노삼성', 'QM6'), {}, false, makers, '', models)).toEqual({ vehicle_maker_model_source: 'UNMAPPED' });
    expect(sourceIdentityFields(rec('12가1'), {}, false, null, '', models)).toEqual({ vehicle_maker_model_source: 'UNMAPPED' });
    expect(sourceIdentityFields(rec('12가1'), { maker: '기아' }, false, makers, '', models)).toEqual({});
    expect(sourceIdentityFields(rec('12가1'), { model: 'K5' }, false, makers, '', models)).toEqual({});
    expect(sourceIdentityFields(rec('12가1'), {}, true, makers, '', models)).toEqual({});   // 이번 회차 마스터 확정이 이긴다
    expect(sourceIdentityFields(rec('12가1', null, null), {}, false, makers, '', models)).toEqual({ vehicle_maker_model_source: 'ABSENT' });
    expect(sourceIdentityFields(rec('12가1'), { vehicle_maker_model_source: 'ABSENT' }, false, makers, '', models)).toEqual({});
    // 이미 원천으로 채운 문서는 원천 값이 바뀌면 갱신(제조사·모델이 여전히 «원천 값» 일 때만)
    expect(sourceIdentityFields(rec('12가1', '현대', '그랜저'), { maker: '현대', model: '아반떼', vehicle_maker_model_source: 'SOURCE_FIELDS' }, false, makers, '', models)).toEqual({});
  });
  it('원천 필드로 채운 문서도 여전히 엔진 정체성 보류다(마스터 정제가 덮어쓴다)', () => {
    const mark = { source_cycle_record: {}, vehicle_review_required: true, vehicle_maker_model_source: 'SOURCE_FIELDS', vehicle_maker_model_filled: { maker: '현대', model: '아반떼', sub_model: '현대_아반떼_가솔린' } };
    expect(engineIdentityHold({ ...mark, maker: '현대', model: '아반떼', sub_model: '현대_아반떼_가솔린' })).toBe(true);
    // Codex #685 ①: 사람이 세부모델을 고쳤으면 maker·model 이 그대로여도 정체성 보류가 아니다
    expect(engineIdentityHold({ ...mark, maker: '현대', model: '아반떼', sub_model: '아반떼 CN7' })).toBe(false);
    expect(engineIdentityHold({ source_cycle_record: {}, vehicle_review_required: true, maker: '현대', model: '아반떼' })).toBe(false);
    // Codex #685 (a): 사람이 고친 뒤 표식만 남은 문서는 보류가 아니다(마스터 정제가 덮어쓰지 않음)
    expect(engineIdentityHold({ ...mark, maker: '현대자동차', model: '아반떼', sub_model: '현대_아반떼_가솔린' })).toBe(false);
    expect(engineIdentityHold({ ...mark, maker: '현대', model: '아반떼 CN7', sub_model: '현대_아반떼_가솔린' })).toBe(false);
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

  it('정체성 정제 공급사 허용 목록: 목록 밖 공급사는 마스터로 확정되어도 정제하지 않고(입구 매핑만), 목록 안이면 마스터 이름이 이긴다', async () => {
    const refiner: VehicleIdentityRefiner = { digest: 'd', makers: ['현대', '기아'], models: MODELS,
      match: () => ({ maker: '현대', model: '아반떼', sub_model: '아반떼 CN7', trim_name: null, master_id: 'm1' }) };
    const outside = await setup(['RP012'], refiner, { identityRefineSources: ['RP031'] });
    await run(outside.commands, [rec('12가2105', '현대', '아반떼')]);
    const o = decodeFields(outside.fake.docs.get('12가2105').fields);
    expect(o.vehicle_title_source).not.toBe('MASTER_MATCH');           // 정제 안 함
    expect(o).toMatchObject({ maker: '현대', model: '아반떼', vehicle_maker_model_source: 'SOURCE_FIELDS' });
    const inside = await setup(['RP012'], refiner, { identityRefineSources: ['RP012'] });
    await run(inside.commands, [rec('12가2106', '현대', '아반떼')]);
    expect(decodeFields(inside.fake.docs.get('12가2106').fields)).toMatchObject({ sub_model: '아반떼 CN7', vehicle_title_source: 'MASTER_MATCH' });
  });

  describe('Codex #704 결함 3건(정체성 정제 쓰기 경로)', () => {
    const refiner: VehicleIdentityRefiner = { digest: 'd', makers: ['현대'],
      match: () => ({ maker: '현대', model: '아반떼', sub_model: '아반떼 CN7', trim_name: null, master_id: 'm1' }) };

    it('(a) 회차 쓰기 상한(100)을 옵션·입구 매핑과 합산해 적용한다 — 초과분은 이월', async () => {
      const { commands, fake } = await setup([], refiner, { identityRefineSources: ['RP012'] });
      const total = OPTIONS_REWRITE_CAP + 20, plates = Array.from({ length: total }, (_, i) => `56다${String(1000 + i)}`);
      for (const p of plates) fake.put(p, legacyDoc(rec(p)));
      const first = await run(commands, plates.map(p => rec(p)));
      expect(first.kinds).toHaveLength(OPTIONS_REWRITE_CAP);
      expect(first.warnings.some(w => /_DEFERRED:20:/.test(w))).toBe(true);
      expect((await run(commands, plates.map(p => rec(p)))).kinds).toHaveLength(20);   // 다음 회차에 나머지
    }, 60_000);

    it('(a-2) 가격 변경처럼 이미 쓰는 문서도 양성 표식이 있는 항목만 정제한다(상한 우회 불가)', async () => {
      const { commands, fake } = await setup([], refiner, { identityRefineSources: ['RP012'] });
      const total = OPTIONS_REWRITE_CAP + 20, plates = Array.from({ length: total }, (_, i) => `57라${String(1000 + i)}`);
      for (const p of plates) fake.put(p, legacyDoc(rec(p, '현대', '아반떼', 500000)));
      const changed = plates.map(p => rec(p, '현대', '아반떼', 600000));   // 가격이 바뀌어 전부 쓰는 회차
      const result = await run(commands, changed);
      expect(result.kinds).toHaveLength(total);                                // 가격 변경은 상한 없이 쓴다
      const refined = plates.filter(p => decodeFields(fake.docs.get(p).fields).vehicle_title_source === 'MASTER_MATCH').length;
      expect(refined).toBe(OPTIONS_REWRITE_CAP);                               // 정제는 상한 안에서만
      expect(result.warnings.some(w => /^VEHICLE_IDENTITY_DEFERRED:20:/.test(w))).toBe(true);
    }, 60_000);

    it('(a-3) 하향되는 문서가 정제 상한을 소모해 뒤쪽 정상 문서를 굶기지 않는다(선정은 공개 문서만)', async () => {
      const { commands, fake } = await setup([], refiner, { identityRefineSources: ['RP012'] });
      const down = Array.from({ length: OPTIONS_REWRITE_CAP }, (_, i) => `58마${String(1000 + i)}`);   // 키 순서가 앞섬, 원천에서 판매 불가 → 하향
      const live = Array.from({ length: 5 }, (_, i) => `58마${String(5000 + i)}`);                        // 키 순서가 뒤, 가격이 바뀌는 정상 문서
      for (const p of down) fake.put(p, legacyDoc(rec(p)));
      for (const p of live) fake.put(p, legacyDoc(rec(p, '현대', '아반떼', 500000)));
      const records = [...down.map(p => ({ ...rec(p), status: { raw: '출고불가', saleAvailable: false } } as SourceProductRecord)), ...live.map(p => rec(p, '현대', '아반떼', 600000))];
      await run(commands, records);
      for (const p of live) expect(decodeFields(fake.docs.get(p).fields).vehicle_title_source, p).toBe('MASTER_MATCH');
      for (const p of down) expect(decodeFields(fake.docs.get(p).fields).vehicle_title_source, p).not.toBe('MASTER_MATCH');
    }, 60_000);

    it('(b) 제조사·모델이 비어도 사람이 입력한 세부모델·트림은 덮어쓰지 않고 검토 필요도 풀지 않는다', async () => {
      const { commands, fake } = await setup([], refiner, { identityRefineSources: ['RP012'] });
      fake.put('56다2001', legacyDoc(rec('56다2001'), { sub_model: '내가 고른 세부모델' }));
      fake.put('56다2002', legacyDoc(rec('56다2002'), { trim_name: '내가 고른 트림' }));
      const r = await run(commands, [rec('56다2001'), rec('56다2002')]);
      expect(r.kinds).toEqual([]);
      expect(decodeFields(fake.docs.get('56다2001').fields)).toMatchObject({ sub_model: '내가 고른 세부모델', vehicle_review_required: true, maker: '' });
      expect(decodeFields(fake.docs.get('56다2002').fields)).toMatchObject({ trim_name: '내가 고른 트림', vehicle_review_required: true, maker: '' });
    });

    it('(c) 하향·철회 쓰기에는 정체성 정제를 섞지 않는다(이름·MASTER_MATCH 변경 없음)', async () => {
      const { commands, fake } = await setup([], refiner, { identityRefineSources: ['RP012'] });
      const stale = { ...rec('56다3001'), status: { raw: '출고불가', saleAvailable: false } } as SourceProductRecord;
      fake.put('56다3001', legacyDoc(rec('56다3001')));
      const r = await run(commands, [stale]);
      expect(r.kinds).toEqual(['DOWNGRADE']);
      const doc = decodeFields(fake.docs.get('56다3001').fields);
      expect(doc.listable).toBe(false);
      expect(doc).toMatchObject({ maker: '', model: '', vehicle_review_required: true });
      expect(doc.vehicle_title_source).not.toBe('MASTER_MATCH');
    });
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

describe('Codex #685 세 번째 지적', () => {
  it('③ 사유 없는 UPDATE(가격 변경 등)는 채움을 하지 않는다 — 양성 표식(fillSourceIdentity)이 있는 항목만 채운다', async () => {
    const { commands, fake } = await setup();
    // 표식이 이미 있는(UNMAPPED) 문서는 사유가 없다: 가격이 바뀌어 쓰기가 일어나도 maker·model 은 채워지지 않는다.
    fake.put('81가1001', legacyDoc(rec('81가1001'), { vehicle_maker_model_source: 'UNMAPPED' }));
    const r = await run(commands, [rec('81가1001', '현대', '아반떼', 520000)]);
    expect(r.kinds).toEqual(['UPDATE']);
    expect(decodeFields(fake.docs.get('81가1001').fields)).toMatchObject({ maker: '', model: '', price: { 36: { rent: 520000 } } });
  });

  it('② 원천 채움 문서의 사람 입력 트림은 정체성 계획이 덮어쓰지 않는다(TRIM_CONFLICT_EXISTING 보류)', async () => {
    const { buildIdentityPromotionPlan } = await import('../src/application/identity-promotion-plan.js');
    const master = { id: 'M', maker: '현대', model: '아반떼', sub_model: '아반떼 CN7', model_aliases: [], sub_model_aliases: [], yearFrom: 2020, yearTo: null,
      trims: [{ name: '프리미엄', aliases: [] }, { name: '모던', aliases: [] }] };
    const p = { id: 'x', plate4: '3456', maker: '현대', model: '아반떼', sub_model: '현대_아반떼 CN7_가솔린 1.6_프리미엄', trim_name: '모던',
      rawName: '현대_아반떼 CN7_가솔린 1.6_프리미엄', year: '2022', listable: true, engineTemp: true, makerModelFromSource: true };
    const result = buildIdentityPromotionPlan([p], [master]);
    expect(result.held.map(h => h.reason)).toContain('TRIM_CONFLICT_EXISTING');
    expect(result.trimPlan === null || (result.trimPlan.productTrimRepairs ?? []).length === 0).toBe(true);
  });
});

describe('Codex #688 지적(제원 입구 매핑)', () => {
  const specRec = (plate: string, spec: Record<string, unknown>): SourceProductRecord => ({ ...rec(plate), raw: { ...rec(plate).raw, spec } });
  it('① 형식·단위: 숫자는 정수 문자열만, 날짜·연식은 정해진 꼴, 연료는 제원 목록 안에서만', () => {
    expect(sourceSpecFillFields({ engine_cc: '2,497', mileage: '12,000km', year: '23', first_registration_date: '2023/05', fuel_type: 'GSL' }, {})).toEqual({});
    expect(sourceSpecFillFields({ engine_cc: '2497cc' }, {})).toEqual({});
    expect(sourceSpecFillFields({ engine_cc: '2497', mileage: '12000', year: '2023', first_registration_date: '2023-05-02', fuel_type: '가솔린+LPG', seats: '7' }, {}))
      .toEqual({ engine_cc: '2497', mileage: '12000', year: '2023', first_registration_date: '2023-05-02', fuel_type: '가솔린+LPG', seats: '7' });
    expect(sourceSpecFillFields({ seats: '700' }, {})).toEqual({});   // 인승은 1~2자리 정수
  });

  it('② 전기·수소 차에는 배기량을 채우지 않는다(문서 연료 또는 이번에 채울 연료)', () => {
    expect(sourceSpecFillFields({ engine_cc: '1598', fuel_type: '가솔린' }, { fuel_type: '전기' })).toEqual({});
    expect(sourceSpecFillFields({ engine_cc: '1598', fuel_type: '전기' }, {})).toEqual({ fuel_type: '전기' });
    expect(sourceSpecFillFields({ engine_cc: '1598', fuel_type: '수소' }, {})).toEqual({ fuel_type: '수소' });
    expect(sourceSpecFillFields({ engine_cc: '1598' }, { fuel_type: '디젤' })).toEqual({ engine_cc: '1598' });
  });

  it('④ 이미 확인한 문서(vehicle_spec_source_checked)는 첫 채움을 다시 하지 않고, 대표 2026-10-19 이후 «빈 칸 + 원천 값 있음» 칸만 다시 채운다(값 있는 칸은 비접촉)', async () => {
    const { sourceSpecFillFields: fill } = await import('../src/infra/source-cycle-firestore.js');
    expect(fill({ ext_color: '흰색' }, { vehicle_spec_source_checked: true })).toEqual({});
    const { commands, fake } = await setup();
    const r = specRec('12가4001', { ext_color: '흰색', fuel_type: '가솔린' });
    fake.put('12가4001', legacyDoc(r, { maker: '현대', model: '아반떼', vehicle_review_required: false, vehicle_spec_source_checked: true, fuel_type: '디젤' }));
    const changed = specRec('12가4001', { ext_color: '흰색', fuel_type: '가솔린' }); changed.terms[0]!.monthlyRent = { state: 'KNOWN', value: 540000 };
    expect((await run(commands, [changed])).kinds).toEqual(['UPDATE']);   // 가격 변경 + 빈 칸 다시 채움
    const doc = decodeFields(fake.docs.get('12가4001').fields);
    expect(doc).toMatchObject({ price: { 36: { rent: 540000 } }, ext_color: '흰색', fuel_type: '디젤' });   // 빈 외장색만 채움, 있는 연료는 원천과 달라도 덮지 않음
    expect((await run(commands, [changed])).kinds).toEqual([]);             // 되풀이 없음
  });

  it('③ 신규 편입 중 제조사·모델 없이 제원만 있는 차량도 기존 보정과 합쳐 채움 상한(100)에 센다', async () => {
    const { commands, fake } = await setup();
    const strip = (r: SourceProductRecord) => { delete r.raw.source_maker; delete r.raw.source_model; return r; };
    const existing = Array.from({ length: 60 }, (_, i) => `91마${String(5000 + i)}`), fresh = Array.from({ length: 60 }, (_, i) => `92바${String(6000 + i)}`);
    for (const p of existing) fake.put(p, legacyDoc(specRec(p, { ext_color: '흰색' }), { maker: '현대', model: '아반떼', vehicle_review_required: false }));
    const out = await run(commands, [...existing, ...fresh].map(p => strip(specRec(p, { ext_color: '흰색' }))));
    expect(out.kinds.filter(k => k === 'ENROLL')).toHaveLength(60);
    const checked = [...existing, ...fresh].filter(p => decodeFields(fake.docs.get(p)?.fields ?? {}).vehicle_spec_source_checked === true);
    expect(checked).toHaveLength(OPTIONS_REWRITE_CAP);   // 편입 60 + 기존 40(쓰기 상한), 채움 합계 100
  }, 60_000);
});

describe('Codex #685 네 번째 지적', () => {
  it('(a) 사람이 고른 세부모델·트림이 있는 문서는 채우지 않고, 그 값을 엔진이 쓴 값으로 기록하지도 않는다', async () => {
    const { commands, fake } = await setup();
    fake.put('93사1001', legacyDoc(rec('93사1001'), { sub_model: '아반떼 CN7', trim_name: '' }));        // 사람이 세부모델을 고름
    fake.put('93사1002', legacyDoc(rec('93사1002'), { trim_name: '모던' }));                              // 사람이 트림을 고름
    await run(commands, [rec('93사1001'), rec('93사1002')]);
    for (const id of ['93사1001', '93사1002']) {
      const doc = decodeFields(fake.docs.get(id).fields);
      expect(doc.maker).toBe('');
      expect(doc.vehicle_maker_model_filled).toBeUndefined();
    }
  });

  it('(b) 트림을 사람이 고치면 maker·model·세부모델이 그대로여도 정체성 보류가 아니다', () => {
    const base = { source_cycle_record: {}, vehicle_review_required: true, vehicle_maker_model_source: 'SOURCE_FIELDS', maker: '현대', model: '아반떼', sub_model: '현대_아반떼_가솔린',
      vehicle_maker_model_filled: { maker: '현대', model: '아반떼', sub_model: '현대_아반떼_가솔린' } };
    expect(engineIdentityHold({ ...base, trim_name: '' })).toBe(true);
    expect(engineIdentityHold({ ...base, trim_name: '모던' })).toBe(false);
  });
});

describe('Codex #688 두 번째 지적', () => {
  const specRec = (plate: string, spec: Record<string, unknown>): SourceProductRecord => ({ ...rec(plate), raw: { ...rec(plate).raw, spec } });
  it('(b) 최초등록일은 실제 달력 날짜만(윤년 포함)', () => {
    for (const bad of ['2026-99-99', '2026-02-31', '2025-02-29', '2026-13', '1900-01-01']) expect(sourceSpecFillFields({ first_registration_date: bad }, {}), bad).toEqual({});
    for (const ok of ['2024-02-29', '2026-10', '2026-10-16']) expect(sourceSpecFillFields({ first_registration_date: ok }, {}), ok).toEqual({ first_registration_date: ok });
  });

  it('(a) 허용 공급사의 신규 문서는 검증 없는 sheetSpecFields 로 제원을 쓰지 않고, 계획의 양성 표식을 받은 검증된 채움만 쓴다', async () => {
    const { commands, fake } = await setup();
    const r = specRec('94아1001', { ext_color: '흰색', engine_cc: '2,497', fuel_type: 'GSL', first_registration_date: '2026-02-31' });
    await run(commands, [r]);
    const doc = decodeFields(fake.docs.get('94아1001').fields);
    expect(doc.ext_color).toBe('흰색');
    expect(doc.engine_cc).toBeUndefined();        // 형식 검증에서 거절된 값은 남지 않는다
    expect(doc.fuel_type).toBeUndefined();
    expect(doc.first_registration_date).toBeUndefined();
    // 허용 공급사가 아니면 기존(신규 문서 sheetSpecFields) 동작 그대로
    const off = await setup([]);
    await run(off.commands, [specRec('94아1002', { ext_color: '검정' })]);
    expect(decodeFields(off.fake.docs.get('94아1002').fields).ext_color).toBe('검정');
  });
});

describe('Codex #685 다섯 번째 지적', () => {
  it('선정 단계에도 소유 검사: 사람이 세부모델·트림을 입력한 행은 사유를 받지 않아 같은 재쓰기가 반복되지 않는다', async () => {
    const { commands, fake } = await setup();
    fake.put('95자1001', legacyDoc(rec('95자1001'), { sub_model: '아반떼 CN7' }));
    fake.put('95자1002', legacyDoc(rec('95자1002'), { trim_name: '모던' }));
    await run(commands, [rec('95자1001'), rec('95자1002')]);   // 제원 확인 표식(spec) 한 번은 있을 수 있다
    const again = await run(commands, [rec('95자1001'), rec('95자1002')]);
    expect(again.kinds).toEqual([]);                                  // 같은 재쓰기가 반복되지 않는다(상한 슬롯 소모 없음)
    expect(again.warnings.some(w => w.startsWith('SOURCE_IDENTITY_REWRITE'))).toBe(false);
    expect(decodeFields(fake.docs.get('95자1001').fields).maker).toBe('');
  });
});

describe('2026-10-16 17:00 RP012 REEXPOSE 되읽기 불일치(rewriteReasons)', () => {
  it('재노출 문서는 쓴 뒤 노출·엔진 소유가 되어 읽기 경로가 사유(채움 대기)를 계산하지만 되읽기는 일치로 본다(APPLY_UNCERTAIN 아님)', async () => {
    const { commands, fake } = await setup();
    const records: SourceProductRecord[] = [];
    for (let i = 0; i < 8; i++) {
      const plate = `95자${String(2000 + i)}`;
      const r = rec(plate);
      records.push(r);
      fake.put(plate, legacyDoc(r, { listable: false, status: '출고불가', status_kind: '출고불가' }));
    }
    const result = await run(commands, records);
    expect(result.kinds.filter(k => k === 'REEXPOSE').length).toBe(8);
    expect(result.applied?.status).toBe('APPLIED');
    expect(result.applied?.uncertain).toEqual([]);
    expect(result.applied?.verified).toBe(8);
    // 쓴 뒤 다시 읽으면 채움 대기 사유가 보인다(다음 회차에 채움) — 되읽기 비교에서는 제외된다
    const reread = await commands.read(source, '95자2000');
    expect(reread?.rewriteReasons ?? []).toContain('SOURCE_IDENTITY');
  });

  it('채움 상한은 옵션 상한 설정(optionsRewriteCap)을 따른다: 기본 100 이면 이월, 150 이면 120대 모두 한 회차에 채운다', async () => {
    const records: SourceProductRecord[] = [];
    const seed = (fake: Awaited<ReturnType<typeof setup>>['fake']) => {
      for (let i = 0; i < 120; i++) { const plate = `95자${String(4000 + i)}`; const r = rec(plate); records.push(r); fake.put(plate, legacyDoc(r)); }
    };
    const planWith = async (cap: number | undefined) => {
      records.length = 0;
      const { commands, fake } = await setup(); seed(fake);
      const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1, ...(cap ? { optionsRewriteCap: cap } : {}) },
        { records, observedAt: time, heldCount: 0, complete: true }, await commands.list(source), now);
      const applied = await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now });
      const filled = [...fake.docs.keys()].filter(uid => decodeFields(fake.docs.get(uid).fields).maker === '현대').length;
      return { warnings: built.plan.warnings, status: applied.status, filled };
    };
    const base = await planWith(undefined);
    expect(base.status).toBe('APPLIED');
    expect(base.filled).toBe(OPTIONS_REWRITE_CAP);
    expect(base.warnings.some(w => /_DEFERRED:/.test(w))).toBe(true);   // 옵션·채움 공통 상한 이월 경고
    const wide = await planWith(150);
    expect(wide.status).toBe('APPLIED');
    expect(wide.filled).toBe(120);
    expect(wide.warnings.some(w => /_DEFERRED:/.test(w))).toBe(false);
  });
});

describe('Codex #697 비차단: 제원 채움을 마친 문서의 내장색 보완', () => {
  const withInterior = (plate: string, interior: string | null): SourceProductRecord => {
    const r = rec(plate);
    return { ...r, raw: { ...r.raw, spec: { ext_color: '빨간색', ...(interior ? { int_color: interior } : {}) } } } as SourceProductRecord;
  };
  it('제원 확인(vehicle_spec_source_checked)을 이미 마친 문서도 내장색만 한 번 보완하고 표식을 남겨 되풀이하지 않는다', async () => {
    const { commands, fake } = await setup();
    const r = withInterior('95자5001', '블랙');
    fake.put('95자5001', legacyDoc(r, { maker: '현대', model: '아반떼', vehicle_maker_model_source: 'SOURCE_FIELDS', vehicle_spec_source_checked: true, ext_color: '흰색' }));
    const first = await run(commands, [r]);
    expect(first.applied?.status).toBe('APPLIED');
    const doc = decodeFields(fake.docs.get('95자5001').fields);
    expect(doc.int_color).toBe('블랙');
    expect(doc.ext_color).toBe('흰색');                        // 기존 값 비접촉
    expect(doc.vehicle_int_color_source_checked).toBe(true);
    const second = await run(commands, [r]);
    expect(second.kinds).toEqual([]);                          // 되풀이 쓰기 없음
  });
  it('원천에 내장색이 없어도 표식만 한 번 남기고(값은 비움) 다시 쓰지 않는다', async () => {
    const { commands, fake } = await setup();
    const r = withInterior('95자5002', null);
    fake.put('95자5002', legacyDoc(r, { maker: '현대', model: '아반떼', vehicle_maker_model_source: 'SOURCE_FIELDS', vehicle_spec_source_checked: true }));
    const first = await run(commands, [r]);
    expect(first.applied?.status).toBe('APPLIED');
    const doc = decodeFields(fake.docs.get('95자5002').fields);
    expect(doc.vehicle_int_color_source_checked).toBe(true);   // 값은 비우고 표식만
    expect(doc.int_color ?? '').toBe('');
    expect((await run(commands, [r])).kinds).toEqual([]);      // 다시 쓰지 않는다
  });
});

describe('대표 2026-10-19 연료 빈칸: 별칭 표 + 빈 칸 다시 채움 + 마스터 연료', () => {
  const specRec = (plate: string, spec: Record<string, unknown> | null, vehicleText?: string): SourceProductRecord => {
    const r = rec(plate);
    return { ...r, ...(vehicleText ? { vehicleText } : {}), raw: { ...r.raw, ...(spec ? { spec } : {}) } };
  };
  const checkedDoc = (r: SourceProductRecord, extra: Record<string, unknown> = {}) =>
    legacyDoc(r, { maker: '현대', model: '아반떼', vehicle_maker_model_source: 'SOURCE_FIELDS', vehicle_spec_source_checked: true, vehicle_int_color_source_checked: true,
      ext_color: '흰색', int_color: '검정', year: '2024', mileage: '1000', engine_cc: '1580', seats: '5', first_registration_date: '2024-01-02', ...extra });

  it('확인 표식이 찍힌 문서의 빈 연료를 «가솔린+전기» 원천으로 하이브리드로 채우고, 되풀이하지 않는다', async () => {
    const { commands, fake } = await setup();
    const r = specRec('71가1001', { fuel_type: '가솔린+전기' }, '현대_아반떼_하이브리드 1.6');
    fake.put('71가1001', checkedDoc(r));
    const first = await run(commands, [r]);
    expect(first.kinds).toEqual(['UPDATE']);
    expect(first.applied?.status).toBe('APPLIED');
    expect(decodeFields(fake.docs.get('71가1001').fields)).toMatchObject({ fuel_type: '하이브리드', ext_color: '흰색', engine_cc: '1580' });
    expect((await run(commands, [r])).kinds).toEqual([]);
  });

  it('원천에 값이 없거나 표에 없는 표기·차명과 어긋나는 표기면 고르지도 쓰지도 않는다', async () => {
    const { commands, fake } = await setup();
    const none = specRec('71가1002', null), odd = specRec('71가1003', { fuel_type: 'GSL' }), clash = specRec('71가1004', { fuel_type: '휘발유' }, '현대_싼타페_1.6 HEV AWD');
    for (const r of [none, odd, clash]) fake.put(r.plate!, checkedDoc(r));
    expect((await run(commands, [none, odd, clash])).kinds).toEqual([]);
    for (const r of [none, odd, clash]) expect(decodeFields(fake.docs.get(r.plate!).fields).fuel_type).toBeUndefined();
  });

  it('계약 잠금 문서는 빈 칸이어도 다시 채우지 않는다', async () => {
    const { commands, fake } = await setup();
    const r = specRec('71가1005', { fuel_type: '가솔린' });
    fake.put('71가1005', checkedDoc(r, { locked_by_contract: true }));
    await run(commands, [r]);
    expect(decodeFields(fake.docs.get('71가1005').fields).fuel_type).toBeUndefined();
  });

  it('원천에 연료가 없어도 정체성이 확정된 차는 마스터 연료가 하나로 모일 때만 채운다', async () => {
    const trimFuel: VehicleIdentityRefiner['trimFuel'] = id => id.trim_name === '모던' ? '하이브리드' : null;
    const { commands, fake } = await setup(['RP012'], { ...knownMakers, trimFuel });
    const one = specRec('71가1006', null), two = specRec('71가1007', null), unconfirmed = specRec('71가1008', null);
    fake.put('71가1006', checkedDoc(one, { sub_model: '더 뉴 아반떼 하이브리드 CN7', trim_name: '모던', vehicle_review_required: false }));
    fake.put('71가1007', checkedDoc(two, { sub_model: '더 뉴 아반떼 하이브리드 CN7', trim_name: '스마트', vehicle_review_required: false }));   // 마스터가 하나로 안 모임
    fake.put('71가1008', checkedDoc(unconfirmed, { sub_model: '더 뉴 아반떼 하이브리드 CN7', trim_name: '모던', vehicle_review_required: true }));   // 정체성 미확정
    const first = await run(commands, [one, two, unconfirmed]);
    expect(first.kinds).toEqual(['UPDATE']);
    expect(decodeFields(fake.docs.get('71가1006').fields).fuel_type).toBe('하이브리드');
    expect(decodeFields(fake.docs.get('71가1007').fields).fuel_type).toBeUndefined();
    expect(decodeFields(fake.docs.get('71가1008').fields).fuel_type).toBeUndefined();
    expect((await run(commands, [one, two, unconfirmed])).kinds).toEqual([]);
  });

  it('원천 연료 원문이 있으면(해석 보류·차명 충돌 포함) 마스터로 덮지 않는다(Codex 검토 P1)', async () => {
    const trimFuel: VehicleIdentityRefiner['trimFuel'] = () => '하이브리드';
    const { commands, fake } = await setup(['RP012'], { ...knownMakers, trimFuel });
    const phev = specRec('71가1010', { fuel_type: 'HEV' }, '기아_니로_플러그인 하이브리드'), odd = specRec('71가1011', { fuel_type: 'GSL' });
    for (const r of [phev, odd]) fake.put(r.plate!, checkedDoc(r, { sub_model: '니로 하이브리드 SG2', trim_name: '노블레스', vehicle_review_required: false }));
    expect((await run(commands, [phev, odd])).kinds).toEqual([]);
    for (const r of [phev, odd]) expect(decodeFields(fake.docs.get(r.plate!).fields).fuel_type).toBeUndefined();
  });

  it('다른 빈 칸 때문에 고른 문서도 원천 연료 원문(목록 원문·규격 검증으로 지운 값)이 있으면 마스터 연료를 쓰지 않는다(Codex 재검토 P1)', async () => {
    const trimFuel: VehicleIdentityRefiner['trimFuel'] = () => '하이브리드';
    const { commands, fake } = await setup(['RP012'], { ...knownMakers, trimFuel });
    const listOnly = specRec('71가1013', { ext_color: '빨강' }); listOnly.raw = { ...listOnly.raw, list: { fuel: 'GSL' } };
    const validated = specRec('71가1014', { ext_color: '빨강', fuel_type: 'GSL' });
    for (const r of [listOnly, validated]) fake.put(r.plate!, checkedDoc(r, { ext_color: '', sub_model: '아반떼 하이브리드 CN7', trim_name: '모던', vehicle_review_required: false }));
    const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1, specValidation: true }, { records: [listOnly, validated], observedAt: time, heldCount: 0, complete: true },
      await commands.list(source), now);
    expect(built.plan.entries).toHaveLength(2);   // 외장색 다시 채움으로 선정
    await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now });
    for (const r of [listOnly, validated]) {
      const doc = decodeFields(fake.docs.get(r.plate!).fields);
      expect(doc.ext_color).toBe('빨강');
      expect(doc.fuel_type).toBeUndefined();
    }
  });

  it('계획 뒤 마스터 연료가 바뀌면 같은 승인 계획으로 쓰지 않는다(Codex 검토 P1: 계획에 마스터 연료 고정)', async () => {
    let fuel = '하이브리드';
    const refiner: VehicleIdentityRefiner = { ...knownMakers, trimFuel: () => fuel };
    const { commands, fake } = await setup(['RP012'], refiner);
    const r = specRec('71가1012', null);
    fake.put('71가1012', checkedDoc(r, { sub_model: '아반떼 하이브리드 CN7', trim_name: '모던', vehicle_review_required: false }));
    const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records: [r], observedAt: time, heldCount: 0, complete: true },
      await commands.list(source), now);
    expect(built.plan.entries[0]?.before?.specMasterFuel).toBe('하이브리드');
    fuel = '가솔린';
    const applied = await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now }).catch((e: Error) => ({ status: e.message }));
    expect(applied.status).not.toBe('APPLIED');
    expect(decodeFields(fake.docs.get('71가1012').fields).fuel_type).toBeUndefined();
  });

  it('제원만 켠 공급사(specFillSources)는 제원은 채우되 제조사·모델 입구 매핑은 하지 않는다', async () => {
    const { commands, fake } = await setup([], knownMakers, { specFillSources: ['RP012'] });
    const r = specRec('71가1009', { fuel_type: '휘발유', ext_color: '파랑' });
    fake.put('71가1009', legacyDoc(r));
    await run(commands, [r]);
    const doc = decodeFields(fake.docs.get('71가1009').fields);
    expect(doc).toMatchObject({ fuel_type: '가솔린', ext_color: '파랑', vehicle_spec_source_checked: true, maker: '' });
    expect(doc.vehicle_maker_model_source).toBeUndefined();
  });

  it('다시 채움도 채움 상한(기본 100)에 들어가고 남은 차는 다음 회차에 이어 채운다', async () => {
    const { commands, fake } = await setup();
    const records = Array.from({ length: 120 }, (_, i) => specRec(`72나${String(7000 + i)}`, { fuel_type: '가솔린+전기' }, '현대_아반떼_하이브리드'));
    for (const r of records) fake.put(r.plate!, checkedDoc(r));
    const first = await run(commands, records);
    expect(first.warnings.some(w => /_DEFERRED:20:/.test(w))).toBe(true);   // 채움 전용 쓰기 상한 이월(옵션·채움 공통 예산)
    const filled = () => records.filter(r => decodeFields(fake.docs.get(r.plate!).fields).fuel_type === '하이브리드').length;
    expect(filled()).toBe(OPTIONS_REWRITE_CAP);
    await run(commands, records);
    expect(filled()).toBe(120);
    expect((await run(commands, records)).kinds).toEqual([]);
  }, 60_000);
});

describe('2026-10-16 «마스터가 작동을 안 한다»: 모델은 마스터 모델 이름일 때만(괄호·세대·수식어 금지)', () => {
  const models = sourceModelsOf(MODELS);
  const makers = new Set(['현대', '기아']);

  it('순수: 마스터 모델 이름(공백·대소문자 차이만 허용)만 쓰고, 괄호·세대·«신형/더 뉴/디 올뉴» 표기와 마스터 목록이 없을 때는 쓰지 않는다', () => {
    expect(sourceIdentityFields(rec('12가1', '현대', '아반떼'), {}, false, makers, '', models)).toMatchObject({ maker: '현대', model: '아반떼' });
    expect(sourceIdentityFields(rec('12가1', '기아', 'k5'), {}, false, makers, '', models)).toMatchObject({ maker: '기아', model: 'K5' });   // 대소문자만 다름 — 정식 마스터 이름으로 씀
    for (const bad of ['더 뉴아반떼(CN7)', '디 올뉴그랜저 하이브리드', '신형 카니발', '스포티지 5세대', '투싼 (NX4)', '신형쏘렌토(MQ4)']) {
      const out = sourceIdentityFields(rec('12가1', '기아', bad), {}, false, makers, '', models);
      expect(out.maker, bad).toBe('기아');
      expect(out.model, bad).toBe('');                  // 모델은 비우고 정제 대기
      expect(out.vehicle_maker_model_source, bad).toBe('SOURCE_FIELDS');
    }
    expect(sourceIdentityFields(rec('12가1', '현대', '아반떼'), {}, false, makers, '', null)).toMatchObject({ maker: '현대', model: '' });   // 마스터 목록 없음 → fail-closed
  });

  it('되돌리기: 입구 매핑이 이미 쓴 모델이 마스터 이름이 아니면 모델만 비운다(사람·정제 값·트림 있는 문서는 제외)', () => {
    const filled = { maker: '현대', model: '더 뉴아반떼(CN7)', sub_model: '현대_더 뉴아반떼(CN7)_가솔린' };
    const doc = { maker: filled.maker, model: filled.model, sub_model: filled.sub_model, trim_name: '', vehicle_review_required: true, vehicle_maker_model_source: 'SOURCE_FIELDS', vehicle_maker_model_filled: filled };
    expect(sourceIdentityFields(rec('12가1', '현대', '더 뉴아반떼(CN7)'), doc, false, makers, '', models))
      .toEqual({ model: '', vehicle_maker_model_filled: { maker: '현대', model: '', sub_model: filled.sub_model } });
    // 사람이 모델을 고쳤으면(채움 값과 다름) 비접촉
    expect(sourceIdentityFields(rec('12가1', '현대', '더 뉴아반떼(CN7)'), { ...doc, model: '아반떼 직접입력' }, false, makers, '', models)).toEqual({});
    // 트림이 있으면(사람 입력) 비접촉
    expect(sourceIdentityFields(rec('12가1', '현대', '더 뉴아반떼(CN7)'), { ...doc, trim_name: '모던' }, false, makers, '', models)).toEqual({});
    // 사람이 값을 승인하고 검토를 끝낸 문서(검토 필요 false)는 비접촉(Codex #706 ②)
    expect(sourceIdentityFields(rec('12가1', '현대', '더 뉴아반떼(CN7)'), { ...doc, vehicle_review_required: false }, false, makers, '', models)).toEqual({});
    // 이미 마스터 이름이면 비접촉
    const ok = { ...doc, model: '아반떼', vehicle_maker_model_filled: { ...filled, model: '아반떼' } };
    expect(sourceIdentityFields(rec('12가1', '현대', '아반떼'), ok, false, makers, '', models)).toEqual({});
  });

  it('Codex #706: 별칭 자체는 쓰지 않고 정식 이름으로 변환, 검토 완료·트림 있는 문서는 선정되지 않고 선정·쓰기가 같은 조건이다', async () => {
    const aliased = sourceModelsOf({ 기아: ['카니발'] }, { 기아: { '신형 카니발': '카니발', '카니발 4세대': '카니발' } });
    // 신규 유입: 별칭 «신형 카니발» 은 정식 «카니발» 로 쓴다(별칭 문자열 그대로 쓰지 않음)
    expect(sourceIdentityFields(rec('12가1', '기아', '신형 카니발'), {}, false, makers, '', aliased)).toMatchObject({ maker: '기아', model: '카니발' });
    // 별칭도 정식도 아닌 표기는 비움
    expect(sourceIdentityFields(rec('12가1', '기아', '카니발 5세대(KA5)'), {}, false, makers, '', aliased)).toMatchObject({ maker: '기아', model: '' });
    // 되돌리기: 이미 별칭 표기로 쓴 문서는 정식 이름으로 바꾼다
    const filled = { maker: '기아', model: '신형 카니발', sub_model: '기아_신형 카니발_디젤' };
    const doc = { maker: filled.maker, model: filled.model, sub_model: filled.sub_model, trim_name: '', vehicle_review_required: true, vehicle_maker_model_source: 'SOURCE_FIELDS', vehicle_maker_model_filled: filled };
    expect(sourceIdentityFields(rec('12가1', '기아', '신형 카니발'), doc, false, makers, '', aliased)).toMatchObject({ model: '카니발' });
  });

  it('Codex #706 2차: 한 별칭이 서로 다른 정식 모델 둘에 있으면 제외, 별칭 대상은 저장된 정식 값(대소문자)으로 변환', () => {
    const tables = modelTablesFromMasters([
      { maker: '기아', model: '카니발', model_aliases: ['신형 카니발', '더 뉴 모델'] },
      { maker: '기아', model: '쏘렌토', model_aliases: ['더 뉴 모델', '신형 쏘렌토'] },   // «더 뉴 모델» 이 두 정식 모델에 → 모호
      { maker: '기아', model: 'K5', model_aliases: ['케이파이브'] },
    ]);
    expect(tables.modelAliases['기아']).toEqual({ '신형카니발': '카니발', '신형쏘렌토': '쏘렌토', '케이파이브': 'K5' });
    expect(tables.models['기아']).toEqual(['K5', '쏘렌토', '카니발'].sort());
    const models = sourceModelsOf({ 기아: ['K5'] }, { 기아: { 케이파이브: 'k5' } });   // 별칭 대상 표기가 대소문자만 다름
    expect(sourceIdentityFields(rec('12가1', '기아', '케이파이브'), {}, false, new Set(['기아']), '', models)).toMatchObject({ model: 'K5' });
    // 모호 별칭은 표 생성에서 제외되므로(위) 표에 없는 표기는 비운다
    expect(sourceIdentityFields(rec('12가1', '기아', '더 뉴 모델'), {}, false, new Set(['기아']), '', sourceModelsOf(tables.models, tables.modelAliases))).toMatchObject({ model: '' });
  });

  it('Codex #706 ③④: 선정과 쓰기가 같은 조건 — 트림이 있는 문서는 되돌리기 사유가 없고, 통합 쓰기는 APPLIED·uncertain 0·verified 건수 일치', async () => {
    const { commands, fake } = await setup();
    const withTrim = rec('59바2001', '현대', '더 뉴아반떼(CN7)');
    const plain = rec('59바2002', '현대', '더 뉴아반떼(CN7)');
    const filled = (r: SourceProductRecord) => ({ maker: '현대', model: '더 뉴아반떼(CN7)', vehicle_maker_model_source: 'SOURCE_FIELDS',
      vehicle_maker_model_filled: { maker: '현대', model: '더 뉴아반떼(CN7)', sub_model: r.vehicleText } });
    fake.put('59바2001', legacyDoc(withTrim, { ...filled(withTrim), trim_name: '모던' }));   // 트림이 있으면 사람 입력 — 선정 안 됨
    fake.put('59바2002', legacyDoc(plain, filled(plain)));
    const result = await run(commands, [withTrim, plain]);
    // 두 문서 모두 제원 확인 표식 때문에 항목은 생기지만(다른 사유), 모델 되돌리기는 트림 없는 문서에만 일어난다 — 선정만 되고 안 써져 반복되는 일이 없다
    expect(result.applied?.status).toBe('APPLIED');
    expect(result.applied?.uncertain).toEqual([]);
    expect(result.applied?.verified).toBe(result.kinds.length);
    expect((await run(commands, [withTrim, plain])).kinds).toEqual([]);   // 한 번 뒤 되풀이 없음
    expect(decodeFields(fake.docs.get('59바2001').fields)).toMatchObject({ model: '더 뉴아반떼(CN7)', trim_name: '모던' });
    expect(decodeFields(fake.docs.get('59바2002').fields)).toMatchObject({ model: '' });
  });

  it('쓰기: 마스터 이름이 아닌 모델은 쓰지 않고(정제 대기), 이미 쓴 128건형 문서는 한 번에 모델만 비워지며 되풀이하지 않는다', async () => {
    const { commands, fake } = await setup();
    const fresh = rec('59바1001', '현대', '더 뉴아반떼(CN7)');
    fake.put('59바1001', legacyDoc(fresh));                       // 새 입구 매핑 대상: 괄호 모델 → maker 만
    const r = rec('59바1002', '현대', '더 뉴아반떼(CN7)');         // 이미 옛 로직이 쓴 문서(모델이 괄호 표기 그대로)
    fake.put('59바1002', legacyDoc(r, { maker: '현대', model: '더 뉴아반떼(CN7)', vehicle_maker_model_source: 'SOURCE_FIELDS',
      vehicle_maker_model_filled: { maker: '현대', model: '더 뉴아반떼(CN7)', sub_model: r.vehicleText } }));
    const first = await run(commands, [fresh, r]);
    expect(first.kinds).toEqual(['UPDATE', 'UPDATE']);
    expect(decodeFields(fake.docs.get('59바1001').fields)).toMatchObject({ maker: '현대', model: '', vehicle_maker_model_source: 'SOURCE_FIELDS' });
    expect(decodeFields(fake.docs.get('59바1002').fields)).toMatchObject({ maker: '현대', model: '', sub_model: r.vehicleText, trim_name: '' });
    expect((await run(commands, [fresh, r])).kinds).toEqual([]);   // 되풀이 쓰기 없음
  });
});

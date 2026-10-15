import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields, apiOptionFields, API_OPTIONS_MAX_ITEMS } from '../src/infra/source-cycle-firestore.js';
import { planSourceCycle, applySourceCycle, OPTIONS_REWRITE_CAP } from '../src/application/source-cycle.js';
import { compactRaw, compactRecord, type SourceProductRecord } from '../src/domain/source-engine.js';

// 손오공 API 옵션 → 상품 문서 api_options_* (대표 10-15 승인, 쓰기 plan). 값은 전부 합성.
const time = '2026-10-16T01:00:00.000Z', now = Date.parse('2026-10-16T01:05:00.000Z'), source = 'RP012';
const OPTIONS = [
  { category: 'SAFETY', name: '전방 충돌방지', amount: null },
  { category: '선택옵션', name: '파노라마 선루프', amount: 1_200_000 },
  { category: '선택옵션', name: '패키지', amount: null },
];
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const rec = (plate: string, options: unknown = OPTIONS, rent = 500000): SourceProductRecord => ({ sourceId: source, uid: plate, plate, vehicleText: '합성 차명',
  status: { raw: '출고가능', saleAvailable: true }, observedAt: time, vehicleHold: [],
  raw: { source: 'sonogong-partner-api', product_type: '중고렌트', ...(options === null ? {} : { detail: { options, description: '비공개 메모' } }) },
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
async function setup(writeApiOptions = true) {
  const dir = await mkdtemp(join(tmpdir(), 'sonogong-options-')); dirs.push(dir);
  const fake = fakeFirestore();
  const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
    supplierDefaults: { RP012: { provider_name: '합성손오공', policy_code: 'SYNTHETIC_POLICY' } }, writeApiOptions });
  return { commands, fake };
}
const run = async (commands: Awaited<ReturnType<typeof setup>>['commands'], records: SourceProductRecord[]) => {
  const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records, observedAt: time, heldCount: 0, complete: true },
    await commands.list(source), now);
  const applied = built.plan.entries.length ? await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now }) : null;
  return { kinds: built.plan.entries.map(e => e.kind), warnings: built.plan.warnings, applied };
};
/** 이번 변경 전에 쓰인 문서: api_options_* 칸이 없고, 저장 기록의 detail 은 digest 형태. */
const legacyDoc = (r: SourceProductRecord) => {
  const fields = nativeCycleFields({ record: compactRecord(r), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null },
    { car_number: r.plate, provider_company_code: source, provider_name: '합성손오공' });
  for (const k of Object.keys(fields)) if (k.startsWith('api_options_')) delete fields[k];
  return { provider_name: '합성손오공', ...fields, source_cycle_record: { ...compactRecord(r), raw: compactRaw(r.raw) } };
};

describe('apiOptionFields(손오공 API 옵션 → 새 칸)', () => {
  it('상세 옵션을 기본/유상으로 나눠 새 칸에 싣고 digest·관측 시각을 남긴다', () => {
    const f = apiOptionFields(rec('12가1', OPTIONS), {});
    expect(f.api_options_basic).toEqual([{ category: 'SAFETY', name: '전방 충돌방지' }]);
    expect(f.api_options_paid).toEqual([
      { name: '파노라마 선루프', amount_krw: 1_200_000, amount_state: 'KNOWN', amount_raw: 1_200_000 },
      { name: '패키지', amount_krw: null, amount_state: 'UNKNOWN', amount_raw: null },
    ]);
    expect(f).toMatchObject({ api_options_state: 'PRESENT', api_options_source: 'RP012-api', api_options_observed_at: time, api_options_unclassified_count: 0 });
    expect(typeof f.api_options_digest).toBe('string');
    expect(JSON.stringify(f)).not.toContain('비공개 메모');   // description 은 옮기지 않는다
    expect(apiOptionFields(rec('12가1', []), {})).toMatchObject({ api_options_state: 'NONE', api_options_basic: [], api_options_paid: [] });
  });

  it('상세가 없거나 options 가 배열이 아니면 기존 옵션을 지우지 않는다(표식만, 한 번)', () => {
    expect(apiOptionFields(rec('12가2', null), {})).toEqual({ api_options_state: 'NO_DETAIL', api_options_observed_at: time });
    expect(apiOptionFields(rec('12가2', 'x'), {})).toMatchObject({ api_options_state: 'NO_DETAIL' });
    expect(apiOptionFields(rec('12가2', null), { api_options_state: 'PRESENT' })).toEqual({});
  });

  it('다른 원천은 쓰지 않고, 너무 많은 항목은 목록을 싣지 않는다', () => {
    expect(apiOptionFields({ ...rec('12가3'), sourceId: 'RP006' }, {})).toEqual({});
    const many = Array.from({ length: API_OPTIONS_MAX_ITEMS + 1 }, (_, i) => ({ category: 'SAFETY', name: `옵션${i}`, amount: null }));
    expect(apiOptionFields(rec('12가3', many), {})).toEqual({ api_options_state: 'TOO_MANY', api_options_observed_at: time });
  });
});

describe('저장 기록의 옵션은 분류 후·제한된 꼴만 (Codex #674)', () => {
  it('압축 레코드에는 미분류 이름·원문 금액 전체가 들어가지 않는다', () => {
    const r = rec('12가4', [...OPTIONS, { category: '12가3456 알수없음', name: '미분류 이름 XYZ', amount: 777000 }]);
    const compact = compactRecord(r);
    expect(compact.raw.api_options).toMatchObject({ state: 'PRESENT', unclassified_count: 1 });
    const text = JSON.stringify(compact.raw);
    expect(text).not.toContain('미분류 이름 XYZ');
    expect(text).not.toContain('12가3456');
    expect(text).not.toContain('777000');
    // 압축된 기록을 다시 압축해도 같고(멱등), 쓰기 칸도 같다.
    expect(compactRecord(compact).raw.api_options).toEqual(compact.raw.api_options);
    expect(apiOptionFields(compact, {})).toMatchObject({ api_options_state: 'PRESENT' });
  });

  it('300개 초과는 압축 전에 TOO_MANY 로 판정된다(NO_DETAIL 로 둔갑하지 않음)', () => {
    const many = Array.from({ length: 301 }, (_, i) => ({ category: 'SAFETY', name: `옵션${i}`, amount: null }));
    const compact = compactRecord(rec('12가5', many));
    expect(compact.raw.api_options).toEqual({ state: 'TOO_MANY', basic: [], paid: [], unclassified_count: 0 });
    expect(apiOptionFields(compact, {})).toEqual({ api_options_state: 'TOO_MANY', api_options_observed_at: time });
  });

  it('이름이 너무 길거나 직렬화가 크면 목록을 싣지 않는다', () => {
    const long = [{ category: 'SAFETY', name: 'ㅁ'.repeat(121), amount: null }];
    expect(compactRecord(rec('12가6', long)).raw.api_options).toMatchObject({ state: 'TOO_MANY' });
    const bigRaw = [{ category: '선택옵션', name: '정상', amount: 'x'.repeat(5000) }];
    expect(compactRecord(rec('12가6', bigRaw)).raw.api_options).toMatchObject({ state: 'PRESENT' });
    expect(JSON.stringify(compactRecord(rec('12가6', bigRaw)).raw.api_options)).not.toContain('xxxxxxxx');
  });

  it('저장 형태가 깨졌거나 모양이 맞지 않으면 읽지 않는다', () => {
    const base = rec('12가7');
    expect(apiOptionFields({ ...base, raw: { api_options: { state: 'PRESENT', basic: [{ name: 3 }], paid: [] } } }, {})).toEqual({ api_options_state: 'NO_DETAIL', api_options_observed_at: time });
    expect(apiOptionFields({ ...base, raw: { api_options: 'x' } }, {})).toMatchObject({ api_options_state: 'NO_DETAIL' });
  });
});

describe('API 옵션 쓰기 게이트(대표 승인 전 기본 꺼짐)', () => {
  it('플래그가 꺼져 있으면 사유도 쓰기도 없다 — 옵션 칸이 없는 문서·새 문서 모두', async () => {
    const { commands, fake } = await setup(false);
    fake.put('12가9001', legacyDoc(rec('12가9001')));
    const first = await run(commands, [rec('12가9001')]);
    expect(first.kinds).toEqual([]);
    expect(first.warnings.some(w => w.startsWith('API_OPTIONS_'))).toBe(false);
    expect(decodeFields(fake.docs.get('12가9001').fields)).not.toHaveProperty('api_options_state');
    const enrolled = await run(commands, [rec('12가9001'), rec('12가9002')]);
    expect(enrolled.kinds).toEqual(['ENROLL']);
    expect(decodeFields(fake.docs.get('12가9002').fields)).not.toHaveProperty('api_options_state');
    // 기본 호출(옵션 인자 없음)도 꺼짐
    const fields = nativeCycleFields({ record: compactRecord(rec('12가9003')), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null }, {});
    expect(fields).not.toHaveProperty('api_options_state');
  });
});

describe('API_OPTIONS 쓰기(plan → 적용)', () => {
  it('새 문서는 편입할 때 옵션 칸도 함께 쓴다', async () => {
    const { commands, fake } = await setup();
    expect((await run(commands, [rec('12가2001')])).kinds).toEqual(['ENROLL']);
    expect(decodeFields(fake.docs.get('12가2001').fields)).toMatchObject({ api_options_state: 'PRESENT' });
  });

  it('옵션 칸이 한 번도 없던 노출 문서는 한 번 채우고 되풀이하지 않으며, 다른 칸·사람 입력 칸을 건드리지 않는다', async () => {
    const { commands, fake } = await setup();
    const legacy = { ...legacyDoc(rec('12가2002')), options: '사람이 적은 옵션 원문', 정제옵션: '사람이 정리' };
    fake.put('12가2002', legacy);
    const first = await run(commands, [rec('12가2002')]);
    expect(first.kinds).toEqual(['UPDATE']);
    expect(first.warnings).toContain('API_OPTIONS_REWRITE:1');
    const written = decodeFields(fake.docs.get('12가2002').fields);
    expect(written).toMatchObject({ api_options_state: 'PRESENT', options: '사람이 적은 옵션 원문', 정제옵션: '사람이 정리' });
    expect((await run(commands, [rec('12가2002')])).kinds).toEqual([]);
  });

  it('상세가 빠진 회차는 이미 채워진 옵션을 지우지 않는다', async () => {
    const { commands, fake } = await setup();
    await run(commands, [rec('12가2003')]);
    await run(commands, [rec('12가2003', null, 510000)]);
    expect(decodeFields(fake.docs.get('12가2003').fields)).toMatchObject({ api_options_state: 'PRESENT', price: { 36: { rent: 510000 } } });
  });

  it('옵션만 채우는 다시 쓰기는 회차당 상한까지, 나머지는 다음 회차로 이월한다', async () => {
    const { commands, fake } = await setup();
    const total = OPTIONS_REWRITE_CAP + 5, plates = Array.from({ length: total }, (_, i) => `12가${String(3000 + i)}`);
    for (const p of plates) fake.put(p, legacyDoc(rec(p)));
    const records = plates.map(p => rec(p));
    const first = await run(commands, records);
    expect(first.kinds).toHaveLength(OPTIONS_REWRITE_CAP);
    expect(first.warnings).toContain(`API_OPTIONS_DEFERRED:5:cap${OPTIONS_REWRITE_CAP}`);
    const second = await run(commands, records);
    expect(second.kinds).toHaveLength(5);
    expect((await run(commands, records)).kinds).toEqual([]);
  }, 60_000);

  it('다른 쓰기(가격 변경)가 있으면 그만큼 옵션 전용 쓰기가 줄어 회차 전체 쓰기가 상한을 넘지 않는다', async () => {
    const { commands, fake } = await setup();
    const total = OPTIONS_REWRITE_CAP + 20, plates = Array.from({ length: total }, (_, i) => `34나${String(5000 + i)}`);
    for (const p of plates) fake.put(p, legacyDoc(rec(p)));
    const changed = 30;   // 가격이 바뀐 문서(원천 변경과 옵션 사유가 겹침 — 어느 쪽이든 쓰기 1건)
    const records = plates.map((p, i) => rec(p, OPTIONS, i < changed ? 510000 : 500000));
    const first = await run(commands, records);
    expect(first.kinds.length).toBeLessThanOrEqual(OPTIONS_REWRITE_CAP);
    expect(first.warnings.some(w => w.startsWith('API_OPTIONS_DEFERRED:'))).toBe(true);
    expect(first.kinds.length).toBeGreaterThanOrEqual(changed);
  }, 60_000);
});

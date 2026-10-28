import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sheetFactsOf, validSheetFacts, sheetFactPlan, sheetFactFields, sheetFactState, isBlankFact } from '../src/domain/sheet-facts.js';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
import { planSourceCycle, applySourceCycle } from '../src/application/source-cycle.js';
import { compactRecord, comparableRecord, type SourceProductRecord } from '../src/domain/source-engine.js';

// 대표 2026-10-23 설계안 승인: 시트의 구동방식·원산지를 기존 칸(drive_type·origin)에 «빈 칸에만» 채운다. 기본 꺼짐, 공급사·칸을 켠 경우에만.
const time = '2026-10-23T00:00:00.000Z', now = Date.parse('2026-10-23T00:05:00.000Z'), source = 'RP013';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
function rec(plate: string, raw: Record<string, unknown> = {}, observedAt = time): SourceProductRecord {
  return { sourceId: source, uid: plate, plate, vehicleText: '합성 차량', status: { raw: '출고가능', saleAvailable: true }, observedAt, vehicleHold: [],
    raw: { source: 'shared-sheet', ...raw }, terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'ZERO', value: 0 }, mileage: null, raw: {} }] };
}

describe('시트 사실 후보(구동방식·원산지) 순수 로직', () => {
  const headers = ['회사명', '차량번호', '구동방식', '원산지'];
  it('헤더 이름으로 읽고 허용 값만 담는다(열 위치 무관)', () => {
    expect(sheetFactsOf(headers, ['x', '1', '2wd', '국산'])).toEqual({ drive_type: '2WD', origin: '국산' });
    expect(sheetFactsOf(['원산지', '구동방식'], ['수입', 'AWD'])).toEqual({ origin: '수입', drive_type: 'AWD' });
    expect(sheetFactsOf(headers, ['x', '1', '전륜', '일본'])).toBeUndefined();
    expect(sheetFactsOf(['차량번호'], ['1'])).toBeUndefined();
    expect(validSheetFacts({ drive_type: '4WD', origin: '??', extra: 1 })).toEqual({ drive_type: '4WD' });
  });
  it('빈 칸은 없음·null·공백만 — 0·false·[] 는 빈 칸이 아니다', () => {
    for (const v of [undefined, null, '', '  ']) expect(isBlankFact(v)).toBe(true);
    for (const v of [0, false, [], 'AWD']) expect(isBlankFact(v)).toBe(false);
  });
  it('계획: 비어 있으면 채움, 같은 값이면 아무 것도 아님, 다른 값이면 충돌(쓰지 않음)', () => {
    const state = sheetFactState({ drive_type: '', origin: '국산' }, ['drive_type', 'origin']);
    expect(state).toEqual({ drive_type: null, origin: '국산' });
    expect(sheetFactPlan(state, { drive_type: 'AWD', origin: '수입' }, ['drive_type', 'origin'])).toEqual({ fill: ['drive_type'], conflicts: ['origin'] });
    expect(sheetFactPlan(state, { origin: '국산' }, ['drive_type', 'origin'])).toEqual({ fill: [], conflicts: [] });
    expect(sheetFactPlan(undefined, { drive_type: 'AWD' }, ['drive_type'])).toEqual({ fill: [], conflicts: [] });
  });
  it('쓰기 칸: 켠 칸만, 지금 비어 있을 때만', () => {
    expect(sheetFactFields({ drive_type: 'AWD', origin: '수입' }, { drive_type: '', origin: '국산' }, ['drive_type', 'origin'])).toEqual({ drive_type: 'AWD' });
    expect(sheetFactFields({ drive_type: 'AWD' }, {}, [])).toEqual({});
  });
  it('원천 기록 압축은 후보를 값 그대로 보존하고, 변경 판정(comparableRecord)에서는 뺀다', () => {
    const r = rec('12가1', { sheet_facts: { drive_type: 'AWD' } });
    expect(compactRecord(r).raw.sheet_facts).toEqual({ drive_type: 'AWD' });
    expect('sheet_facts' in comparableRecord(r).raw).toBe(false);
  });
});

function fakeFirestore() {
  const docs = new Map<string, any>(); let version = 0; let patches = 0;
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
    if (url.searchParams.get('currentDocument.exists') === 'false' ? !!current : current?.updateTime !== url.searchParams.get('currentDocument.updateTime')) return new Response('{}', { status: 412 });
    patches++;
    const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
    const after = doc(uid, fields); docs.set(uid, after); return Response.json(after);
  }) as unknown as typeof fetch;
  return { docs, fetcher, put: (uid: string, f: Record<string, unknown>) => docs.set(uid, doc(uid, encodeFields(f as never))), patches: () => patches,
    fields: (uid: string) => decodeFields(docs.get(uid).fields) as Record<string, any> };
}
async function setup(opts: { sources?: string[]; keys?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sheet-facts-')); dirs.push(dir);
  const fake = fakeFirestore();
  const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
    ...(opts.sources ? { sheetFactSources: opts.sources } : {}), ...(opts.keys ? { sheetFactKeys: opts.keys } : {}) });
  return { commands, fake };
}
const heldDoc = (r: SourceProductRecord, extra: Record<string, unknown> = {}) => ({
  ...nativeCycleFields({ record: compactRecord(r), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null,
    supplierFields: { provider_name: '합성', policy_code: 'SYNTHETIC' } }), maker: '현대', model: '아반떼', sub_model: '아반떼 CN7', vehicle_review_required: false, ...extra });
const run = async (commands: Awaited<ReturnType<typeof setup>>['commands'], records: SourceProductRecord[]) => {
  const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records, observedAt: records[0]!.observedAt, heldCount: 0, complete: true }, await commands.list(source), now);
  const applied = built.plan.entries.length ? await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now }) : null;
  return { built, plan: built.plan, kinds: built.plan.entries.map(e => e.kind), applied };
};

describe('시트 사실 빈 칸 채움 — 계획·쓰기·되읽기', () => {
  const facts = { sheet_facts: { drive_type: 'AWD', origin: '수입' } };
  it('켠 공급사·칸의 빈 칸만 채우고 나머지 칸은 한 글자도 바꾸지 않는다, 다시 돌리면 변경 0', async () => {
    const { commands, fake } = await setup({ sources: [source], keys: ['drive_type', 'origin'] });
    fake.put('12가1001', heldDoc(rec('12가1001')));
    const before = structuredClone(fake.fields('12가1001'));
    const first = await run(commands, [rec('12가1001', facts, '2026-10-23T00:03:00.000Z')]);
    expect(first.kinds).toEqual(['UPDATE']);
    expect(first.plan.warnings).toEqual(expect.arrayContaining(['SHEET_FACT_FILL:1']));
    expect(first.applied).toMatchObject({ status: 'APPLIED', verified: 1 });
    const after = structuredClone(fake.fields('12가1001'));
    expect(after).toMatchObject({ drive_type: 'AWD', origin: '수입' });
    const changed = ['drive_type', 'origin', 'source_cycle_record', 'source_observed_at', 'source_cycle_write'];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (!changed.includes(k)) expect([k, after[k]]).toEqual([k, before[k]]);
    const patches = fake.patches();
    const second = await run(commands, [rec('12가1001', facts, '2026-10-23T00:03:00.000Z')]);
    expect(second.kinds).toEqual([]);
    expect(fake.patches()).toBe(patches);
  });
  it('이미 값이 있는 칸은 덮지 않고 충돌로 센다, 켜지 않은 칸·공급사는 쓰지 않는다', async () => {
    const a = await setup({ sources: [source], keys: ['drive_type', 'origin'] });
    a.fake.put('12가2001', heldDoc(rec('12가2001'), { drive_type: '2륜구동', origin: '국산' }));
    const b0 = structuredClone(a.fake.fields('12가2001'));
    const out = await run(a.commands, [rec('12가2001', facts)]);
    expect(out.kinds).toEqual([]);
    expect(out.plan.warnings).toContain('SHEET_FACT_CONFLICT:2');
    expect(a.fake.fields('12가2001')).toEqual(b0);
    const off = await setup();
    off.fake.put('12가2002', heldDoc(rec('12가2002')));
    expect((await run(off.commands, [rec('12가2002', facts)])).kinds).toEqual([]);
    const onlyDrive = await setup({ sources: [source], keys: ['drive_type'] });
    onlyDrive.fake.put('12가2003', heldDoc(rec('12가2003')));
    await run(onlyDrive.commands, [rec('12가2003', facts)]);
    expect(onlyDrive.fake.fields('12가2003').drive_type).toBe('AWD');
    expect(onlyDrive.fake.fields('12가2003').origin).toBeUndefined();
    const other = await setup({ sources: ['RP999'], keys: ['drive_type'] });
    other.fake.put('12가2004', heldDoc(rec('12가2004')));
    expect((await run(other.commands, [rec('12가2004', facts)])).kinds).toEqual([]);
  });
  it('비문자 기존 값(false·[]·0)도 값 있음으로 보아 덮지 않고 충돌로 센다 — 반복 UPDATE 없음', async () => {
    const { commands, fake } = await setup({ sources: [source], keys: ['drive_type'] });
    fake.put('12가4001', heldDoc(rec('12가4001'), { drive_type: false }));
    const out = await run(commands, [rec('12가4001', facts)]);
    expect(out.kinds).toEqual([]);
    expect(out.plan.warnings).toContain('SHEET_FACT_CONFLICT:1');
    expect(fake.fields('12가4001').drive_type).toBe(false);
  });
  it('계획이 고르지 않은 칸·계획 밖 문서에는 쓰지 않는다(다른 사유로 갱신돼도 sheetFactFill 이 없으면 채우지 않음)', async () => {
    const { commands, fake } = await setup({ sources: [source], keys: ['drive_type', 'origin'] });
    fake.put('12가4002', heldDoc(rec('12가4002'), { origin: '국산' }));
    const r = rec('12가4002', facts);
    r.terms[0]!.monthlyRent = { state: 'KNOWN', value: 777000 };   // 가격 변경 → 다른 사유 UPDATE
    const out = await run(commands, [r]);
    expect(out.plan.entries[0]!.after.sheetFactFill).toEqual(['drive_type']);   // 충돌인 origin 은 계획에서 빠진다
    expect(fake.fields('12가4002')).toMatchObject({ drive_type: 'AWD', origin: '국산' });
  });
  it('후보가 없거나 검증을 못 통과하면 아무 것도 쓰지 않는다', async () => {
    const { commands, fake } = await setup({ sources: [source], keys: ['drive_type', 'origin'] });
    fake.put('12가3001', heldDoc(rec('12가3001')));
    expect((await run(commands, [rec('12가3001', { sheet_facts: { drive_type: '전륜' } })])).kinds).toEqual([]);
    expect((await run(commands, [rec('12가3001')])).kinds).toEqual([]);
    expect(fake.fields('12가3001').drive_type).toBeUndefined();
  });
});

describe("시트 옵션(공개 화면에 그대로 보임) — 대표 2026-10-23 설계안 2단계", () => {
  const hdr = ["차량번호", "옵션 원문"];
  it("무정보 값·연락처·URL·보증금·수수료·내부 메모 문구·길이 초과는 후보에서 뺀다", () => {
    expect(sheetFactsOf(hdr, ["1", "컴포트, 드라이브와이즈, 내비게이션"])).toEqual({ options: "컴포트, 드라이브와이즈, 내비게이션" });
    for (const bad of ["기본", "-", "", "없음", "문의 010-1234-5678", "https://x.kr 옵션", "보증금 면제 옵션", "수수료 별도", "내부 메모 참고", "a".repeat(1001)]) expect(sheetFactsOf(hdr, ["1", bad])).toBeUndefined();
    expect(sheetFactsOf(hdr, ["1", 12345])).toBeUndefined();   // 문자열이 아니면 후보 아님
  });
  it("API 옵션을 관리하는 문서(api_options_state)는 상태에서 옵션 칸을 뺀다(채움·충돌 모두 없음)", () => {
    expect(sheetFactState({ options: "", api_options_state: "ENABLED" }, ["options"])).toEqual({});
    expect(sheetFactState({ options: "" }, ["options"])).toEqual({ options: null });
  });
  it("빈 옵션 칸에만 쓴다 — 이미 옵션이 있는 문서와 충돌은 쓰지 않는다", async () => {
    const { commands, fake } = await setup({ sources: [source], keys: ["options"] });
    fake.put("12가5001", heldDoc(rec("12가5001"), { options: "" }));
    fake.put("12가5002", heldDoc(rec("12가5002"), { options: "기존 옵션 목록" }));
    const out = await run(commands, [rec("12가5001", { sheet_facts: { options: "선루프, 내비게이션" } }), rec("12가5002", { sheet_facts: { options: "선루프, 내비게이션" } })]);
    expect(out.kinds).toEqual(["UPDATE"]);
    expect(out.plan.warnings).toEqual(expect.arrayContaining(["SHEET_FACT_FILL:1", "SHEET_FACT_CONFLICT:1"]));
    expect(fake.fields("12가5001").options).toBe("선루프, 내비게이션");
    expect(fake.fields("12가5002").options).toBe("기존 옵션 목록");
  });
});

describe("F05 자손한도 → self_body_accident (대표 2026-10-28 «맞춰주세요»·«그냥 숫자만»: 차 줄 값 우선, 총액 기준 숫자 하나)", () => {
  const hdr = ["차량번호", "자손한도", "자손면책"];
  it("F05 금액 표기를 정수 원으로, 한 금액이 아니면 후보에서 뺀다", () => {
    for (const [cell, won] of [["1억원", 100000000], ["1억5천만원", 150000000], ["5천만원", 50000000], ["1천5백만원", 15000000],
      ["1,500만원", 15000000], ["1억", 100000000], ["100,000,000", 100000000], [30000000, 30000000]] as const)
      expect(sheetFactsOf(hdr, ["1", cell, ""])).toEqual({ self_body_accident: won });
    for (const bad of ["", "-", "무한", "1억/50", "사망 1억 부상 1500만", "1억원 (1인당)", "500,000", "200억", "1,5억원", "1,,500만원", "15,00만원"]) expect(sheetFactsOf(hdr, ["1", bad, ""])).toBeUndefined();
  });
  it("소수 억은 정상 금액(«1.5억» = «1억5천만원»), 괄호는 «(총액)»·«(전체)» 만 받는다 — PC1 검토 10-28", () => {
    for (const [cell, won] of [["1.5억", 150000000], ["1.5억원", 150000000], ["0.5억", 50000000], ["1.25억", 125000000], ["2.12345678억", 212345678],
      ["1억원(총액)", 100000000], ["1억 (전체)", 100000000], ["1.5억원（총액）", 150000000], ["5천만원 (총액)", 50000000]] as const)
      expect(sheetFactsOf(hdr, ["1", cell, ""])).toEqual({ self_body_accident: won });
    expect(sheetFactsOf(hdr, ["1", "1.5억", ""])).toEqual(sheetFactsOf(hdr, ["1", "1억5천만원", ""]));
    // 총액이 아닌 괄호·괄호가 금액 앞에 오거나 둘 이상·소수 자리 초과·소수 억 뒤 만 단위·소수 만은 금액 아님 → 정책 값 표시
    for (const bad of ["1억원(1인당)", "1억(사망)", "(총액)1억", "1억(총액)(전체)", "1억(총액", "1.123456789억", "1.5억5천만", "1.5천만", "1.억", ".5억", "1.5"])
      expect(sheetFactsOf(hdr, ["1", bad, ""])).toBeUndefined();
    // 범위 경계: 1백만·100억 포함
    expect(sheetFactsOf(hdr, ["1", "100만원", ""])).toEqual({ self_body_accident: 1000000 });
    expect(sheetFactsOf(hdr, ["1", "100억", ""])).toEqual({ self_body_accident: 10000000000 });
  });
  it("엔진이 주인인 칸: 다르면 충돌이 아니라 F05 값으로 채움, 같으면 아무 것도 아님", () => {
    expect(sheetFactPlan({ self_body_accident: "15000000" }, { self_body_accident: 100000000 }, ["self_body_accident"])).toEqual({ fill: ["self_body_accident"], conflicts: [] });
    expect(sheetFactPlan({ self_body_accident: "100000000" }, { self_body_accident: 100000000 }, ["self_body_accident"])).toEqual({ fill: [], conflicts: [] });
    expect(sheetFactFields({ self_body_accident: 100000000 }, { self_body_accident: 15000000 }, ["self_body_accident"])).toEqual({ self_body_accident: 100000000 });
    // 다른 칸은 종전대로 덮지 않는다
    expect(sheetFactFields({ origin: "수입" }, { origin: "국산" }, ["origin"])).toEqual({});
  });
  it("빈 칸 채움·F05 값 변경 반영(작아져도)·문자열 값은 숫자로·같은 값은 변경 0, F05 칸이 비면 문서를 건드리지 않는다", async () => {
    const { commands, fake } = await setup({ sources: [source], keys: ["self_body_accident"] });
    fake.put("12가7001", heldDoc(rec("12가7001")));
    fake.put("12가7002", heldDoc(rec("12가7002"), { self_body_accident: 15000000 }));
    fake.put("12가7003", heldDoc(rec("12가7003")));
    fake.put("12가7004", heldDoc(rec("12가7004"), { self_body_accident: 100000000 }));
    fake.put("12가7005", heldDoc(rec("12가7005"), { self_body_accident: "100000000" }));
    fake.put("12가7006", heldDoc(rec("12가7006"), { self_body_accident: 50000000 }));
    const limit = { sheet_facts: { self_body_accident: 100000000 } };
    const low = { sheet_facts: { self_body_accident: 15000000 } };
    const records = [rec("12가7001", limit), rec("12가7002", limit), rec("12가7003"), rec("12가7004", low), rec("12가7005", limit), rec("12가7006")];
    const first = await run(commands, records);
    expect(first.plan.warnings).toEqual(expect.arrayContaining(["SHEET_FACT_FILL:4"]));
    expect(first.plan.warnings.some(w => w.startsWith("SHEET_FACT_CONFLICT"))).toBe(false);
    expect(fake.fields("12가7001").self_body_accident).toBe(100000000);
    expect(fake.fields("12가7002").self_body_accident).toBe(100000000);
    expect(fake.fields("12가7003").self_body_accident).toBeUndefined();   // F05 빈 칸 + 문서에도 없음 → 정책 값 표시
    expect(fake.fields("12가7004").self_body_accident).toBe(15000000);    // F05 가 더 작아도 F05
    expect(fake.fields("12가7005").self_body_accident).toBe(100000000);   // 문자열 → 숫자
    // 알려진 한계: 한 번 쓴 값은 F05 가 칸을 비워도 지우지 않는다(후속 과제).
    expect(fake.fields("12가7006").self_body_accident).toBe(50000000);
    const patches = fake.patches();
    expect((await run(commands, records)).kinds).toEqual([]);
    expect(fake.patches()).toBe(patches);
  });
  it("켜지 않은 칸·공급사, 계약 잠금 문서에는 쓰지 않는다", async () => {
    const limit = { sheet_facts: { self_body_accident: 100000000 } };
    const off = await setup({ sources: [source], keys: ["origin"] });
    off.fake.put("12가7101", heldDoc(rec("12가7101"), { self_body_accident: 15000000 }));
    expect((await run(off.commands, [rec("12가7101", limit)])).kinds).toEqual([]);
    expect(off.fake.fields("12가7101").self_body_accident).toBe(15000000);
    const locked = await setup({ sources: [source], keys: ["self_body_accident"] });
    locked.fake.put("12가7102", heldDoc(rec("12가7102"), { self_body_accident: 15000000, locked_by_contract: true }));
    await run(locked.commands, [rec("12가7102", limit)]);
    expect(locked.fake.fields("12가7102").self_body_accident).toBe(15000000);
  });
});

describe("시트 차량가격 → consumer_price (대표 2026-10-23 승인: 정수 원 5백만~3억, 세금 포함 여부는 단정하지 않음)", () => {
  const hdr = ["차량번호", "차량가격"];
  it("쉼표·원 표기를 정수로, 범위 밖·비숫자·소수는 후보에서 뺀다", () => {
    expect(sheetFactsOf(hdr, ["1", "18,650,000"])).toEqual({ consumer_price: 18650000 });
    expect(sheetFactsOf(hdr, ["1", 29800000])).toEqual({ consumer_price: 29800000 });
    expect(sheetFactsOf(hdr, ["1", "47,750,000원"])).toEqual({ consumer_price: 47750000 });
    for (const bad of ["1,500,000", "4,999,999", "300,000,001", "1865만원", "18,650,000.5", "", "미정", "-18,650,000"]) expect(sheetFactsOf(hdr, ["1", bad])).toBeUndefined();
  });
  it("빈 칸에만 숫자로 쓰고, 기존 값과 다르면 충돌(쓰지 않음), 같으면 변경 없음", async () => {
    const { commands, fake } = await setup({ sources: [source], keys: ["consumer_price"] });
    fake.put("12가6001", heldDoc(rec("12가6001")));
    fake.put("12가6002", heldDoc(rec("12가6002"), { consumer_price: 30000000 }));
    fake.put("12가6003", heldDoc(rec("12가6003"), { consumer_price: 18650000 }));
    const f = { sheet_facts: { consumer_price: 18650000 } };
    const out = await run(commands, [rec("12가6001", f), rec("12가6002", f), rec("12가6003", f)]);
    expect(out.kinds).toEqual(["UPDATE"]);
    expect(out.plan.warnings).toEqual(expect.arrayContaining(["SHEET_FACT_FILL:1", "SHEET_FACT_CONFLICT:1"]));
    expect(fake.fields("12가6001").consumer_price).toBe(18650000);
    expect(typeof fake.fields("12가6001").consumer_price).toBe("number");
    expect(fake.fields("12가6002").consumer_price).toBe(30000000);
    expect(fake.fields("12가6003").consumer_price).toBe(18650000);
  });
});

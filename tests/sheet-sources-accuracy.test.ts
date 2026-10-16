/** 시트 원천(공통 시트 F05·아이카 RP004) 데이터 정확도 결함 10건(대표 2026-10-14 «데이터만큼은 정확하게 갖고 와야 된다»).
 * 모든 값은 합성이다(번호 00가0000 꼴, 회사·차명 합성). */
import { describe, expect, it } from 'vitest';
import { f05NativeCapture, aicaNativeCapture, aicaNativePlugin } from '../src/adapters/source-cycle-native.js';
import { sourceCyclePlugin, AICA_SCOPES, type CycleCapture } from '../src/adapters/source-cycle-plugins.js';
import { sharedSheetChannels, sharedSheetHeaders, type SharedSheetCapture, type SheetCell } from '../src/adapters/shared-sheet-source.js';
import { planSourceCycle } from '../src/application/source-cycle.js';
import { validateSourceRecord, type SourceProductRecord } from '../src/domain/source-engine.js';
import { isNoPriceText, isPlausibleMonthlyRent, MONTHLY_RENT_MIN, MONTHLY_RENT_MAX, NO_PRICE_TEXTS } from '../src/domain/source-rent-text.js';
import { isValidSheetPlate, isAssignedPlate } from '../src/domain/vehicle-plate.js';
import { judgeSheetCount } from '../src/adapters/sheet-count-guard.js';
import { resolveSheetsTransport } from '../src/infra/shared-sheet-capture-reader.js';
import { unattendedPreflight } from '../src/runtime/source-cycle-runtime.js';
import type { CycleProduct } from '../src/ports/source-cycle.js';

const time = '2026-10-14T00:00:00.000Z', now = Date.parse(time);

function sheet(rows: Array<Record<string, SheetCell>>) {
  const channel = sharedSheetChannels[0]!, headers = [...sharedSheetHeaders, 'UID'];
  const capture: SharedSheetCapture = { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-only', layoutVersion: '2026-10-04-no-account',
    readTime: time, revision: 'synthetic', tabs: [...new Set(sharedSheetChannels.map(c => c.tab))].map(title => {
      const values = [headers, ...(title === channel.tab ? rows.map(row => headers.map(h => ({ 회사명: channel.companyName,
        차량번호: '00가1001', 차량상태: '출고가능', 상품구분: '중고렌트', '12개월': 500000, 단기보증: '무보증', 장기보증: '무보증',
        연주행: '20000km', '차명 원문': '합성', ...row } as Record<string, SheetCell>)[h] ?? '')) : [])];
      return { title, readTime: time, complete: true, rowCount: values.length, values };
    }) };
  const visibility = { sheets: capture.tabs.map(t => ({ properties: { title: t.title, gridProperties: { rowCount: t.rowCount } },
    data: [{ startRow: 0, rowMetadata: t.values.map(() => ({} as { hiddenByUser?: boolean; hiddenByFilter?: boolean })) }] })) };
  return { capture, visibility, source: channel.code };
}
const f05 = (rows: Array<Record<string, SheetCell>>) => { const s = sheet(rows); return { ...s, c: f05NativeCapture(s.source, s.capture, s.visibility) }; };
/** 엔진 플러그인(상태 판정 포함)으로 F05 캡처를 레코드로 바꾼다. */
async function f05Records(rows: Array<Record<string, SheetCell>>) {
  const { c, source } = f05(rows);
  const scopes = [...new Set(sharedSheetChannels.filter(ch => ch.code === source).map(ch => ch.tab))];
  const plugin = sourceCyclePlugin({ sourceId: source, kind: 'F05', scopes, maxDowngradeRatio: 1 }, async () => c, () => time);
  return { c, source, ...plugin.toRecords(await plugin.read()) };
}

const aicaHeaders = ['배차상태', '구분', '차량번호', '차급', '차종분류', '트림', '연료', '외장', '내장', 'Km', '월렌트', '장기보증',
  '36개월', '48개월', '60개월', '옵션', '최초등록', '소비자가격', '제조사', '배기량', '연주행', '대인', '대물', '자차', '자손'];
const aicaRow = (overrides: Record<string, unknown> = {}) => aicaHeaders.map(h => ({
  배차상태: '배차문의', 구분: '재렌트', 차량번호: '00가2001', 차급: '합성급', 차종분류: '합성모델', 트림: '합성트림',
  연료: '합성연료', 외장: '외장', 내장: '내장', Km: '12,345', 월렌트: '', 장기보증: '무보증',
  '36개월': 456000, '48개월': '', '60개월': 400000, 옵션: '', 최초등록: '2025-01', 소비자가격: '', 제조사: '합성제조사', 배기량: '',
  연주행: '3만km', 대인: '', 대물: '', 자차: '', 자손: '', ...overrides } as Record<string, unknown>)[h]);
function aica(rows: unknown[][], monthly: unknown[][] = []) {
  const tables = AICA_SCOPES.map((title, i) => ({ title, values: title === '월렌트' ? [['차종', '1개월'], ...monthly] : [aicaHeaders, ...(i === 0 ? rows : [])] }));
  const meta = { sheets: tables.map(t => ({ properties: { title: t.title, hidden: false, gridProperties: { rowCount: t.values.length } },
    data: [{ startRow: 0, rowMetadata: t.values.map(() => ({ hiddenByUser: false, hiddenByFilter: false })) }] })) };
  return { tables, meta };
}
async function aicaRecords(rows: unknown[][], monthly: unknown[][] = []) {
  const f = aica(rows, monthly), capture = aicaNativeCapture(f.tables, time, f.meta);
  const plugin = aicaNativePlugin(async () => capture, 1);
  return { capture, ...plugin.toRecords(await plugin.read()) };
}
const doc = (record: SourceProductRecord, listable = true): CycleProduct => ({ record: structuredClone(record), listable, locked_by_contract: false,
  publication_withdrawal: null, publication_withdrawal_prior: null });

describe('1. 월 대여료 0 은 0원 가격이 아니다(그 기간 가격 없음 + RENT_ZERO 건수)', () => {
  it('F05: «0»·0 기간은 빠지고 차는 다른 기간 가격으로 판매 가능, 0 만 있으면 가격 없음(TERMS_HOLD)', async () => {
    const { c, records } = await f05Records([{ 차량번호: '00가1001', '24개월': '0', '36개월': 0 }, { 차량번호: '00가1002', '12개월': '0원' }]);
    const [a, b] = records;
    expect(a!.terms.map(t => [t.months, t.monthlyRent])).toEqual([[12, { state: 'KNOWN', value: 500000 }]]);
    expect(a!.status.saleAvailable).toBe(true); expect(validateSourceRecord(a!)).toEqual([]);
    expect(b!.terms).toEqual([]); expect(validateSourceRecord(b!)).toContain('TERMS_HOLD');
    expect(c.notes).toEqual(['RENT_ZERO:3']);
    expect(records.flatMap(r => r.terms).some(t => t.monthlyRent.state === 'ZERO')).toBe(false);
  });
  it('아이카: 숫자 0·«0» 기간은 빠지고(RENT_ZERO), 월렌트 0 은 제안 없음', async () => {
    const out = await aicaRecords([aicaRow({ '36개월': 0, '60개월': '0' }), aicaRow({ 차량번호: '00가2002', '36개월': 0 })], [['합성 월렌트', 0]]);
    const [a, b] = out.records;
    expect(a!.terms).toEqual([]); expect(b!.terms.map(t => [t.months, t.monthlyRent.value])).toEqual([[60, 400000]]);
    expect(out.records.filter(r => r.raw.product_group === 'MONTHLY_RENT')).toEqual([]);
    expect(out.capture.notes).toEqual(['RENT_ZERO:4']);
    expect(out.held).toEqual([]);   // 0 은 «가격 없음» 이라 보류가 아니다(«-» 와 같다)
  });
  it('도메인 방어: ZERO 대여료 기록은 어느 원천이든 TERMS_HOLD(판매 가격 아님)', () => {
    const r: SourceProductRecord = { sourceId: 'SYNTHETIC', uid: '00가1001', plate: '00가1001', vehicleText: '합성', status: { raw: '출고가능', saleAvailable: true },
      terms: [{ months: 12, monthlyRent: { state: 'ZERO', value: 0 }, deposit: { state: 'ZERO', value: 0 }, mileage: null, raw: {} }],
      observedAt: time, raw: {}, vehicleHold: [] };
    expect(validateSourceRecord(r)).toContain('TERMS_HOLD');
  });
});

describe('2. 월 대여료 타당 범위(10만~5천만원, 공용 상수)', () => {
  it('공용 상수는 오토플러스 시트·홈피와 같은 값이다', () => {
    expect([MONTHLY_RENT_MIN, MONTHLY_RENT_MAX]).toEqual([100_000, 50_000_000]);
    expect([99_999, 100_000, 50_000_000, 50_000_001].map(isPlausibleMonthlyRent)).toEqual([false, true, true, false]);
  });
  it('F05: «65»(만원을 숫자로) 는 65원으로 노출하지 않고 RENT_REVIEW_REQUIRED 보류(×10000 추정 없음)', async () => {
    const { c, records } = await f05Records([{ 차량번호: '00가1001', '24개월': '65' }, { 차량번호: '00가1002', '12개월': '60,000,000' }]);
    expect(records.flatMap(r => r.terms).some(t => t.monthlyRent.value === 65 || t.monthlyRent.value === 650000)).toBe(false);
    for (const r of records) expect(validateSourceRecord(r)).toContain('TERMS_HOLD');
    expect(c.heldReasons).toEqual(['TERMS_HOLD,RENT_REVIEW_REQUIRED', 'TERMS_HOLD,RENT_REVIEW_REQUIRED']);
  });
  it('아이카: 범위 밖 숫자는 UNKNOWN(TERMS_HOLD) + RENT_REVIEW_REQUIRED, 월렌트는 그룹 보류', async () => {
    const out = await aicaRecords([aicaRow({ '36개월': 65 })], [['합성 월렌트', '70']]);
    expect(out.records[0]!.terms.find(t => t.months === 36)!.monthlyRent).toEqual({ state: 'UNKNOWN', value: null });
    expect(validateSourceRecord(out.records[0]!)).toContain('TERMS_HOLD');
    expect(out.capture.heldReasons).toEqual(['MONTHLY_RENT_UNPARSEABLE', 'RENT_REVIEW_REQUIRED']);
  });
  it('보류된 행의 기존 문서는 기존 가격을 지키고(TERMS_HOLD) 다른 차의 부재 하향을 막지 않는다(값 계열 보류)', async () => {
    const { records } = await f05Records([{ 차량번호: '00가1001', '12개월': '65' }]);
    const prior = structuredClone(records[0]!); prior.terms = [{ months: 12, monthlyRent: { state: 'KNOWN', value: 650000 }, deposit: { state: 'ZERO', value: 0 }, mileage: '20000km', raw: {} }];
    prior.observedAt = '2026-10-13T00:00:00.000Z';
    const plan = planSourceCycle({ sourceId: records[0]!.sourceId, family: 'SHARED_SHEET', maxDowngradeRatio: 1 },
      { records, complete: true, observedAt: time, heldCount: 1, benignHeldCount: 1 }, { complete: true, products: [doc(prior)] }, now).plan;
    expect(plan.entries.map(e => e.after.record.terms.map(t => t.monthlyRent.value))).toEqual([[650000]]);
  });
});

describe('3. 아이카 연주행 숫자 칸(UNFORMATTED 읽기)', () => {
  it('숫자 20000 도 문자열과 같게 약정거리로 남는다', async () => {
    const out = await aicaRecords([aicaRow({ 연주행: 20000 }), aicaRow({ 차량번호: '00가2002', 연주행: '2만km' })]);
    expect(out.records.map(r => r.terms.map(t => t.mileage))).toEqual([['20000', '20000'], ['2만km', '2만km']]);
  });
});

describe('4. 필터로 가려진 행은 데이터다(부재 하향 금지)', () => {
  it('F05·아이카 모두 hiddenByFilter 행을 그대로 읽는다', async () => {
    const s = sheet([{ 차량번호: '00가1001' }]);
    s.visibility.sheets.find(t => t.properties.title === s.capture.tabs.find(t => t.rowCount > 1)!.title)!.data[0]!.rowMetadata[1]!.hiddenByFilter = true;
    expect(f05NativeCapture(s.source, s.capture, s.visibility).rows.map(r => r.record.uid)).toEqual(['00가1001']);
    const f = aica([aicaRow()]); f.meta.sheets[0]!.data[0]!.rowMetadata[1]!.hiddenByFilter = true;
    expect(aicaNativeCapture(f.tables, time, f.meta).rows.map(r => r.record.plate)).toEqual(['00가2001']);
  });
});

describe('5. 드롭다운 상태값', () => {
  it.each(['인도완료', '출고완료', '판매완료', '출고불가'])('F05·아이카 «%s» 는 판매 불가(노출 문서는 SOURCE_NOT_SELLABLE 로 하향)', async status => {
    const f = await f05Records([{ 차량상태: status }]);
    expect(f.records[0]!.status.saleAvailable).toBe(false);
    const a = await aicaRecords([aicaRow({ 배차상태: status })]);
    expect(a.records[0]!.status.saleAvailable).toBe(false);
    const prior = structuredClone(f.records[0]!); prior.status = { raw: '출고가능', saleAvailable: true }; prior.observedAt = '2026-10-13T00:00:00.000Z';
    const plan = planSourceCycle({ sourceId: prior.sourceId, family: 'SHARED_SHEET', maxDowngradeRatio: 1 },
      { records: f.records, complete: true, observedAt: time, heldCount: 0 }, { complete: true, products: [doc(prior)] }, now).plan;
    expect(plan.entries.map(e => [e.kind, e.after.publication_withdrawal?.reason])).toEqual([['DOWNGRADE', 'SOURCE_NOT_SELLABLE']]);
  });
  it.each(['취소', '진행중'])('«%s» 는 추정하지 않는다: 노출 문서는 보류로 남되 STATUS_UNKNOWN 보류·STATUS_UNKNOWN_EXPOSED 경고로 드러난다', async status => {
    const f = await f05Records([{ 차량상태: status }]);
    expect(f.records[0]!.status.saleAvailable).toBeNull();
    const prior = structuredClone(f.records[0]!); prior.status = { raw: '출고가능', saleAvailable: true }; prior.observedAt = '2026-10-13T00:00:00.000Z';
    const built = planSourceCycle({ sourceId: prior.sourceId, family: 'SHARED_SHEET', maxDowngradeRatio: 1 },
      { records: f.records, complete: true, observedAt: time, heldCount: 0 }, { complete: true, products: [doc(prior)] }, now);
    expect(built.plan.entries).toEqual([]);
    expect(built.heldReasons).toEqual({ STATUS_UNKNOWN: 1 });
    expect(built.plan.warnings).toContain('STATUS_UNKNOWN_EXPOSED:1');
  });
});

describe('6. 같은 번호가 다른 공급사 문서에 있으면 그 행만 보류(회차는 진행)', () => {
  it('foreignUids 에 있는 번호는 ENROLL 대신 PLATE_OWNED_BY_OTHER_SUPPLIER, 나머지는 편입', async () => {
    const { records, source } = await f05Records([{ 차량번호: '00가1001' }, { 차량번호: '00가1002' }]);
    const built = planSourceCycle({ sourceId: source, family: 'SHARED_SHEET', maxDowngradeRatio: 1 },
      { records, complete: true, observedAt: time, heldCount: 0 }, { complete: true, products: [], foreignUids: ['00가1001'] }, now);
    expect(built.plan.entries.map(e => [e.kind, e.after.record.uid])).toEqual([['ENROLL', '00가1002']]);
    expect(built.heldReasons).toEqual({ PLATE_OWNED_BY_OTHER_SUPPLIER: 1 });
    expect(built.plan.blockers).toEqual([]);
  });
  it('자기 문서가 있으면(같은 공급사) 다른 공급사 목록과 무관하게 갱신한다', async () => {
    const { records, source } = await f05Records([{ 차량번호: '00가1001', '12개월': 520000 }]);
    const prior = structuredClone(records[0]!); prior.terms[0]!.monthlyRent = { state: 'KNOWN', value: 500000 }; prior.observedAt = '2026-10-13T00:00:00.000Z';
    const built = planSourceCycle({ sourceId: source, family: 'SHARED_SHEET', maxDowngradeRatio: 1 },
      { records, complete: true, observedAt: time, heldCount: 0 }, { complete: true, products: [doc(prior)], foreignUids: ['00가1001'] }, now);
    expect(built.plan.entries.map(e => e.kind)).toEqual(['UPDATE']);
  });
});

describe('7. 번호 칸 검증(문서 ID 는 번호 모양만)', () => {
  it('엄격 판정: 번호 모양만 참, «신차(11/5)» 처럼 숫자만 섞인 글은 거짓(공용 isAssignedPlate 는 그대로)', () => {
    expect(['12가3456', '123가4567', ' 12 가 3456 ', '서울12가3456'].map(isValidSheetPlate)).toEqual([true, true, true, true]);
    expect(['신차(11/5)', '12-3456', '12가345', 'TEST1001', '신차', ''].map(isValidSheetPlate)).toEqual([false, false, false, false, false, false]);
    expect(isAssignedPlate('신차(11/5)')).toBe(true);
  });
  it('F05: 잘못된 번호는 PLATE_INVALID 보류(문서 ID 로 쓰지 않음), 숫자 없는 «신차» 는 기존대로 지문 키', () => {
    const { c } = f05([{ 차량번호: '신차(11/5)' }, { 차량번호: '신차', '차명 원문': '합성 신차' }, { 차량번호: '00가1003' }]);
    expect(c.rows.map(r => r.record.uid)).toEqual([expect.stringMatching(/^FP-/), '00가1003']);
    expect(c.heldReasons).toEqual(['PLATE_INVALID']);
  });
  it('아이카: 잘못된 번호는 PLATE_INVALID 보류', async () => {
    const out = await aicaRecords([aicaRow({ 차량번호: '신차(11/5)' }), aicaRow({ 차량번호: '00가2002' })]);
    expect(out.records.map(r => r.uid)).toEqual(['00가2002']);
    expect(out.capture.heldReasons).toEqual(['PLATE_INVALID']);
  });
});

describe('8. «가격 없음» 낱말 공용 목록(F05·아이카 같음)', () => {
  it('목록', () => {
    expect([...NO_PRICE_TEXTS]).toEqual(['', '-', '--', '—', '–', '불가', 'X', '없음', 'N/A', '협의', '문의']);
    expect(['x', ' n/a ', '협의', '문의', '없음', null, undefined].every(isNoPriceText)).toBe(true);
    expect(['65', '0', '무보증', 0].some(isNoPriceText)).toBe(false);
  });
  it.each(['없음', 'x', 'N/A', '협의', '문의'])('F05 «%s» 기간은 빠지고 차는 판매 가능(TERMS_HOLD → 하향 없음)', async text => {
    const { records } = await f05Records([{ '24개월': text }]);
    expect(records[0]!.terms.map(t => t.months)).toEqual([12]);
    expect(validateSourceRecord(records[0]!)).toEqual([]); expect(records[0]!.status.saleAvailable).toBe(true);
  });
  it.each(['협의', '문의', '불가'])('아이카 «%s» 기간도 같게 빠진다', async text => {
    const out = await aicaRecords([aicaRow({ '36개월': text })]);
    expect(out.records[0]!.terms.map(t => t.months)).toEqual([60]); expect(validateSourceRecord(out.records[0]!)).toEqual([]);
  });
});

describe('9. 시트 읽기 전송 판정 하나', () => {
  it('SHEETS_TRANSPORT=gws 일 때만 gws, 그 밖은 ADC(런타임·읽기 모듈 같은 기본값)', () => {
    expect(resolveSheetsTransport({})).toBe('adc');
    expect(resolveSheetsTransport({ SHEETS_TRANSPORT: 'gws' })).toBe('gws');
    expect(resolveSheetsTransport({ SHEETS_TRANSPORT: ' gws ' })).toBe('gws');
    expect(resolveSheetsTransport({ SHEETS_TRANSPORT: 'adc' })).toBe('adc');
  });
  it('무인 회차 사전점검은 아이카·오토플러스 시트만 켜도 전송 명시를 요구한다', async () => {
    const probes = { gwsBin: () => 'gws', gcloudToken: async () => 'synthetic' };
    expect(await unattendedPreflight({}, ['AICA'], probes)).toEqual(['PREFLIGHT_SHEETS_TRANSPORT_UNSET']);
    expect(await unattendedPreflight({ SOURCE_CYCLE_AUTOPLUS_SHEET: '1' }, ['AUTOPLUS'], probes)).toEqual(['PREFLIGHT_SHEETS_TRANSPORT_UNSET']);
    expect(await unattendedPreflight({}, ['AUTOPLUS'], probes)).toEqual([]);
    expect(await unattendedPreflight({ SHEETS_TRANSPORT: 'gws' }, ['AICA'], probes)).toEqual([]);
  });
});

describe('10. 급감 하한(SOURCE_SHRUNK)', () => {
  const judge = (rows: number, previousCount: number, exposedUnlockedDocs: number, stateError: string | null = null, complete = true) =>
    judgeSheetCount({ complete, rows, previousCount, exposedUnlockedDocs, stateError });
  it('직전 정상 수 80% «그리고» 잠금 제외 노출 80% 를 둘 다 밑돌면 불완전, 기준을 저장하지 않는다', () => {
    expect(judge(70, 100, 100)).toEqual({ complete: false, incompleteReason: 'SOURCE_SHRUNK', saveCount: null });
    expect(judge(70, 100, 50)).toEqual({ complete: true, saveCount: 70 });          // 노출 문서가 적으면 정상
    expect(judge(70, 60, 100)).toEqual({ complete: true, saveCount: 70 });          // 직전보다 늘었으면 정상
    expect(judge(80, 100, 100)).toEqual({ complete: true, saveCount: 80 });         // 경계 80% 는 통과
  });
  it('최초(기준 없음)는 노출 문서 기준만: 빈 읽기가 노출 전부를 부재로 내리지 않는다', () => {
    expect(judge(0, 0, 30)).toEqual({ complete: false, incompleteReason: 'SOURCE_SHRUNK', saveCount: null });
    expect(judge(0, 0, 0)).toEqual({ complete: true, saveCount: 0 });
  });
  it('기준 파일 손상은 이번 회차만 불완전, 그럴듯한 수면 기준을 복구한다', () => {
    expect(judge(90, 0, 100, 'SHEET_COUNT_STATE_INVALID')).toEqual({ complete: false, incompleteReason: 'SHEET_COUNT_STATE_INVALID', saveCount: 90 });
    expect(judge(10, 0, 100, 'SHEET_COUNT_STATE_INVALID')).toEqual({ complete: false, incompleteReason: 'SHEET_COUNT_STATE_INVALID', saveCount: null });
  });
  it('이미 불완전한 읽기는 그대로 두고 저장하지 않는다', () => {
    expect(judge(100, 100, 100, null, false)).toEqual({ complete: false, saveCount: null });
  });
  it('엔진: SOURCE_SHRUNK 캡처는 PARTIAL 읽기라 계획이 SOURCE_INCOMPLETE 로 막힌다', async () => {
    const capture: CycleCapture = { observedAt: time, complete: false, incompleteReason: 'SOURCE_SHRUNK', completedScopes: [...AICA_SCOPES],
      visibilityComplete: true, rows: [], heldCount: 0 };
    const read = await aicaNativePlugin(async () => capture, 1).read();
    expect([read.complete, read.error, read.detail]).toEqual([false, 'PARTIAL', 'SOURCE_SHRUNK']);
  });
});

import { describe, expect, it } from 'vitest';
import { f05NativeCapture, aicaNativeCapture, aicaNativePlugin } from '../src/adapters/source-cycle-native.js';
import { AICA_SCOPES } from '../src/adapters/source-cycle-plugins.js';
import { sharedSheetChannels, sharedSheetHeaders, type SharedSheetCapture, type SheetCell } from '../src/adapters/shared-sheet-source.js';
import { nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
import type { CycleProduct } from '../src/ports/source-cycle.js';

// 시트 제원 전달(대표 10-22 «pc3가 할수 있게»): 정규화기가 이미 읽은 사실만 raw.spec 으로. 연식은 기존 게이트만, 아이카는 연식을 만들지 않는다.
const time = '2026-10-22T00:00:00.000Z';
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
const goodRow: Record<string, SheetCell> = { 연료: '휘발유', 주행거리: '12,345km', 인승: '5', 배기량: '1,598cc', 최초등록일: '2023-03-15',
  외부색상: '흰색', 내부색상: '검정', 연식: 2023 };
const goodSpec = { fuel_type: '가솔린', mileage: '12345', seats: '5', engine_cc: '1598', first_registration_date: '2023-03-15', ext_color: '흰색', int_color: '검정' };
const f05 = (row: Record<string, SheetCell>, master?: Parameters<typeof f05NativeCapture>[3], on = true) => {
  const s = sheet([row]);
  return f05NativeCapture(s.source, s.capture, s.visibility, master, on ? { sheetSpec: true } : undefined).rows[0]!.record;
};

describe('A) F05 공유 시트 제원 → raw.spec', () => {
  it('켠 공급사만, 정규화기가 읽은 연료·주행거리·인승·배기량·최초등록일·색상을 기존 키로 넘기고 연식은 만들지 않는다', () => {
    const r = f05(goodRow);
    expect(r.raw.spec).toEqual(goodSpec);
    expect(r.raw.spec).not.toHaveProperty('year');
    expect(r.raw).not.toHaveProperty('spec_master_digest');
    expect(r.raw).not.toHaveProperty('spec_master_id');
    // 기본(옵션 없음)은 지금과 같다: 제원 전달 0.
    expect(f05(goodRow, undefined, false).raw).not.toHaveProperty('spec');
  });
  it('형식이 틀리거나 미확인인 값은 넣지 않는다', () => {
    const r = f05({ 연료: '합성연료', 주행거리: '약 1만', 인승: '0', 배기량: '12cc', 최초등록일: '2023-13-01', 외부색상: '확인필요', 내부색상: '12345678' });
    expect(r.raw).not.toHaveProperty('spec');
    expect(f05({ ...goodRow, 외부색상: '-', 배기량: '1.6' }).raw.spec).toEqual({ ...goodSpec, ext_color: undefined, engine_cc: undefined });
  });
  it('전기·수소는 배기량을 넘기지 않는다', () => {
    expect(f05({ ...goodRow, 연료: 'EV', 배기량: '1000' }).raw.spec).toEqual({ ...goodSpec, fuel_type: '전기', engine_cc: undefined });
    expect(f05({ ...goodRow, 연료: '수소', 배기량: '1000' }).raw.spec).not.toHaveProperty('engine_cc');
  });
  it('연식·최초등록 모순 행은 최초등록일도 연식도 넘기지 않는다', () => {
    const r = f05({ ...goodRow, 연식: 2023, 최초등록일: '2025-01' });
    expect(r.raw.spec).not.toHaveProperty('first_registration_date');
    expect(r.raw.spec).not.toHaveProperty('year');
  });
  it('기존 연식 게이트(검토 UID 목록·마스터 단일 대조)는 그대로 — 통과할 때만 연식과 마스터 근거가 더해진다', () => {
    const master = { digest: 'synthetic-master-digest',
      match: ({ year }: { rawName: string; year: string }) => year === '2023'
        ? { maker: '합성', model: '합성', sub_model: '합성 A', trim_name: null, master_id: 'synthetic-master' } : null,
      allowsYear: (id: string, year: number) => id === 'synthetic-master' && year === 2023 };
    const row = { ...goodRow, '차명 원문': '합성 원문 차종' };
    const passed = f05(row, master);
    expect(passed.raw.spec).toEqual({ ...goodSpec, year: '2023' });
    expect(passed.raw.spec_master_digest).toBe('synthetic-master-digest');
    expect(passed.raw.spec_master_id).toBe('synthetic-master');
    // 2026-10-25: 검토 UID 목록 밖이어도 원천 연식은 옮기고, 마스터 근거만 붙지 않는다.
    const notReviewed = f05(row, { ...master, sourceYearUids: new Set(['OTHER']) });
    expect(notReviewed.raw.spec).toEqual({ ...goodSpec, year: '2023' });
    expect(notReviewed.raw).not.toHaveProperty('spec_master_digest');
    // 2026-10-25: 마스터가 허용하지 않는 연식이어도 원천 연식은 옮기고(차종 판정과 분리), 마스터 근거만 붙이지 않는다.
    const notAllowed = f05(row, { ...master, allowsYear: () => false });
    expect(notAllowed.raw.spec).toEqual({ ...goodSpec, year: '2023' });
    expect(notAllowed.raw).not.toHaveProperty('spec_master_id');
    // 끈 공급사는 연식 게이트만(기존 동작 그대로).
    expect(f05(row, master, false).raw.spec).toEqual({ year: '2023' });
  });
  it('기존 쓰기 경로는 값 있는 칸을 덮지 않고 빈 칸만 채운다', () => {
    const r = f05(goodRow);
    const p: CycleProduct = { record: r, listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null, fillSourceIdentity: true };
    const opts = { specFillSources: new Set([r.sourceId]) };
    const first = nativeCycleFields(p, { car_number: r.plate, fuel_type: '디젤', ext_color: '', mileage: '999' }, opts);
    expect(first).not.toHaveProperty('fuel_type');
    expect(first).not.toHaveProperty('mileage');
    expect(first).toMatchObject({ ext_color: '흰색', int_color: '검정', seats: '5', engine_cc: '1598', first_registration_date: '2023-03-15', vehicle_spec_source_checked: true });
    expect(first).not.toHaveProperty('year');
    const refill = nativeCycleFields(p, { car_number: r.plate, vehicle_spec_source_checked: true, vehicle_int_color_source_checked: true, fuel_type: '', ext_color: '빨강', seats: '7' }, opts);
    expect(refill).toMatchObject({ fuel_type: '가솔린' });
    expect(refill).not.toHaveProperty('ext_color');
    expect(refill).not.toHaveProperty('seats');
  });
});

describe('B) 아이카 시트 제원 → raw.spec', () => {
  const headers = ['배차상태', '구분', '차량번호', '차급', '차종분류', '트림', '연료', '외장', '내장', 'Km', '월렌트', '장기보증',
    '36개월', '48개월', '60개월', '옵션', '최초등록', '소비자가격', '제조사', '배기량', '연주행', '대인', '대물', '자차', '자손'];
  const row = (o: Record<string, unknown> = {}) => headers.map(h => ({ 배차상태: '배차문의', 구분: '재렌트', 차량번호: '00가2001', 차급: '합성급',
    차종분류: '합성모델', 트림: '합성트림', 연료: '가솔린', 외장: '흰색', 내장: '검정', Km: 12345, 월렌트: '', 장기보증: '무보증',
    '36개월': '500,000', '48개월': '', '60개월': '', 옵션: '', 최초등록: '2023-05-12', 소비자가격: '', 제조사: '합성제조사', 배기량: 1598,
    연주행: '2만km', 대인: '', 대물: '', 자차: '', 자손: '', ...o } as Record<string, unknown>)[h]);
  const fixture = (rows: unknown[][]) => {
    const tables = AICA_SCOPES.map((title, i) => ({ title, values: title === '월렌트' ? [['차종', '1개월']] : [headers, ...(i === 0 ? rows : [])] }));
    const meta = { sheets: tables.map(t => ({ properties: { title: t.title, hidden: false, gridProperties: { rowCount: t.values.length } },
      data: [{ startRow: 0, rowMetadata: t.values.map(() => ({ hiddenByUser: false, hiddenByFilter: false })) }] })) };
    return { tables, meta };
  };
  const spec = (o: Record<string, unknown> = {}, on = true) => {
    const f = fixture([row(o)]);
    return aicaNativeCapture(f.tables, time, f.meta, on ? { sheetSpec: true } : undefined).rows[0]!.record.raw;
  };
  it('연료·외장·내장·Km·최초등록·배기량을 넘기고 연식은 만들지 않는다(최초등록에서 연식 추정 금지)', async () => {
    expect(spec().spec).toEqual({ fuel_type: '가솔린', ext_color: '흰색', int_color: '검정', mileage: '12345', first_registration_date: '2023-05-12', engine_cc: '1598' });
    expect(spec().spec).not.toHaveProperty('year');
    // 글자 칸(쉼표·단위)·날짜 일련번호도 공통 파서로 같은 꼴이 된다.
    expect(spec({ Km: '12,345km', 배기량: '1,598cc', 최초등록: 45000, 연료: '휘발유' }).spec)
      .toEqual({ fuel_type: '가솔린', ext_color: '흰색', int_color: '검정', mileage: '12345', first_registration_date: '2023-03-15', engine_cc: '1598' });
    // 기본(옵션 없음)은 지금과 같다.
    expect(spec({}, false)).not.toHaveProperty('spec');
    // 번호 UID 단계(plateUidPlugin)를 거쳐도 그대로 남는다.
    const f = fixture([row()]);
    const capture = aicaNativeCapture(f.tables, time, f.meta, { sheetSpec: true });
    const plugin = aicaNativePlugin(async () => capture, 1);
    expect(plugin.toRecords(await plugin.read()).records[0]!.raw.spec).toEqual(capture.rows[0]!.record.raw.spec);
  });
  it('형식이 틀린 값은 넣지 않고, 전기·수소는 배기량을 뺀다', () => {
    expect(spec({ 연료: '합성연료', 외장: '', 내장: '미정', Km: '약 1만', 최초등록: '2023-13', 배기량: '1.6' })).not.toHaveProperty('spec');
    expect(spec({ Km: 12.5, 배기량: 12 }).spec).toEqual({ fuel_type: '가솔린', ext_color: '흰색', int_color: '검정', first_registration_date: '2023-05-12' });
    expect(spec({ 연료: '전기', 배기량: 1000 }).spec).toEqual({ fuel_type: '전기', ext_color: '흰색', int_color: '검정', mileage: '12345', first_registration_date: '2023-05-12' });
    // 차명과 정면으로 어긋나는 연료(하이브리드 차명에 가솔린)는 넣지 않는다.
    expect(spec({ 트림: '1.6 하이브리드' }).spec).not.toHaveProperty('fuel_type');
  });
});

import { planSourceCycle } from '../src/application/source-cycle.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';
describe('C) 제원 전달을 처음 켜도 일괄 UPDATE 가 생기지 않는다(회차 상한 우회 방지, Codex 검토 P1)', () => {
  const rec = (uid: string, spec?: Record<string, string>): SourceProductRecord => ({ sourceId: 'RP999', uid, plate: uid, vehicleText: '합성', status: { raw: '출고가능', saleAvailable: true },
    observedAt: time, raw: { ...(spec ? { spec } : {}) }, vehicleHold: [],
    terms: [{ months: 12, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'KNOWN', value: 700000 }, mileage: '20000km/year', raw: {} }] });
  const cycleProduct = (record: SourceProductRecord): CycleProduct => ({ record, listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null });
  const run = (n: number, withSpecAfter: boolean, withSpecBefore: boolean, specAfter = { fuel_type: '가솔린' }) => {
    const ids = Array.from({ length: n }, (_, i) => `${String(i).padStart(3, '0')}가1000`);
    const products = ids.map(id => cycleProduct(rec(id, withSpecBefore ? { fuel_type: '가솔린' } : undefined)));
    const records = ids.map(id => rec(id, withSpecAfter ? specAfter : undefined));
    return planSourceCycle({ sourceId: 'RP999', family: 'OTHER', maxDowngradeRatio: 1 }, { records, observedAt: time, heldCount: 0, complete: true }, { products, complete: true }, Date.parse(time) + 60_000);
  };
  it('저장된 기록에 spec 이 아직 없고 새 기록에만 spec 이 있어도(101건) 변경 없음 — UPDATE 0', () => {
    expect(run(101, true, false).plan.entries).toEqual([]);
    expect(run(101, false, false).plan.entries).toEqual([]);
    const nullBefore = Array.from({ length: 101 }, (_, i) => `${String(i).padStart(3, '0')}가2000`);
    const nb = planSourceCycle({ sourceId: 'RP999', family: 'OTHER', maxDowngradeRatio: 1 }, { records: nullBefore.map(id => rec(id, { fuel_type: '가솔린' })), observedAt: time, heldCount: 0, complete: true }, { products: nullBefore.map(id => cycleProduct({ ...rec(id), raw: { spec: null } as never })), complete: true }, Date.parse(time) + 60_000);
    expect(nb.plan.entries).toEqual([]);   // 저장 기록 spec 이 null 이어도 같다
  });
  it('저장된 기록에 spec 이 이미 있으면 spec 값이 바뀐 것은 종전처럼 변경이다', () => {
    expect(run(3, true, true, { fuel_type: '디젤' }).plan.entries.map(e => e.kind)).toEqual(['UPDATE', 'UPDATE', 'UPDATE']);
    expect(run(3, true, true).plan.entries).toEqual([]);   // 같은 값은 변경 없음
  });
});

describe('D) F05 연료: 정규화기가 KNOWN 으로 읽지 못해도 시트 연료 칸 원문을 공통 별칭표로 판정(Codex 검토 P2)', () => {
  it('«전기차»·«FCEV» 같은 공통 별칭 표기를 아이카 경로와 같은 결과로 넘긴다(전기·수소는 배기량 제외)', () => {
    expect(f05({ ...goodRow, 연료: '전기차', 배기량: '1000' }).raw.spec).toMatchObject({ fuel_type: '전기' });
    expect(f05({ ...goodRow, 연료: '전기차', 배기량: '1000' }).raw.spec).not.toHaveProperty('engine_cc');
    expect(f05({ ...goodRow, 연료: 'FCEV', 배기량: '1000' }).raw.spec).toMatchObject({ fuel_type: '수소' });
    expect(f05({ ...goodRow, 연료: '합성연료' }).raw.spec).not.toHaveProperty('fuel_type');   // 모르는 표기는 넣지 않는다
  });
});

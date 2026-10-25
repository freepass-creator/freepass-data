import { describe, expect, it } from 'vitest';
import { iancarCyclePlugin } from '../src/adapters/source-cycle-plugins.js';
import type { IancarOneListCapture } from '../src/adapters/iancar-one-api.js';
import { parseIronDetail, IRON_HOMEPAGE_POLICY } from '../src/adapters/iron-homepage.js';
import { f05NativeCapture } from '../src/adapters/source-cycle-native.js';
import { sharedSheetChannels, sharedSheetHeaders, type SharedSheetCapture, type SheetCell } from '../src/adapters/shared-sheet-source.js';

// 2026-10-25 대표 «원천 값은 반드시 옮기고 내일 오픈 때 완벽»: 운영 정정(차종·연식·연료 103건)을 다음 수집 회차가 되돌리지 않게.
// 값은 전부 합성.
const time = '2026-10-25T03:00:00.000Z';

describe('① 이안카 연료는 차종 기준 한 장의 표준 이름으로', () => {
  const rate = { rental_period: 24, monthly_rate: 500000, deposit: 700000, contracted_mileage: 20000, mileage_period: 'year', currency: 'KRW', vat_included: true,
    contract_conditions: { version: 'synthetic-v1' } };
  const capture = (fuel: unknown, name = '합성'): IancarOneListCapture => ({ version: 'iancar-one-api/1', capturedAt: time, origin: 'synthetic', syncedAt: time, stale: false,
    total: 1, pages: 1, sourceDigest: 'synthetic', issues: [], readyForRawIngest: true, factScope: 'FULL_FACTS',
    records: [{ vehicleId: 'V1', fingerprint: 'V1', payload: { vehicle_id: 'V1', plate_number: '123가4567', inventory_status: 'AVAILABLE', available: true, fuel,
      detail: { data: { vehicle_id: 'V1', name } }, rates: { data: [rate] } } as IancarOneListCapture['records'][number]['payload'] }] });
  const specOf = async (fuel: unknown, name?: string) => {
    const plugin = iancarCyclePlugin(0.9, async () => capture(fuel, name), () => time);
    const rec = plugin.toRecords(await plugin.read()).records[0]!;
    return rec.raw.spec as Record<string, string> | undefined;
  };
  it('휘발유→가솔린, 전기차→전기, lpg→LPG, 경유→디젤', async () => {
    expect((await specOf('휘발유'))?.fuel_type).toBe('가솔린');
    expect((await specOf('전기차'))?.fuel_type).toBe('전기');
    expect((await specOf('lpg'))?.fuel_type).toBe('LPG');
    expect((await specOf('경유'))?.fuel_type).toBe('디젤');
  });
  it('표에 없는 표기·차명과 어긋나는 연료는 칸을 비우고 원문은 raw.fuel 에 남는다', async () => {
    expect(await specOf('합성연료')).toBeUndefined();
    expect(await specOf('휘발유', '그랜저 1.6 HEV')).toBeUndefined();
    const plugin = iancarCyclePlugin(0.9, async () => capture('합성연료'), () => time);
    expect(plugin.toRecords(await plugin.read()).records[0]!.raw.fuel).toBe('합성연료');
  });
});

describe('① 아이언 연료는 표준 이름으로', () => {
  const detail = (fuel: string, title = '현대 아반떼 CN7 프리미엄') => `<!doctype html><html><body><main>
<h1 class="product-detail-title">${title}</h1><div class="product-detail-subtitle">2.0 · 24년식</div>
<dl><dt>차량번호</dt><dd>12가3456</dd><dt>유종</dt><dd>${fuel}</dd></dl>
<div class="product-detail-rent-row"><dt>12개월</dt><dd>월 90만원</dd></div>
<div class="product-detail-badges"><span class="badge-pill">출고가능</span></div></main></body></html>`;
  const listing = { id: 'v1', url: `${IRON_HOMEPAGE_POLICY.baseUrl}/vehicles/v1`, condition: 'used' as const, sold: false };
  const specOf = (fuel: string, title?: string) => (parseIronDetail(detail(fuel, title), listing, time).raw.spec ?? {}) as Record<string, string>;
  it('휘발유→가솔린, 전기차→전기, lpg→LPG; 표에 없으면 비움(연식은 그대로)', () => {
    expect(specOf('휘발유').fuel_type).toBe('가솔린');
    expect(specOf('전기차').fuel_type).toBe('전기');
    expect(specOf('lpg').fuel_type).toBe('LPG');
    expect(specOf('합성연료')).toEqual({ year: '2024' });
    expect(specOf('휘발유', '쏘나타 하이브리드 DN8').fuel_type).toBeUndefined();
  });
});

describe('② F05 시트 연식은 마스터 연결과 분리해 그대로 옮긴다', () => {
  const channel = sharedSheetChannels[0]!, headers = [...sharedSheetHeaders, 'UID'];
  const f05 = (row: Record<string, SheetCell>, master: Parameters<typeof f05NativeCapture>[3]) => {
    const capture: SharedSheetCapture = { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-only', layoutVersion: '2026-10-04-no-account',
      readTime: time, revision: 'synthetic', tabs: [...new Set(sharedSheetChannels.map(c => c.tab))].map(title => {
        const values = [headers, ...(title === channel.tab ? [headers.map(h => ({ 회사명: channel.companyName, 차량번호: '00가1001', 차량상태: '출고가능',
          상품구분: '중고렌트', '12개월': 500000, 단기보증: '무보증', 장기보증: '무보증', 연주행: '20000km', '차명 원문': '합성 미연결 차', ...row } as Record<string, SheetCell>)[h] ?? '')] : [])];
        return { title, readTime: time, complete: true, rowCount: values.length, values };
      }) };
    const visibility = { sheets: capture.tabs.map(t => ({ properties: { title: t.title, gridProperties: { rowCount: t.rowCount } },
      data: [{ startRow: 0, rowMetadata: t.values.map(() => ({} as { hiddenByUser?: boolean; hiddenByFilter?: boolean })) }] })) };
    return f05NativeCapture(channel.code, capture, visibility, master, { sheetSpec: true }).rows[0]!.record;
  };
  const base = { 연료: '휘발유', 연식: 2022, 최초등록일: '2022-04-01' };
  const master = { digest: 'synthetic-master-digest', match: () => null, allowsYear: () => false };
  it('마스터 미연결 차도 시트 연식이 spec.year 로 실리고, 마스터 근거는 붙지 않는다', () => {
    const r = f05(base, master);
    expect(r.raw.spec).toMatchObject({ year: '2022', fuel_type: '가솔린' });
    expect(r.raw).not.toHaveProperty('spec_master_digest');
    expect(r.raw).not.toHaveProperty('spec_master_id');
  });
  it('마스터 연결 차는 연식과 마스터 근거가 함께 실린다(기존 그대로)', () => {
    const r = f05(base, { digest: 'd', match: () => ({ maker: 'a', model: 'b', sub_model: 'c', trim_name: null, master_id: 'm1' }), allowsYear: () => true });
    expect(r.raw.spec).toMatchObject({ year: '2022' });
    expect(r.raw.spec_master_id).toBe('m1');
  });
  it('검토 UID 목록 밖 차도 연식은 옮기되 마스터 근거는 없다; 연식·최초등록 모순·연식 경로 꺼짐은 연식을 싣지 않는다', () => {
    const outside = f05(base, { ...master, match: () => ({ maker: 'a', model: 'b', sub_model: 'c', trim_name: null, master_id: 'm1' }), allowsYear: () => true, sourceYearUids: new Set(['OTHER']) });
    expect(outside.raw.spec).toMatchObject({ year: '2022' });
    expect(outside.raw).not.toHaveProperty('spec_master_id');
    expect(f05({ ...base, 최초등록일: '2025-01' }, master).raw.spec).not.toHaveProperty('year');
    expect(f05(base, undefined).raw.spec).not.toHaveProperty('year');
  });
});

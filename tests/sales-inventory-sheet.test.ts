import { describe, expect, it } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPublicProductFeed } from '../src/api/public-product-feed.js';
import type { CatalogCompatibilitySnapshot } from '../src/infra/erp5-compat-catalog-reader.js';
import {
  compareSalesPlanWithFeed, planSalesInventorySheet, salesVersionTabName,
  SALES_SHEET_ALLOWED_COLUMNS, type SalesFeed, type SalesFeedProduct,
} from '../src/application/sales-inventory-sheet.js';
import { runSalesInventoryPlan } from '../src/jobs/plan-sales-inventory-sheet.js';

const item = (extra: Partial<SalesFeedProduct> = {}): SalesFeedProduct => ({
  publicProductKey: 'K1', car_number: '12가3456', maker: '현대', model: '그랜저', sub_model: '그랜저 GN7', trim_name: '프리미엄',
  fuel_type: '가솔린', year: 2024, mileage: 12000, ext_color: '흰색', provider_name: '테스트공급사', product_type: 'USED_SUBSCRIPTION',
  vehicle_status: 'AVAILABLE', price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } },
  image_url: null, photo_link: 'https://example.test/p', ...extra,
});
const feedOf = (...products: SalesFeedProduct[]): SalesFeed => ({ contractVersion: '1.0', count: products.length, products });
const at = '2026-10-16T01:05:00.000Z';

describe('영업자용 재고 시트 계획', () => {
  it('버전 탭 이름은 한국 시각이다', () => {
    expect(salesVersionTabName(at)).toBe('재고_20261016_1005');
    expect(salesVersionTabName('2026-10-15T15:00:00.000Z')).toBe('재고_20261016_0000');
    expect(() => salesVersionTabName('bad')).toThrow('SALES_SHEET_GENERATED_AT_INVALID');
  });

  it('영업자용은 공급사 칸을 보이고 소비자용은 뺀다', () => {
    const sales = planSalesInventorySheet(feedOf(item()), { snapshotId: 'S1', generatedAt: at });
    expect(sales.validation.ok).toBe(true);
    expect(sales.header.at(-1)).toBe('공급사');
    expect(sales.rows[0]!.at(-1)).toBe('테스트공급사');
    const consumer = planSalesInventorySheet(feedOf(item()), { snapshotId: 'S1', generatedAt: at, audience: 'consumer' });
    expect(consumer.header).not.toContain('공급사');
    expect(consumer.rows[0]).not.toContain('테스트공급사');
    expect(consumer.header.every(c => SALES_SHEET_ALLOWED_COLUMNS.has(c))).toBe(true);
  });

  it('보증금은 근거가 있을 때만 숫자, 아니면 확인 필요', () => {
    const plan = planSalesInventorySheet(feedOf(item({ price: {
      '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' },
      '48': { rent: 450000, deposit: 0, depositState: 'UNKNOWN' },
    } })), { snapshotId: 'S1', generatedAt: at });
    const h = plan.header, r = plan.rows[0]!;
    expect(r[h.indexOf('36개월 보증금')]).toBe('1000000');
    expect(r[h.indexOf('48개월 보증금')]).toBe('확인 필요');
    expect(r[h.indexOf('12개월 대여료')]).toBe('');
  });

  it('이름이 모두 비면 확인 중 문구, 상태 라벨과 사진 수를 센다', () => {
    const plan = planSalesInventorySheet(feedOf(item({ maker: null, model: null, sub_model: null, vehicle_status: 'CONTRACTING' })), { snapshotId: 'S1', generatedAt: at });
    expect(plan.rows[0]![1]).toBe('차량 정보 확인 중');
    expect(plan.summary).toMatchObject({ nameReviewRows: 1, photoRows: 1, byStatus: { 계약중: 1 } });
  });

  it('위반을 모은다: 건수·키·번호 중복·금지 필드·금지 문구', () => {
    const bad = { ...item({ publicProductKey: 'K2', car_number: '12가3456' }), partner_memo: 'x' } as SalesFeedProduct;
    const plan = planSalesInventorySheet({ contractVersion: '1.0', count: 6, products: [item(), bad, item({ publicProductKey: 'K1', car_number: null }),
      item({ publicProductKey: '' }), item({ publicProductKey: 'K9', car_number: '99나9999', trim_name: '수수료 포함' })] }, { snapshotId: 'S1', generatedAt: at });
    const codes = plan.validation.violations.map(v => v.code);
    expect(plan.validation.ok).toBe(false);
    for (const c of ['FEED_COUNT_MISMATCH', 'PRODUCT_KEY_MISSING', 'PRODUCT_KEY_DUPLICATE', 'FORBIDDEN_FIELD_IN_FEED', 'PLATE_DUPLICATE', 'FORBIDDEN_TEXT_IN_CELL', 'ROW_COUNT_MISMATCH']) {
      expect(codes).toContain(c);
    }
    expect(JSON.stringify(plan.validation)).not.toContain('12가3456');
  });

  it('피드와 차량 번호 집합을 대조한다(끝 4자리만 노출)', () => {
    const feed = feedOf(item(), item({ publicProductKey: 'K2', car_number: '34나5678' }));
    const plan = planSalesInventorySheet(feed, { snapshotId: 'S1', generatedAt: at });
    expect(compareSalesPlanWithFeed(plan, feed).equal).toBe(true);
    const fresh = feedOf(item(), item({ publicProductKey: 'K3', car_number: '77다0001' }));
    const diff = compareSalesPlanWithFeed(plan, fresh);
    expect(diff).toMatchObject({ equal: false, missingInSheet: ['0001'], extraInSheet: ['5678'] });
  });

  it('실제 공개 피드 출력과 구조가 호환된다(공급사명 포함, 금지 필드 0)', () => {
    const snapshot: CatalogCompatibilitySnapshot = {
      schema: 'freepass-data.catalog-compat/v1',
      data: { products: { P1: { _key: 'P1', product_code: 'P1', publicProductKey: 'P1', listable: true, provider_company_code: 'RP013', partner_code: 'RP013',
        provider_name: '공급사', car_number: '12가3456', maker: '제조사', model: '모델', trim_name: '트림', product_type: 'USED_SUBSCRIPTION', status_kind: '가용',
        policy_id: 'POLICY_PUBLIC', price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } }, supplierBillingFee: 1, vin: 'X' } },
        policies: { POLICY_PUBLIC: { policy_name: 'PUBLIC_BASIC', insurance_included: true, annual_mileage: 20000 } }, partners: {}, users: {} },
      meta: { consumerId: 'erp-com', authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE', sourceProject: 'freepasserp5', observedAt: '2026-10-10T00:00:00.000Z',
        collectionCounts: { products: 1, policy: 1 }, depositEvidenceVersion: 'catalog-compat-deposit/1' },
    } as unknown as CatalogCompatibilitySnapshot;
    const feed: SalesFeed = buildPublicProductFeed(snapshot, {}) as unknown as SalesFeed;
    const plan = planSalesInventorySheet(feed, { snapshotId: 'S1', generatedAt: at });
    expect(plan.validation).toEqual({ ok: true, violations: [] });
    expect(plan.summary.rowCount).toBe(feed.count);
    expect(plan.rows[0]![0]).toBe('12가3456');
  });

  it('금지 문구 우회(영문 fee·띄어쓰기·제로폭·전각)를 막고 사진 주소의 낱말은 막지 않는다', () => {
    for (const trim of ['fee 포함', '수 수 료', '수​수료', 'ＦＥＥ', 'Com​mission', '정­산']) {
      const plan = planSalesInventorySheet(feedOf(item({ trim_name: trim })), { snapshotId: 'S1', generatedAt: at });
      expect(plan.validation.violations.map(v => v.code), trim).toContain('FORBIDDEN_TEXT_IN_CELL');
    }
    const ok = planSalesInventorySheet(feedOf(item({ trim_name: 'Feel 프리미엄', photo_link: 'https://example.test/coffee/1.jpg' })), { snapshotId: 'S1', generatedAt: at });
    expect(ok.validation.ok).toBe(true);
  });

  it('위반 detail·요약 키에 원문 값·필드명이 새지 않는다', () => {
    const leak = { ...item(), ['partner_memo_12가3456']: 'x' } as SalesFeedProduct;
    const plan = planSalesInventorySheet(feedOf({ ...leak, product_type: '12가3456 원문' } as SalesFeedProduct), { snapshotId: 'S1', generatedAt: at });
    const dump = JSON.stringify({ v: plan.validation, s: plan.summary, r: plan.rows });
    expect(plan.validation.violations.some(v => v.code === 'FORBIDDEN_FIELD_IN_FEED' && v.detail === 'row#0')).toBe(true);
    expect(JSON.stringify(plan.validation)).not.toContain('partner_memo');
    expect(plan.summary.byProductType).toEqual({ 기타: 1 });
    expect(dump.includes('원문')).toBe(false);
  });

  it('가격 객체가 없는 기간도 보증금은 확인 필요', () => {
    const plan = planSalesInventorySheet(feedOf(item({ price: {} })), { snapshotId: 'S1', generatedAt: at });
    expect(plan.rows[0]![plan.header.indexOf('12개월 보증금')]).toBe('확인 필요');
    expect(plan.rows[0]![plan.header.indexOf('12개월 대여료')]).toBe('');
  });

  it('CLI 함수는 쓰기 없이 계획·대조·발행 가능 여부를 낸다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sales-plan-'));
    const feedPath = join(dir, 'feed.json'), freshPath = join(dir, 'fresh.json');
    await writeFile(feedPath, JSON.stringify(feedOf(item())));
    await writeFile(freshPath, JSON.stringify(feedOf(item(), item({ publicProductKey: 'K2', car_number: '34나5678' }))));
    const ok = await runSalesInventoryPlan({ feed: feedPath, snapshotId: 'S1', generatedAt: at, compareFeed: feedPath });
    expect(ok.publishable).toBe(true);
    const stale = await runSalesInventoryPlan({ feed: feedPath, snapshotId: 'S1', generatedAt: at, compareFeed: freshPath });
    expect(stale.publishable).toBe(false);
    await writeFile(feedPath, '{"products":1}');
    await expect(runSalesInventoryPlan({ feed: feedPath, snapshotId: 'S1' })).rejects.toThrow('SALES_FEED_INVALID');
  });
});

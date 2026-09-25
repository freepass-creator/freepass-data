import { describe, expect, it } from 'vitest';
import {
  buildRecentFirstBackfillQueue,
  discoverAdditionalVehicleMasterInventoryPages,
  discoverVehicleMasterInventoryExpectedCount,
  discoverVehicleMasterPages,
} from '../src/application/vehicle-master-backfill.js';

describe('vehicle master recent-first backfill', () => {
  it('discovers Carnoon detail pages and prioritizes newer model-year hints', () => {
    const html = Buffer.from(`
      <div>더 뉴 쏘렌토 <span>27년형 8월 27일 출시</span>
        <a href="/newcar/vehicle/11572">상세 보기</a>
      </div>
      <div>스타리아 <span>2024년형 2월 출시</span>
        <a href="/newcar/vehicle/9000">상세 보기</a>
      </div>
    `, 'utf8');

    const pages = discoverVehicleMasterPages({
      sourceKey: 'CARNOON',
      inventoryUrl: 'https://www.carnoon.co.kr/newcar/search',
      bytes: html,
    });

    expect(pages.map((x) => x.sourceUrl)).toEqual([
      'https://www.carnoon.co.kr/newcar/vehicle/11572',
      'https://www.carnoon.co.kr/newcar/vehicle/9000',
    ]);
    expect(pages[0]?.latestModelYearHint).toBe(2027);
    expect(pages[1]?.latestModelYearHint).toBe(2024);
    expect(pages[1]?.modelHint).not.toContain('쏘렌토');
    const queue = buildRecentFirstBackfillQueue(pages);
    expect(queue[0]?.sourceUrl).toContain('11572');
  });

  it('uses public sitemap shards for Carnoon and Danawa discovery', () => {
    expect(discoverAdditionalVehicleMasterInventoryPages({
      sourceKey: 'CARNOON',
      inventoryUrl: 'https://www.carnoon.co.kr/newcar/search',
      bytes: Buffer.from('<html/>'),
    })).toEqual(['https://www.carnoon.co.kr/sitemap.xml']);

    expect(discoverAdditionalVehicleMasterInventoryPages({
      sourceKey: 'DANAWA',
      inventoryUrl: 'https://auto.danawa.com/newcar/',
      bytes: Buffer.from('<html/>'),
    })).toEqual(['https://auto.danawa.com/sitemap.xml']);

    expect(discoverAdditionalVehicleMasterInventoryPages({
      sourceKey: 'CARNOON',
      inventoryUrl: 'https://www.carnoon.co.kr/sitemap.xml',
      bytes: Buffer.from('<xml/>'),
    })).toEqual([]);
  });

  it('discovers provider detail URLs embedded in sitemap XML', () => {
    const carnoon = discoverVehicleMasterPages({
      sourceKey: 'CARNOON',
      inventoryUrl: 'https://www.carnoon.co.kr/sitemap.xml',
      bytes: Buffer.from(
        '<urlset><url><loc>https://www.carnoon.co.kr/newcar/vehicle/11572</loc></url></urlset>'
      ),
    });
    expect(carnoon[0]?.sourceUrl).toBe(
      'https://www.carnoon.co.kr/newcar/vehicle/11572'
    );

    const danawa = discoverVehicleMasterPages({
      sourceKey: 'DANAWA',
      inventoryUrl: 'https://auto.danawa.com/sitemap.xml',
      bytes: Buffer.from(
        '<urlset><url><loc>https://auto.danawa.com/newcar/?Brand=303&amp;Model=4088&amp;Work=estimate</loc></url></urlset>'
      ),
    });
    expect(danawa[0]?.sourceUrl).toContain('Work=estimate');
  });

  it('discovers Danawa estimate URLs without depending on one model ID scheme', () => {
    const html = Buffer.from(`
      <div>현대 코나 2027년형
        <a href="/newcar/?Work=estimate&amp;Code=30343615373094910">신차 견적내기</a>
      </div>
    `, 'utf8');
    const pages = discoverVehicleMasterPages({
      sourceKey: 'DANAWA',
      inventoryUrl: 'https://auto.danawa.com/newcar/',
      bytes: html,
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.sourceUrl).toContain('Work=estimate');
    expect(pages[0]?.latestModelYearHint).toBe(2027);
  });

  it('prefers contextual anchor metadata when the same URL also appears in script', () => {
    const html = Buffer.from(`
      <script>const target = "/newcar/vehicle/11572";</script>
      <div>더 뉴 쏘렌토 <span>27년형 8월 27일 출시</span>
        <a href="/newcar/vehicle/11572">상세 보기</a>
      </div>
    `, 'utf8');

    const pages = discoverVehicleMasterPages({
      sourceKey: 'CARNOON',
      inventoryUrl: 'https://www.carnoon.co.kr/newcar/search',
      bytes: html,
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.latestModelYearHint).toBe(2027);
    expect(pages[0]?.modelHint).toContain('쏘렌토');
  });

  it('discovers source-specific detail URLs even when they are not anchor hrefs', () => {
    const html = Buffer.from(`
      <script>
        const carnoon = "/newcar/vehicle/11572";
      </script>
    `, 'utf8');

    const pages = discoverVehicleMasterPages({
      sourceKey: 'CARNOON',
      inventoryUrl: 'https://www.carnoon.co.kr/newcar/search',
      bytes: html,
    });

    expect(pages.map((x) => x.sourceUrl)).toEqual([
      'https://www.carnoon.co.kr/newcar/vehicle/11572',
    ]);
  });

  it('reads CarIsYou declared inventory count for partial-discovery detection', () => {
    expect(discoverVehicleMasterInventoryExpectedCount({
      sourceKey: 'CARISYOU',
      bytes: Buffer.from('<div>자동차 1,222 개</div>'),
    })).toBe(1222);

    expect(discoverVehicleMasterInventoryExpectedCount({
      sourceKey: 'CARISYOU',
      bytes: Buffer.from('<div>자동차 81대</div>'),
    })).toBe(81);

    expect(discoverVehicleMasterInventoryExpectedCount({
      sourceKey: 'CARNOON',
      bytes: Buffer.from('<div>자동차 81대</div>'),
    })).toBeNull();
  });

  it('discovers CarIsYou brand inventory shards from filter inputs', () => {
    const html = Buffer.from(`
      <form>
        <input type="checkbox" name="srhBrandArry" value="43">
        <input type="checkbox" name="srhBrandArry[]" value="787">
        <a href="/car/?srhBrandArry=2246">토요타</a>
      </form>
    `, 'utf8');

    expect(discoverAdditionalVehicleMasterInventoryPages({
      sourceKey: 'CARISYOU',
      inventoryUrl: 'https://www.carisyou.com/car/',
      bytes: html,
    })).toEqual([
      'https://www.carisyou.com/car/?srhBrandArry=43',
      'https://www.carisyou.com/car/?srhBrandArry=787',
      'https://www.carisyou.com/car/?srhBrandArry=2246',
    ]);
  });

  it('follows CarIsYou pagination-style inventory hints when exposed in page markup', () => {
    const html = Buffer.from(`
      <script>
        const next = "/car/?srhBrandArry=43&pageNo=2";
        const more = "/car/?srhBrandArry=43&offset=20";
      </script>
    `, 'utf8');

    expect(discoverAdditionalVehicleMasterInventoryPages({
      sourceKey: 'CARISYOU',
      inventoryUrl: 'https://www.carisyou.com/car/?srhBrandArry=43',
      bytes: html,
    })).toEqual([
      'https://www.carisyou.com/car/?srhBrandArry=43&offset=20',
      'https://www.carisyou.com/car/?srhBrandArry=43&pageNo=2',
    ]);
  });

  it('discovers CarIsYou historical/current detail pages and can skip completed URLs', () => {
    const html = Buffer.from(`
      <div>시판 2027 BMW 5시리즈(8세대)
        <a href="/car/9001">2027 BMW 5시리즈(8세대)</a>
      </div>
      <div>단종 2010 기아 K5
        <a href="/car/3956">2010 기아 K5</a>
      </div>
    `, 'utf8');
    const pages = discoverVehicleMasterPages({
      sourceKey: 'CARISYOU',
      inventoryUrl: 'https://www.carisyou.com/car/',
      bytes: html,
    });

    expect(pages.map((x) => x.sourceUrl)).toEqual([
      'https://www.carisyou.com/car/9001/Price',
      'https://www.carisyou.com/car/9001/Spec',
      'https://www.carisyou.com/car/3956/Price',
      'https://www.carisyou.com/car/3956/Spec',
    ]);

    const queue = buildRecentFirstBackfillQueue(pages, {
      completedUrls: [
        'https://www.carisyou.com/car/9001/Price',
        'https://www.carisyou.com/car/9001/Spec',
      ],
    });
    expect(queue).toHaveLength(2);
    expect(queue.every((x) => x.latestModelYearHint === 2010)).toBe(true);
  });

  it('prioritizes weaker coverage within the same recent model year', () => {
    const pages = [
      {
        sourceKey: 'CARNOON' as const,
        sourceType: 'CARNOON' as const,
        sourceName: 'Carnoon',
        sourceUrl: 'https://www.carnoon.co.kr/newcar/vehicle/sorento',
        discoveredFromUrl: 'https://www.carnoon.co.kr/newcar/search',
        modelHint: '쏘렌토 2027년형',
        latestModelYearHint: 2027,
        currentHint: true,
      },
      {
        sourceKey: 'DANAWA' as const,
        sourceType: 'DANAWA' as const,
        sourceName: 'Danawa Auto',
        sourceUrl: 'https://auto.danawa.com/newcar/?Work=estimate&Code=kona',
        discoveredFromUrl: 'https://auto.danawa.com/newcar/',
        modelHint: '코나 2027년형',
        latestModelYearHint: 2027,
        currentHint: true,
      },
    ];
    const coverage = [
      {
        coverageId: 'cov_sorento',
        maker: '기아',
        model: '쏘렌토',
        modelYear: 2027,
        sourceDocumentIds: ['official'],
        sourceOrigins: ['MANUFACTURER_OFFICIAL'],
        sourceTypes: ['MANUFACTURER_OFFICIAL' as const],
        normalizedRecordCount: 10,
        powertrainKeys: ['hybrid'],
        trimKeys: ['noblesse'],
        latestObservedAt: '2026-09-26T00:00:00.000Z',
        status: 'OFFICIAL' as const,
      },
    ];

    const queue = buildRecentFirstBackfillQueue(pages, { coverage });

    expect(queue.map((x) => x.sourceUrl)).toEqual([
      'https://auto.danawa.com/newcar/?Work=estimate&Code=kona',
      'https://www.carnoon.co.kr/newcar/vehicle/sorento',
    ]);
    expect(queue.map((x) => x.coverageStatus)).toEqual([
      'MISSING',
      'OFFICIAL',
    ]);
  });

  it('prioritizes current vehicles with unknown year ahead of known historical pages', () => {
    const pages = [
      {
        sourceKey: 'DANAWA' as const,
        sourceType: 'DANAWA' as const,
        sourceName: 'Danawa Auto',
        sourceUrl: 'https://auto.danawa.com/newcar/?Work=estimate&Code=current',
        discoveredFromUrl: 'https://auto.danawa.com/newcar/',
        modelHint: '현재 판매 모델',
        latestModelYearHint: null,
        currentHint: true,
      },
      {
        sourceKey: 'CARISYOU' as const,
        sourceType: 'CARISYOU' as const,
        sourceName: 'CarIsYou',
        sourceUrl: 'https://www.carisyou.com/car/3956/Price',
        discoveredFromUrl: 'https://www.carisyou.com/car/',
        modelHint: '2010 K5',
        latestModelYearHint: 2010,
        currentHint: false,
      },
    ];

    const queue = buildRecentFirstBackfillQueue(pages);
    expect(queue.map((x) => x.sourceKey)).toEqual(['DANAWA', 'CARISYOU']);
  });

  it('orders the combined provider queue by recent year before provider priority', () => {
    const pages = [
      {
        sourceKey: 'CARNOON' as const,
        sourceType: 'CARNOON' as const,
        sourceName: 'Carnoon',
        sourceUrl: 'https://www.carnoon.co.kr/newcar/vehicle/1',
        discoveredFromUrl: 'https://www.carnoon.co.kr/newcar/search',
        modelHint: 'A',
        latestModelYearHint: 2026,
        currentHint: true,
      },
      {
        sourceKey: 'CARISYOU' as const,
        sourceType: 'CARISYOU' as const,
        sourceName: 'CarIsYou',
        sourceUrl: 'https://www.carisyou.com/car/2',
        discoveredFromUrl: 'https://www.carisyou.com/car/',
        modelHint: 'B',
        latestModelYearHint: 2027,
        currentHint: true,
      },
      {
        sourceKey: 'DANAWA' as const,
        sourceType: 'DANAWA' as const,
        sourceName: 'Danawa Auto',
        sourceUrl: 'https://auto.danawa.com/newcar/?Work=estimate&Code=3',
        discoveredFromUrl: 'https://auto.danawa.com/newcar/',
        modelHint: 'C',
        latestModelYearHint: 2026,
        currentHint: true,
      },
    ];

    const queue = buildRecentFirstBackfillQueue(pages);
    expect(queue.map((x) => x.sourceKey)).toEqual([
      'CARISYOU',
      'CARNOON',
      'DANAWA',
    ]);
  });
});

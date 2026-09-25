import { describe, expect, it } from 'vitest';
import {
  buildRecentFirstBackfillQueue,
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

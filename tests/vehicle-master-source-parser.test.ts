import { describe, expect, it } from 'vitest';
import { KiaOfficialPriceParser } from '../src/adapters/kia-official-price-parser.js';
import { CarnoonVehicleParser } from '../src/adapters/carnoon-vehicle-parser.js';

describe('vehicle master source parsers', () => {
  it('parses Kia official price page structure', () => {
    const parser = new KiaOfficialPriceParser();
    const html = `
      <html>
        <head><title>기아 쏘렌토 가격 - 시대의 Mainstream</title></head>
        <body>
          <div>The 2027 Sorento</div>
          <div>2026년 9월 1일 기준 (단위 : 원)</div>
          <button>2.5 가솔린 터보</button>
          <section>
            <h3>프레스티지</h3>
            <div>36,410,000</div>
            <div>파워트레인</div>
            <div>스마트스트림 G2.5 터보 엔진</div>
            <button>선택품목</button>
            <li>스노우 화이트 펄 80,000</li>
            <li>전자식 4WD 2,320,000</li>
            <li>6인승 840,000</li>
            <li>7인승 690,000</li>
            <li>스타일 1,240,000</li>
            <li>12.3인치 클러스터 590,000</li>
            <li>드라이브 와이즈(12.3인치 클러스터 적용 시) 1,290,000</li>
          </section>
        </body>
      </html>
    `;

    const input = {
      sourceDocumentId: 'srcdoc_kia_sorento_2027',
      sourceUrl: 'https://www.kia.com/kr/vehicles/sorento/price',
      contentType: 'text/html; charset=utf-8',
      bytes: Buffer.from(html, 'utf8'),
    };

    expect(parser.canParse(input)).toBe(true);
    const result = parser.parse(input);

    expect(result.warnings).not.toContain('NO_TRIM_RECORDS_PARSED');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toEqual(expect.objectContaining({
      maker: '기아',
      model: '쏘렌토',
      modelYear: 2027,
      powertrainName: '2.5 가솔린 터보',
      trimName: '프레스티지',
      basePrice: 36410000,
      currency: 'KRW',
      effectiveFrom: '2026-09-01T00:00:00.000Z',
    }));
    expect(result.records[0]?.baseItemDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: '파워트레인',
          name: '스마트스트림 G2.5 터보 엔진',
        }),
      ])
    );
    expect(result.records[0]?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '스타일', price: 1240000 }),
        expect.objectContaining({ name: '전자식 4WD', price: 2320000 }),
        expect.objectContaining({
          name: '드라이브 와이즈',
          price: 1290000,
          note: '12.3인치 클러스터 적용 시',
          conditions: [
            {
              relation: 'REQUIRES',
              targetLabel: '12.3인치 클러스터',
              raw: '12.3인치 클러스터 적용 시',
            },
          ],
        }),
      ])
    );
  });

  it('parses Carnoon model-year, seat, drive, trim and options', () => {
    const parser = new CarnoonVehicleParser();
    const html = `
      <html>
        <head><title>기아자동차 더 뉴 쏘렌토 가격표, 제원 상세 정보 | 카눈</title></head>
        <body>
          <h4>2027년형 가솔린 2.5 터보 5인승 가격표 보기</h4>
          <ul>
            <li>프레스티지 2WD 휘발유 10.8㎞/ℓ 36,410,000 원</li>
            <li>스타일 1,240,000</li>
            <li>■ 255/45 R20 컨티넨탈 타이어&amp;전면가공 휠, 프로젝션 LED 헤드램프, LED 리어 콤비네이션램프</li>
            <li>12.3인치 클러스터 590,000</li>
            <li>HUD + 빌트인 캠 2 1,190,000</li>
            <li>노블레스 2WD 휘발유 10.8㎞/ℓ 39,660,000 원</li>
            <li>외장</li>
            <li>루프랙, 터치타입 아웃사이드 도어핸들</li>
          </ul>
        </body>
      </html>
    `;

    const input = {
      sourceDocumentId: 'srcdoc_carnoon_sorento_2027',
      sourceUrl: 'https://www.carnoon.co.kr/newcar/vehicle/11572',
      contentType: 'text/html; charset=utf-8',
      bytes: Buffer.from(html, 'utf8'),
    };

    expect(parser.canParse(input)).toBe(true);
    const result = parser.parse(input);

    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toEqual(expect.objectContaining({
      maker: '기아',
      model: '더 뉴 쏘렌토',
      modelYear: 2027,
      powertrainName: '가솔린 2.5 터보',
      seats: 5,
      drivetrain: '2WD',
      trimName: '프레스티지',
      fuelType: 'GASOLINE',
      basePrice: 36410000,
    }));
    expect(result.records[0]?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '스타일',
          price: 1240000,
          note: '255/45 R20 컨티넨탈 타이어&전면가공 휠, 프로젝션 LED 헤드램프, LED 리어 콤비네이션램프',
          packageItems: [
            '255/45 R20 컨티넨탈 타이어&전면가공 휠',
            '프로젝션 LED 헤드램프',
            'LED 리어 콤비네이션램프',
          ],
        }),
        expect.objectContaining({ name: '12.3인치 클러스터', price: 590000 }),
      ])
    );
    expect(result.records[1]).toEqual(expect.objectContaining({
      trimName: '노블레스',
      basePrice: 39660000,
    }));
    expect(result.records[1]?.baseItemDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: '외장', name: '루프랙' }),
        expect.objectContaining({ category: '외장', name: '터치타입 아웃사이드 도어핸들' }),
      ])
    );
  });

  it('rejects unrelated hosts through parser capability matching', () => {
    const kia = new KiaOfficialPriceParser();
    const carnoon = new CarnoonVehicleParser();
    const input = {
      sourceDocumentId: 'srcdoc_other',
      sourceUrl: 'https://example.com/sorento',
      contentType: 'text/html',
      bytes: Buffer.from('<html/>'),
    };

    expect(kia.canParse(input)).toBe(false);
    expect(carnoon.canParse(input)).toBe(false);
  });
});

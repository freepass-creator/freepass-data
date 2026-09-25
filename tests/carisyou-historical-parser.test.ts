import { describe, expect, it } from 'vitest';
import { CarisyouHistoricalParser } from '../src/adapters/carisyou-historical-parser.js';

describe('Carisyou historical parser', () => {
  it('does not assign used-market price after a grade row as original MSRP', () => {
    const parser = new CarisyouHistoricalParser();
    const html = `
      <html><body>
        <h4>브랜드</h4><div>현대</div>
        <h4>대표차종</h4><div>팰리세이드</div>
        <h4>연형+차종</h4><div>2020 팰리세이드</div>
        <div>3.8 가솔린 익스클루시브 2WD A/T</div>
        <div>중고시세 : 589만원 ~ 984만원</div>
      </body></html>
    `;

    const result = parser.parse({
      sourceDocumentId: 'src_carisyou_used_price_guard',
      sourceUrl: 'https://www.carisyou.com/car/6313/Price',
      contentType: 'text/html; charset=utf-8',
      bytes: Buffer.from(html, 'utf8'),
    });

    expect(result.records).toHaveLength(0);
  });

  it('does not borrow the next grade price when the current grade price is missing', () => {
    const parser = new CarisyouHistoricalParser();
    const html = `
      <html><body>
        <h4>브랜드</h4><div>현대</div>
        <h4>대표차종</h4><div>팰리세이드</div>
        <h4>연형+차종</h4><div>2020 팰리세이드</div>
        <div>3.8 가솔린 익스클루시브 2WD A/T</div>
        <div>-</div>
        <div>2.2 디젤 프레스티지 4WD A/T 4,498만원</div>
      </body></html>
    `;

    const result = parser.parse({
      sourceDocumentId: 'src_carisyou_next_grade_guard',
      sourceUrl: 'https://www.carisyou.com/car/6313/Spec',
      contentType: 'text/html; charset=utf-8',
      bytes: Buffer.from(html, 'utf8'),
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toEqual(expect.objectContaining({
      powertrainName: '2.2 디젤',
      trimName: '프레스티지',
      drivetrain: '4WD',
      basePrice: 44_980_000,
    }));
  });

  it('parses discontinued historical grades without importing used-market price', () => {
    const parser = new CarisyouHistoricalParser();
    const html = `
      <html>
        <head><title>2020 현대 팰리세이드 - 카이즈유 자동차 정보</title></head>
        <body>
          <h4>브랜드</h4><div>현대</div>
          <h4>대표차종</h4><div>팰리세이드</div>
          <h4>연형+차종</h4><div>2020 팰리세이드</div>
          <div>중고시세 : 589만원 ~ 984만원</div>
          <table>
            <tr><th>등급명(한글)</th><th>연료</th><th>배기량</th><th>연비</th><th>가격</th></tr>
            <tr>
              <td>단종 3.8 가솔린 익스클루시브 2WD 3.8 Gasoline Exclusive 2WD A/T</td>
              <td>가솔린</td><td>3778cc</td><td>9.6 km/ℓ</td><td>3,573 만원</td>
            </tr>
            <tr>
              <td>단종 2.2 디젤 프레스티지 4WD 2.2 Diesel Prestige 4WD A/T</td>
              <td>디젤</td><td>2199cc</td><td>11.3 km/ℓ</td><td>4,498 만원</td>
            </tr>
          </table>
        </body>
      </html>
    `;

    const input = {
      sourceDocumentId: 'src_carisyou_6313',
      sourceUrl: 'https://www.carisyou.com/car/6313',
      contentType: 'text/html; charset=utf-8',
      bytes: Buffer.from(html, 'utf8'),
    };

    expect(parser.canParse(input)).toBe(true);
    const result = parser.parse(input);

    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toEqual(expect.objectContaining({
      maker: '현대',
      model: '팰리세이드',
      modelYear: 2020,
      powertrainName: '3.8 가솔린',
      drivetrain: '2WD',
      trimName: '익스클루시브',
      fuelType: 'GASOLINE',
      basePrice: 35_730_000,
      seats: null,
    }));
    expect(result.records[1]).toEqual(expect.objectContaining({
      powertrainName: '2.2 디젤',
      drivetrain: '4WD',
      trimName: '프레스티지',
      basePrice: 44_980_000,
    }));
    expect(result.records.every((row) => row.basePrice > 10_000_000)).toBe(true);
    expect(result.warnings).toContain('HISTORICAL_STRUCTURED_SOURCE');
    expect(result.warnings).toContain('SEATS_REQUIRE_CORROBORATION');
  });
});

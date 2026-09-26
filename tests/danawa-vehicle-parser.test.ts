import { describe, expect, it } from 'vitest';
import { DanawaVehicleParser } from '../src/adapters/danawa-vehicle-parser.js';

describe('Danawa vehicle parser', () => {
  it('parses multiple recent model years and trim prices from one estimate page', () => {
    const parser = new DanawaVehicleParser();
    const html = `
      <html><body>
        <h2>현대 코나</h2>
        <h4>2027년형 가솔린 1.6 하이브리드 (개별소비세 인하)</h4>
        <label>모던 2WD A/T</label>
        <div>2,896 만 원</div>
        <label>프리미엄 2WD A/T</label>
        <div>3,318 만 원</div>
        <h4>2027년형 가솔린 터보 1.6 (개별소비세 인하)</h4>
        <label>프리미엄 4WD A/T</label>
        <div>3,075 만 원</div>
        <h4>2026년형 가솔린 2.0</h4>
        <label>모던 2WD A/T</label>
        <div>2,400 만 원</div>
      </body></html>
    `;

    const input = {
      sourceDocumentId: 'src_danawa_kona',
      sourceUrl: 'https://auto.danawa.com/newcar/?Work=estimate&Code=123',
      contentType: 'text/html; charset=utf-8',
      bytes: Buffer.from(html, 'utf8'),
    };

    expect(parser.canParse(input)).toBe(true);
    const result = parser.parse(input);

    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        maker: '현대',
        model: '코나',
        modelYear: 2027,
        powertrainName: '가솔린 1.6 하이브리드',
        trimName: '모던',
        drivetrain: '2WD',
        fuelType: 'HYBRID',
        basePrice: 28_960_000,
      }),
      expect.objectContaining({
        modelYear: 2027,
        powertrainName: '가솔린 터보 1.6',
        trimName: '프리미엄',
        drivetrain: '4WD',
        basePrice: 30_750_000,
      }),
      expect.objectContaining({
        modelYear: 2026,
        powertrainName: '가솔린 2.0',
        trimName: '모던',
        basePrice: 24_000_000,
      }),
    ]));
    expect(result.warnings).toContain('SEATS_REQUIRE_CORROBORATION');
  });
});

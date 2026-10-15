import { describe, expect, it } from 'vitest';
import { descriptionFlags, optionNames, probeSonogongShape, shapeOf } from '../src/jobs/probe-sonogong-shape.js';

describe('손오공 API 응답 모양 확인(읽기 전용)', () => {
  it('flattens key paths to types and never prints values', () => {
    const shape = shapeOf({ id: 7, carNumber: '12가3456', prices: { SUBSCRIBE_RETURN: { monthly: { 12: 900000 } } }, images: [{ url: 'u', sortOrder: 0 }], options: ['A', 'B'], note: null });
    expect(shape).toMatchObject({ id: 'number', carNumber: 'string', 'prices.SUBSCRIBE_RETURN.monthly.12': 'number', images: 'array(1)', 'images[].url': 'string',
      'images[].sortOrder': 'number', options: 'array(2)', 'options[]': 'string', note: 'null' });
    expect(JSON.stringify(shape)).not.toMatch(/12가3456|900000/);
  });

  it('options: names only (digits of 3+ masked, max 20), item kind reported; carDescription: flags and length only', () => {
    const names = optionNames(['썬루프', '드라이브와이즈 (+500000원)', { name: '내비게이션' }, { code: 'X1' }]);
    expect(names).toMatchObject({ count: 4, itemKind: 'string|object' });
    expect(names.names).toEqual(['썬루프', '드라이브와이즈 (+#원)', '내비게이션']);
    expect(optionNames('x')).toEqual({ count: 0, itemKind: 'string', names: [] });
    expect(optionNames(Array.from({ length: 30 }, (_, i) => `옵션${i}`)).names).toHaveLength(20);
    expect(descriptionFlags('즉시 출고 문의 010-1234-5678 월 50만원')).toEqual({ type: 'string', length: 29, hasMoneyLike: true, hasPhoneLike: true });
    expect(descriptionFlags(null)).toEqual({ type: 'null', length: 0, hasMoneyLike: false, hasPhoneLike: false });
    expect(JSON.stringify(descriptionFlags('비밀 본문'))).not.toContain('비밀');
  });

  it('probes one vehicle per tab using list then detail and returns shapes only', async () => {
    const calls: string[] = [];
    const client = { async get(path: string, query?: Record<string, string | number>) {
      calls.push(`${path}${query?.tab ? `?tab=${query.tab}` : ''}`);
      if (path === '/vehicles') return { data: query?.tab === 'pick' ? [] : [{ id: 1, carNumber: '12가3456', images: [{ url: 'u' }], brand: '기아' }], attrs: { generatedAt: 'x', totalCount: 1 } };
      return { data: { carNumber: '12가3456', options: ['썬루프'], carDescription: '설명 문구', images: [{ imageUrl: 'u', sortOrder: 0 }] }, attrs: {} };
    } };
    const result = await probeSonogongShape(client as never) as Record<string, any>;
    expect(Object.keys(result)).toEqual(['rent', 'sub', 'pick']);
    expect(result.pick).toEqual({ listRowKeys: null, note: 'EMPTY_TAB' });
    expect(result.rent.options).toEqual({ count: 1, itemKind: 'string', names: ['썬루프'] });
    expect(result.rent.carDescription).toMatchObject({ type: 'string', hasMoneyLike: false });
    expect(result.rent.detail['images[].imageUrl']).toBe('string');
    expect(calls.filter(c => c.startsWith('/vehicles/'))).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('12가3456');
  });
});

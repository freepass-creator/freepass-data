import { describe, expect, it } from 'vitest';
import { parseIancarPhotoIdGateSuppliers } from '../src/infra/erp5-compat-catalog-reader.js';

describe('사진 ID 게이트의 한정 RP031 설정', () => {
  it.each(['RP031', ' RP031 ', '\tRP031\t'])('바깥 공백을 제외한 단일 RP031은 ON: %j', raw => {
    expect([...parseIancarPhotoIdGateSuppliers(raw)]).toEqual(['RP031']);
  });
  it.each([undefined, null, false, 31, {}, ['RP031'], '', ' \t ', 'rp031', 'RP012',
    'RP031,RP012', 'RP031,UNKNOWN', 'RP031,RP031', ',RP031', 'RP031,',
    'RP031,,', 'RP 031', 'RP\n031', 'RP031\u0000'])('미설정·빈값·잘못된 값은 OFF: %j', raw => {
    expect([...parseIancarPhotoIdGateSuppliers(raw)]).toEqual([]);
  });
  it('반환 집합 변경이 다른 호출의 설정을 바꾸지 않는다', () => {
    const first = parseIancarPhotoIdGateSuppliers('RP031') as Set<string>;
    first.add('RP012');
    expect([...parseIancarPhotoIdGateSuppliers('RP031')]).toEqual(['RP031']);
    expect([...parseIancarPhotoIdGateSuppliers(undefined)]).toEqual([]);
  });
});

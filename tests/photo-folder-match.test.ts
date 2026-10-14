import { describe, expect, it } from 'vitest';
import { folderMatchesPlate } from '../src/domain/photo-folder-match.js';

describe('사진 폴더 ↔ 차량번호 일치', () => {
  it('번호만·번호 + 차종·번호 사이 공백은 일치', () => {
    expect(folderMatchesPlate('133하4531', '133하4531')).toBe(true);
    expect(folderMatchesPlate('133하4531 쏘나타 디 엣지', '133하4531')).toBe(true);
    expect(folderMatchesPlate('133하 4531 쏘나타', '133하4531')).toBe(true);
  });
  it('다른 번호·번호 뒤 숫자 접두·빈 값은 불일치', () => {
    expect(folderMatchesPlate('133하4532 쏘나타', '133하4531')).toBe(false);
    expect(folderMatchesPlate('133하45310', '133하4531')).toBe(false);
    expect(folderMatchesPlate('쏘나타 133하4531', '133하4531')).toBe(false);
    expect(folderMatchesPlate('', '133하4531')).toBe(false);
    expect(folderMatchesPlate('133하4531', '')).toBe(false);
  });
});

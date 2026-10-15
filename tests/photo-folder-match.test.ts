import { describe, expect, it } from 'vitest';
import { folderMatchesPlate } from '../src/domain/photo-folder-match.js';

describe('사진 폴더 ↔ 차량번호 일치', () => {
  it('번호만·번호 + 차종·번호 사이 공백은 일치', () => {
    expect(folderMatchesPlate('133하4531', '133하4531')).toBe(true);
    expect(folderMatchesPlate('133하4531 쏘나타 디 엣지', '133하4531')).toBe(true);
    expect(folderMatchesPlate('133하 4531 쏘나타', '133하4531')).toBe(true);
  });
  it('숫자로 시작하는 차종(공백 뒤)은 번호의 연장이 아니다 — 109호4100 5시리즈', () => {
    expect(folderMatchesPlate('109호4100 5시리즈 G60', '109호4100')).toBe(true);
    expect(folderMatchesPlate('109호4100 3시리즈', '109호4100')).toBe(true);
    expect(folderMatchesPlate('109호 4100 5시리즈', '109호4100')).toBe(true);
    expect(folderMatchesPlate('109호41005시리즈', '109호4100')).toBe(false);   // 공백 없이 붙으면 다른 번호
    expect(folderMatchesPlate('109호4100', '109호4100')).toBe(true);
  });

  it('다른 번호·번호 뒤 숫자 접두·빈 값은 불일치', () => {
    expect(folderMatchesPlate('133하4532 쏘나타', '133하4531')).toBe(false);
    expect(folderMatchesPlate('133하45310', '133하4531')).toBe(false);
    expect(folderMatchesPlate('쏘나타 133하4531', '133하4531')).toBe(false);
    expect(folderMatchesPlate('', '133하4531')).toBe(false);
    expect(folderMatchesPlate('133하4531', '')).toBe(false);
  });
});

describe('공급사 루트 폴더 → 번호 폴더 행', () => {
  it('첫 낱말이 번호인 폴더만, 같은 번호 폴더가 둘이면 보류', async () => {
    const { plateFromFolderName, plateFoldersFromChildren } = await import('../src/domain/photo-folder-match.js');
    expect(plateFromFolderName('161허1397 쏘나타 DN8')).toBe('161허1397');
    expect(plateFromFolderName('12가3456')).toBe('12가3456');
    expect(plateFromFolderName('12가34567')).toBeNull();
    expect(plateFromFolderName('신차 쏘나타')).toBeNull();
    const r = plateFoldersFromChildren([{ id: 'A', name: '12가3456 아반떼' }, { id: 'B', name: '34나5678' }, { id: 'C', name: '34나5678 K5' }, { id: 'D', name: '서류' }]);
    expect(r.rows).toEqual([{ plate: '12가3456', folder: 'A' }]);
    expect(r.ambiguous).toEqual(['34나5678']);
    expect(r.skipped).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kstYymmdd, findTodaysFile, fileSha256, diffTable, SUPPLIER_FILE_LIMITS } from '../src/adapters/supplier-file-intake.js';

// 2026-10-14 09:10 KST = 00:10Z
const now = Date.parse('2026-10-14T00:10:00Z');

describe('공급사 일일 엑셀 파일 도착 감지(마춤카)', () => {
  it('uses the KST date, including the evening hours that are already tomorrow in UTC', () => {
    expect(kstYymmdd(now)).toBe('261014');
    expect(kstYymmdd(Date.parse('2026-10-14T16:00:00Z'))).toBe('261015');
  });
  it('accepts only today\'s file, prefers the newest duplicate download, and reports older-only / none / oversized', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'intake-'));
    try {
      expect(await findTodaysFile(dir, now)).toEqual({ status: 'NO_FILE', newestYymmdd: null });
      await writeFile(join(dir, '마춤카 엑셀자료 261013.xlsx'), 'x');
      await writeFile(join(dir, 'other.xlsx'), 'x');
      expect(await findTodaysFile(dir, now)).toEqual({ status: 'OLDER_FILE_ONLY', newestYymmdd: '261013' });
      await writeFile(join(dir, '마춤카 엑셀자료 261014.xlsx'), 'a');
      await writeFile(join(dir, '마춤카 엑셀자료 261014 (1).xlsx'), 'b');
      const older = new Date(now - 3_600_000); await utimes(join(dir, '마춤카 엑셀자료 261014.xlsx'), older, older);
      const mid = new Date(now - 60_000); await utimes(join(dir, '마춤카 엑셀자료 261014 (1).xlsx'), mid, mid);
      const found = await findTodaysFile(dir, now);
      expect(found).toMatchObject({ status: 'FOUND', duplicates: 1 });
      if (found.status === 'FOUND') expect(found.file.name).toBe('마춤카 엑셀자료 261014 (1).xlsx');
      await writeFile(join(dir, '마춤카 엑셀자료 261014 (2).xlsx'), Buffer.alloc(SUPPLIER_FILE_LIMITS.maxBytes + 1));
      const newest = new Date(now + 60_000); await utimes(join(dir, '마춤카 엑셀자료 261014 (2).xlsx'), newest, newest);
      expect((await findTodaysFile(dir, now)).status).toBe('TOO_LARGE');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('hashes content so the same file is never applied twice', () => {
    expect(fileSha256(Buffer.from('abc'))).toBe(fileSha256(Buffer.from('abc')));
    expect(fileSha256(Buffer.from('abc'))).not.toBe(fileSha256(Buffer.from('abd')));
  });
  it('diff table is deterministic: NEW / CHANGED / MISSING / SAME', () => {
    const cur = [{ key: 'A', fingerprint: '1' }, { key: 'B', fingerprint: '1' }, { key: 'C', fingerprint: '1' }];
    const next = [{ key: 'C', fingerprint: '1' }, { key: 'B', fingerprint: '2' }, { key: 'D', fingerprint: '1' }];
    expect(diffTable(cur, next)).toEqual({ NEW: ['D'], CHANGED: ['B'], MISSING: ['A'], SAME: ['C'] });
    expect(diffTable(next, cur)).toEqual({ NEW: ['A'], CHANGED: ['B'], MISSING: ['D'], SAME: ['C'] });
  });
});

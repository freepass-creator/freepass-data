import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/jobs/plan-f04-commission-projection.js';

let dir = '';
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });
const META = { sheets: [{ properties: { title: '접수', gridProperties: { rowCount: 518 } } }, { properties: { title: '회차청구', gridProperties: { rowCount: 50 } } }] };
const files = async (ranges: string[]) => {
  dir = await mkdtemp(join(tmpdir(), 'f04-plan-'));
  const batch = join(dir, 'batch.json'), meta = join(dir, 'meta.json');
  await writeFile(batch, JSON.stringify({ valueRanges: ranges.map(range => ({ range, values: [] })) }));
  await writeFile(meta, JSON.stringify(META));
  return { batch, meta, out: join(dir, 'plan.json') };
};

describe('F04 투영 계획 작업: 두 탭을 A1 부터 마지막 행까지 읽은 입력만 받는다', () => {
  for (const ranges of [["'접수'!A2:BF518", "'회차청구'!A1:J50"], ["'접수'!A1:BF300", "'회차청구'!A1:J50"], ["'접수'!A1:BF518", "'회차청구'!A1:J10"], ["'회차청구'!A1:J50", "'접수'!A1:BF518"]])
    it(`refuses ${ranges.join(' + ')} and writes nothing`, async () => {
      const f = await files(ranges);
      await expect(main(['--from-batchget', f.batch, '--grid-meta', f.meta, '--open-from', '2026-09', '--out', f.out])).rejects.toThrow('F04_BATCHGET_RANGES_MISMATCH');
      expect(existsSync(f.out)).toBe(false);
    });
  it('requires the private individual-agreement list', async () => {
    const f = await files(["'접수'!A1:BF518", "'회차청구'!A1:J50"]);
    await expect(main(['--from-batchget', f.batch, '--grid-meta', f.meta, '--open-from', '2026-09', '--out', f.out])).rejects.toThrow('F04_INDIVIDUAL_LIST_REQUIRED');
    expect(existsSync(f.out)).toBe(false);
  });
  it('requires the grid meta', async () => {
    const f = await files(["'접수'!A1:BF518", "'회차청구'!A1:J50"]);
    await expect(main(['--from-batchget', f.batch, '--open-from', '2026-09', '--out', f.out])).rejects.toThrow('F04_GRID_META_REQUIRED');
  });
});

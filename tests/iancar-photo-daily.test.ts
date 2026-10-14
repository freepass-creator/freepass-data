import { describe, expect, it } from 'vitest';
import { runIancarPhotoDaily, type DailyDeps } from '../src/jobs/iancar-photo-daily.js';
import type { PhotoCopyResult } from '../src/application/iancar-photo-drive-copy.js';

const counts = (over: Partial<PhotoCopyResult['counts']> = {}): PhotoCopyResult['counts'] => ({ COPIED: 0, PLANNED_COPY: 0, SKIPPED_SAME: 0, SKIPPED_EXISTING: 0,
  SKIPPED_STALE: 0, NO_TARGET: 0, NEEDS_REPLACEMENT: 0, AMBIGUOUS_FOLDER: 0, FAILED: 0, NOT_ATTEMPTED: 0, ...over });
const result = (over: Partial<PhotoCopyResult> = {}): PhotoCopyResult => ({ mode: 'FULL', stop: 'COMPLETED', vehicles: 3, rows: [], counts: counts({ COPIED: 2 }),
  photosWritten: 20, bytesWritten: 1, completed: [{ plate: '12가1111', folderId: 'F1', files: 10 }, { plate: '12가2222', folderId: 'F2', files: 10 }], ...over });
function deps(copyResult: PhotoCopyResult, registerOutput = '1111 계획 10장(기존 0장) (시험)\n2222 계획 10장(기존 0장) (시험)') {
  const calls: Array<{ command: string; args: string[] }> = []; const logs: string[] = []; const copies: string[][] = [];
  const d: DailyDeps = {
    copy: async argv => { copies.push(argv); return copyResult; },
    run: (command, args) => { calls.push({ command, args }); return registerOutput; },
    log: line => logs.push(line),
  };
  return { d, calls, logs, copies };
}

describe('이안카 사진 일 1회 연동(복사 → 등록)', () => {
  it('DRY_RUN copies and registers nothing', async () => {
    const w = deps(result({ completed: [] }));
    const s = await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'DRY_RUN' }, w.d);
    expect(w.calls).toEqual([]);
    expect(s).toMatchObject({ mode: 'DRY_RUN', register: null, exit: 0 });
  });

  it('FULL: registers the completed vehicles with the Iancar method, and only dry-runs unless apply is explicitly enabled', async () => {
    const dry = deps(result());
    const s1 = await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'FULL' }, dry.d);
    expect(dry.copies[0]).toContain('--out');
    expect(dry.calls[0]!.args).toEqual(expect.arrayContaining(['--method', 'IANCAR_COMPRESSED_COPY']));
    expect(dry.calls[0]!.args).not.toContain('--apply');
    expect(s1.register).toMatchObject({ applied: false });
    const live = deps(result(), '1111 되읽기 MATCH\n2222 되읽기 MATCH');
    const s2 = await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'FULL', IANCAR_PHOTO_REGISTER_APPLY: 'true' }, live.d);
    expect(live.calls[0]!.args).toContain('--apply');
    expect(s2).toMatchObject({ register: { applied: true }, exit: 0, completed: 2 });
  });

  it('exit codes: copy stop/failure → 1, register mismatch → 1, stale skips left → 3, clean → 0', async () => {
    expect((await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT' }, deps(result({ stop: 'RATE_LIMITED' })).d)).exit).toBe(1);
    expect((await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT' }, deps(result({ counts: counts({ FAILED: 1 }) })).d)).exit).toBe(1);
    expect((await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT', IANCAR_PHOTO_REGISTER_APPLY: 'true' }, deps(result(), '1111 되읽기 MISMATCH').d)).exit).toBe(1);
    expect((await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT' }, deps(result({ counts: counts({ SKIPPED_STALE: 2 }) })).d)).exit).toBe(3);
    expect((await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT' }, deps(result()).d)).exit).toBe(0);
  });

  it('never prints a full plate number and survives a failing register tool as a failure code', async () => {
    const w = deps(result(), '12가1111 되읽기 MATCH\n1111 되읽기 MATCH');
    await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'FULL' }, w.d);
    expect(w.logs.join('\n')).not.toMatch(/\d{2,3}[가-힣]\d{4}/);
    const failing: DailyDeps = { ...w.d, run: () => { throw new Error('boom'); } };
    const s = await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'FULL', IANCAR_PHOTO_REGISTER_APPLY: 'true' }, failing);
    expect(s).toMatchObject({ exit: 1, register: { applied: true, summary: ['REGISTER_TOOL_FAILED'] } });
  });
});

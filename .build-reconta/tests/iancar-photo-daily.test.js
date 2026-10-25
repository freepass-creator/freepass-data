import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runIancarPhotoDaily } from '../src/jobs/iancar-photo-daily.js';
const counts = (over = {}) => ({ COPIED: 0, PLANNED_COPY: 0, SKIPPED_SAME: 0, SKIPPED_EXISTING: 0,
    SKIPPED_STALE: 0, NO_TARGET: 0, NEEDS_REPLACEMENT: 0, AMBIGUOUS_FOLDER: 0, FAILED: 0, NOT_ATTEMPTED: 0, ...over });
const result = (over = {}) => ({ mode: 'FULL', stop: 'COMPLETED', vehicles: 3, rows: [], counts: counts({ COPIED: 2 }),
    photosWritten: 20, bytesWritten: 1, completed: [{ plate: '12가1111', folderId: 'F1', files: 10 }, { plate: '12가2222', folderId: 'F2', files: 10 }], ...over });
function deps(copyResult, registerOutput = '1111 계획 10장(기존 0장) (시험)\n2222 계획 10장(기존 0장) (시험)') {
    const calls = [];
    const logs = [];
    const copies = [];
    const d = {
        copy: async (argv) => { copies.push(argv); return copyResult; },
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
        expect(dry.calls[0].args).toEqual(expect.arrayContaining(['--method', 'IANCAR_COMPRESSED_COPY']));
        expect(dry.calls[0].args).not.toContain('--apply');
        expect(s1.register).toMatchObject({ applied: false });
        const live = deps(result(), '1111 되읽기 MATCH\n2222 되읽기 MATCH');
        const s2 = await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'FULL', IANCAR_PHOTO_REGISTER_APPLY: 'true' }, live.d);
        expect(live.calls[0].args).toContain('--apply');
        expect(s2).toMatchObject({ register: { applied: true }, exit: 0, completed: 2 });
    });
    it('exit codes: copy stop/failure → 1, register mismatch → 1, stale skips left → 3, clean → 0', async () => {
        expect((await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT' }, deps(result({ stop: 'RATE_LIMITED' })).d)).exit).toBe(1);
        expect((await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT' }, deps(result({ counts: counts({ FAILED: 1 }) })).d)).exit).toBe(1);
        expect((await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT', IANCAR_PHOTO_REGISTER_APPLY: 'true' }, deps(result(), '1111 되읽기 MISMATCH').d)).exit).toBe(1);
        expect((await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT' }, deps(result({ counts: counts({ SKIPPED_STALE: 2 }) })).d)).exit).toBe(3);
        expect((await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT' }, deps(result()).d)).exit).toBe(0);
    });
    it('Codex #661 ⑴: each run uses its own CSV path and a lock prevents overlapping runs (stale locks are taken over)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'photo-daily-'));
        const env = { IANCAR_PHOTO_COPY_MODE: 'PILOT', SOURCE_CYCLE_PRIVATE_DIR: dir };
        const a = deps(result()), b = deps(result());
        await runIancarPhotoDaily(env, a.d);
        await runIancarPhotoDaily(env, b.d);
        const pathOf = (w) => w.copies[0][w.copies[0].indexOf('--out') + 1];
        expect(pathOf(a)).not.toBe(pathOf(b));
        expect(pathOf(a)).toContain(String(process.pid));
        expect(readdirSync(dir)).toEqual([]); // 잠금·CSV 모두 정리됨
        // 다른 실행이 잠금을 쥐고 있으면 거부(복사·등록 호출 없음)
        writeFileSync(join(dir, 'iancar-photo-daily.lock'), 'other');
        const blocked = deps(result());
        await expect(runIancarPhotoDaily(env, blocked.d)).rejects.toThrow('PHOTO_DAILY_ALREADY_RUNNING');
        expect(blocked.copies).toEqual([]);
        // 오래된 잠금은 멈춘 실행의 잔재 — 넘겨받는다
        const old = new Date(Date.now() - 5 * 60 * 60_000);
        utimesSync(join(dir, 'iancar-photo-daily.lock'), old, old);
        const taken = deps(result());
        await runIancarPhotoDaily(env, taken.d);
        expect(taken.copies.length).toBe(1);
        expect(existsSync(join(dir, 'iancar-photo-daily.lock'))).toBe(false);
    });
    it('Codex #661 ⑵: the register tool runs with a timeout and a timeout is a failure (exit 1)', async () => {
        const seen = [];
        const w = deps(result());
        const timing = { ...w.d, run: (_c, _a, _e, timeoutMs) => { seen.push(timeoutMs); throw Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }); } };
        const s = await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT', IANCAR_PHOTO_REGISTER_TIMEOUT_MIN: '5' }, timing);
        expect(seen).toEqual([5 * 60_000]);
        expect(s).toMatchObject({ exit: 1, register: { summary: ['REGISTER_TOOL_TIMEOUT'] } });
        const dflt = [];
        await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT' }, { ...w.d, run: (_c, _a, _e, t) => { dflt.push(t); return '1111 되읽기 MATCH'; } });
        expect(dflt).toEqual([20 * 60_000]);
    });
    it('Codex #661 ⑶: failure is judged on the full output, not on a truncated report (late MISMATCH still fails; empty output fails)', async () => {
        const many = Array.from({ length: 250 }, (_, i) => `${String(1000 + i)} 되읽기 MATCH`);
        const out = [...many, '9999 되읽기 MISMATCH', '8888 쓰기 실패 409'].join('\n');
        const s = await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT', IANCAR_PHOTO_REGISTER_APPLY: 'true' }, deps(result(), out).d);
        expect(s.exit).toBe(1);
        expect(s.register.counts).toEqual({ planned: 0, matched: 250, mismatch: 1, writeFailed: 1, skipped: 0 });
        expect(s.register.summary.length).toBeLessThanOrEqual(100); // 보고는 줄이되 판정은 전체 기준
        const empty = await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'PILOT', IANCAR_PHOTO_REGISTER_APPLY: 'true' }, deps(result(), '').d);
        expect(empty).toMatchObject({ exit: 1, register: { summary: ['REGISTER_OUTPUT_EMPTY'] } });
    });
    it('never prints a full plate number and survives a failing register tool as a failure code', async () => {
        const w = deps(result(), '12가1111 되읽기 MATCH\n1111 되읽기 MATCH');
        await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'FULL' }, w.d);
        expect(w.logs.join('\n')).not.toMatch(/\d{2,3}[가-힣]\d{4}/);
        const failing = { ...w.d, run: () => { throw new Error('boom'); } };
        const s = await runIancarPhotoDaily({ IANCAR_PHOTO_COPY_MODE: 'FULL', IANCAR_PHOTO_REGISTER_APPLY: 'true' }, failing);
        expect(s).toMatchObject({ exit: 1, register: { applied: true, summary: ['REGISTER_TOOL_FAILED'] } });
    });
});

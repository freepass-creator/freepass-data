import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crosscheckLast4, last4Of } from '../src/application/last4-crosscheck.js';
import { runLast4Crosscheck } from '../src/jobs/crosscheck-last4.js';
describe('끝 4자리 교차 대조', () => {
    it('번호판·끝 4자리 입력에서 끝 4자리 숫자만 취한다', () => {
        expect(last4Of('12가3456')).toBe('3456');
        expect(last4Of('３４５６')).toBe('3456');
        expect(last4Of('123하 7890 ')).toBe('7890');
        expect(last4Of('12가')).toBeNull();
        expect(last4Of(null)).toBeNull();
    });
    it('일치·한쪽에만 있음·모호(중복)를 나누고 끝 4자리만 낸다', () => {
        const r = crosscheckLast4(['12가1111', '34나2222', '56다3333', '78라3333', 'x'], ['1111', '9999', '2222', '2222', '5555']);
        expect(r.matched).toEqual(['1111']);
        expect(r.onlyInHomepage).toEqual([]);
        expect(r.onlyInImage).toEqual(['5555', '9999']);
        expect(r.ambiguous).toEqual(['2222', '3333']);
        expect(r.unusable).toEqual({ homepage: 1, image: 0 });
        expect(JSON.stringify(r)).not.toMatch(/[가-힣]/);
    });
    it('CLI 함수는 문자열·객체 배열을 받고 쓰기 0', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'x4-'));
        const a = join(dir, 'h.json'), b = join(dir, 'i.json');
        await writeFile(a, JSON.stringify([{ car_number: '12가1111' }, { car_number: '34나2222' }]));
        await writeFile(b, JSON.stringify(['1111']));
        const out = await runLast4Crosscheck({ homepage: a, image: b });
        expect(out).toMatchObject({ writes: 0, matched: ['1111'], onlyInHomepage: ['2222'], onlyInImage: [] });
        await writeFile(b, '{}');
        await expect(runLast4Crosscheck({ homepage: a, image: b })).rejects.toThrow('CROSSCHECK_INPUT_INVALID');
    });
});

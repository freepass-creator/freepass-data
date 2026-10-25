import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Windows PowerShell 5.1 은 BOM 이 없는 .ps1 을 시스템 코드페이지(CP949)로 읽어 한글 상수가 깨진다
// (2026-10-14 ensure-erp4-round.ps1: 한글 단계 이름 비교가 항상 거짓이 되던 결함). 한글이 든 .ps1 은 UTF-8 BOM 이어야 한다.
describe('PowerShell 스크립트 인코딩', () => {
    const dir = join(process.cwd(), 'scripts');
    const files = readdirSync(dir).filter(name => name.endsWith('.ps1'));
    it.each(files)('%s: Hangul text requires a UTF-8 BOM', name => {
        const bytes = readFileSync(join(dir, name));
        const hasHangul = /[가-힣]/.test(bytes.toString('utf8'));
        const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
        if (hasHangul)
            expect(hasBom).toBe(true);
    });
});

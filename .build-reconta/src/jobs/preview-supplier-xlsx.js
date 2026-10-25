/** 공급사 XLSX 재고 파일 «구조 미리보기»(읽기 전용, 쓰기 0·네트워크 0, 변환 아님). 변환기를 만들기 전에 실제 파일의 시트·머리글·열 모양을 비식별로 확인한다.
 *   node dist/src/jobs/preview-supplier-xlsx.js --file <재고.xlsx> [--out <미리보기.json>] [--max-rows 80]
 * 출력: 시트별 줄(번호·칸 수·칸 내용). 차량번호는 끝 4자리만(****1234 꼴), 전화번호 꼴은 [전화]로 가린다. 칸 내용은 60자까지.
 * 금액 단위·«90/90» 같은 칸의 뜻은 추정하지 않는다 — 모양(kind)만 표시한다. */
import { readFile, writeFile } from 'node:fs/promises';
import { readXlsx } from '../adapters/xlsx-reader.js';
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
/** 개인·식별 정보 가림: 완전한 차량번호는 끝 4자리만, 전화번호 꼴은 통째로. */
export function maskCell(value) {
    return value
        .replace(/\d{2,3}[\s\u00a0\u3000]*[가-힣][\s\u00a0\u3000]*(\d{4})/g, '****$1')
        .replace(/0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g, '[전화]')
        .slice(0, 60);
}
export function cellKind(value) {
    const v = value.trim();
    if (!v)
        return 'empty';
    if (/^\d+$/.test(v))
        return 'int';
    if (/^\d+\.\d+$/.test(v))
        return 'decimal';
    if (/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/.test(v))
        return 'slash';
    if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(v) || /^\d{1,2}\/\d{1,2}(?:\(.*\))?$/.test(v))
        return 'date';
    if (/(?:\d{2,3}\s?[가-힣]\s?\d{4}|\*{2,}\d{4})/.test(v))
        return 'plate';
    return 'text';
}
export async function previewSupplierXlsx(file, maxRows = 80) {
    const sheets = readXlsx(await readFile(file));
    return sheets.map(sheet => {
        const rows = sheet.rows.map((cells, index) => ({ row: index + 1, cells })).filter(r => r.cells.some(c => c.trim()));
        return { sheet: maskCell(sheet.name), rowCount: rows.length, maxColumns: Math.max(0, ...sheet.rows.map(r => r.length)),
            rows: rows.slice(0, maxRows).map(r => ({ row: r.row, filled: r.cells.filter(c => c.trim()).length,
                cells: r.cells.map((c, i) => ({ col: i, kind: cellKind(c), text: maskCell(c) })).filter(c => c.kind !== 'empty') })) };
    });
}
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('preview-supplier-xlsx.js')) {
    const file = arg('--file');
    if (!file) {
        console.error('PREVIEW_ARGS_REQUIRED');
        process.exitCode = 1;
    }
    else
        previewSupplierXlsx(file, Math.max(1, Math.min(500, Number(arg('--max-rows') ?? 80) || 80))).then(async (preview) => {
            const text = JSON.stringify(preview, null, 1);
            const out = arg('--out');
            if (out)
                await writeFile(out, text, { mode: 0o600 });
            else
                console.log(text);
        }).catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'PREVIEW_FAILED'); process.exitCode = 1; });
}

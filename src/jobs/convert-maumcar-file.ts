/** 마음카(RP034) 재고 파일 변환 결과 미리보기(읽기 전용, 쓰기 0·네트워크 0·Firestore 접근 없음).
 *   node dist/src/jobs/convert-maumcar-file.js --file <재고.xlsx> [--out <결과.json>]
 * 출력: 변환된 차량 수·보류 사유별 수·노트·보고 전용 건수, 차량별 요약(번호 끝4·차명·기간별 보증금/월료(원)·상태). 전체 차량번호는 내지 않는다.
 * 엔진 plan(기존 문서 대비 차이표)은 runtime CLI 로: SOURCE_CYCLE_SOURCES=MAUMCAR SOURCE_CYCLE_MAUMCAR_FILE=<파일> … --source RP034 --plan <plan.json>. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readXlsx } from '../adapters/xlsx-reader.js';
import { convertMaumcarWorkbook } from '../adapters/maumcar-file.js';
import { maskCell } from './preview-supplier-xlsx.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

export async function previewMaumcarConversion(file: string) {
  const bytes = await readFile(file);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const out = convertMaumcarWorkbook(readXlsx(bytes), { observedAt: new Date().toISOString(), fileSha256: sha });
  const heldByReason: Record<string, number> = {};
  for (const h of out.held) heldByReason[h.reason] = (heldByReason[h.reason] ?? 0) + 1;
  return {
    fileSha256: sha, fileBytes: bytes.length,
    converted: out.records.length, held: out.held.length, heldByReason, duplicatePlates: out.duplicatePlates.length,
    reportOnly: { ...out.reportOnly, headerlessSheets: out.reportOnly.headerlessSheets.map(s => ({ ...s, sheet: maskCell(s.sheet) })),
      convertedSheets: out.reportOnly.convertedSheets.map(maskCell) },
    notes: out.notes,
    vehicles: out.records.map(r => ({ plate4: String(r.plate).slice(-4), name: maskCell(r.vehicleText), status: r.status.raw,
      terms: r.terms.map(t => ({ months: t.months, deposit: t.deposit.state === 'KNOWN' ? t.deposit.value : t.deposit.state, rent: t.monthlyRent.state === 'KNOWN' ? t.monthlyRent.value : t.monthlyRent.state })) })),
    heldRows: out.held.map(h => ({ sheet: maskCell(h.sheet), row: h.row, reason: h.reason })),
  };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('convert-maumcar-file.js')) {
  const file = arg('--file');
  if (!file) { console.error('CONVERT_ARGS_REQUIRED'); process.exitCode = 1; }
  else previewMaumcarConversion(file).then(async result => {
    const text = JSON.stringify(result, null, 1);
    const out = arg('--out');
    if (out) await writeFile(out, text, { mode: 0o600 }); else console.log(text);
  }).catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'CONVERT_FAILED'); process.exitCode = 1; });
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planSheetBlankFill, type SheetBlankFillInput } from '../application/sheet-blank-fill.js';

export async function main() {
  const inputPath = process.env.SHEET_BLANK_FILL_INPUT;
  if (!inputPath) throw new Error('SHEET_BLANK_FILL_INPUT_REQUIRED');
  const input = JSON.parse(await readFile(inputPath, 'utf8')) as SheetBlankFillInput;
  const outDir = resolve(process.env.SHEET_BLANK_FILL_OUT ?? dirname(inputPath));
  const { plan, report } = planSheetBlankFill(input);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ 시트ID: plan.시트ID, 채울칸: report.counts.채울칸, 탭별: report.counts.탭별, skippedCounts: report.skippedCounts, differences: report.differences.length }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`SHEET_BLANK_FILL_HOLD ${e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : ''}`.trim()); process.exitCode = 1; });
}

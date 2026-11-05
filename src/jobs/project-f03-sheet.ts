import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { planF03Projection, type TrimMasterRow, type VehicleMasterRow } from '../application/f03-sheet-projection.js';

// 프리패스 데이터 차종 마스터 → F03 «차종마스터» 탭 투영. 기본은 시험 실행(쓰기 0).
// 입력(JSON 배열 파일): F03_TRIM_MASTER_JSON · F03_VEHICLE_MASTER_JSON · F03_SHEET_ROWS_JSON(탭 전체 값, 머리줄 포함 가능).
// --apply 는 F03_SHEET_ID(공개 저장소에 쓰지 않는다)와 gws 가 있어야 하고, 계획 줄을 «아래에 덧붙이기»만 한다. 백업 → 쓰기 → 되읽기.
const TAB = '차종마스터';
async function rows<T>(envName: string): Promise<T[]> {
  const path = process.env[envName]?.trim();
  if (!path) throw new Error(`${envName} is required`);
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${envName} must point to a JSON array`);
  return value as T[];
}
const gws = (args: string[]) => {
  const r = spawnSync(process.env.GWS_EXE?.trim() || 'gws', args, { encoding: 'utf8', shell: false, maxBuffer: 256 * 1024 * 1024 });
  const raw = r.stdout || '';
  const i = raw.indexOf('{');
  if (r.status !== 0 || i < 0) throw new Error(`gws 실패: ${(r.stderr || raw).slice(0, 300)}`);
  return JSON.parse(raw.slice(i));
};

const sheetRaw = await rows<string[]>('F03_SHEET_ROWS_JSON');
const sheetRows = sheetRaw[0]?.[1] === '제조사' ? sheetRaw.slice(1) : sheetRaw;
const plan = planF03Projection({
  trimRows: await rows<TrimMasterRow>('F03_TRIM_MASTER_JSON'),
  masterRows: await rows<VehicleMasterRow>('F03_VEHICLE_MASTER_JSON'),
  sheetRows,
}, {
  onlyNewModels: process.env.F03_ALL_NAMES !== '1',
  makers: (process.env.F03_MAKERS ?? '').split(',').map((m) => m.trim()).filter(Boolean),
});
const report = {
  mode: process.argv.includes('--apply') ? 'APPLY' : 'DRY-RUN',
  sheetRows: sheetRows.length,
  alreadyInSheet: plan.alreadyInSheet,
  toAppend: plan.append.length,
  nameDiffersReportOnly: plan.nameDiffers,
  sheetOnlyReportOnly: plan.sheetOnly.length,
  makers: plan.makers,
  marketClass: plan.marketClassCounts,
};
console.log(JSON.stringify(report, null, 2));
if (process.env.F03_PLAN_OUT?.trim()) await writeFile(process.env.F03_PLAN_OUT.trim(), JSON.stringify(plan.append.map((r) => r.values)), 'utf8');

if (process.argv.includes('--apply') && plan.append.length) {
  const id = process.env.F03_SHEET_ID?.trim();
  const backup = process.env.F03_BACKUP_OUT?.trim();
  if (!id || !backup) throw new Error('--apply 에는 F03_SHEET_ID 와 F03_BACKUP_OUT 이 필요하다');
  // 쓰기 직전에 탭 전체를 «다시» 읽어 계획 때 읽은 것과 같은지 확인하고, 그 읽은 것을 백업으로 남긴다(동시 수정·같은 줄 수 내용 변경 방지).
  const readTab = (range: string): string[][] => gws(['sheets', 'spreadsheets', 'values', 'get', '--params', JSON.stringify({ spreadsheetId: id, range, valueRenderOption: 'UNFORMATTED_VALUE' })]).values ?? [];
  const fresh = readTab(`'${TAB}'!A:P`);
  const norm = (v: string[][]) => JSON.stringify(v.map((r) => Array.from({ length: 16 }, (_, i) => String(r[i] ?? ''))));
  if (norm(fresh) !== norm(sheetRaw)) { const a = JSON.parse(norm(fresh)) as string[][], b = JSON.parse(norm(sheetRaw)) as string[][]; const i = a.findIndex((r, k) => JSON.stringify(r) !== JSON.stringify(b[k])); throw new Error('HOLD: 시트가 계획을 읽은 뒤 바뀜(줄 ' + (i + 1) + ', 읽은 줄 수 ' + b.length + ' → 지금 ' + a.length + ') — 다시 계획부터'); }
  await writeFile(backup, JSON.stringify(fresh), 'utf8');
  const before = fresh.length;
  const BATCH = 400;
  for (let i = 0; i < plan.append.length; i += BATCH) {
    gws(['sheets', 'spreadsheets', 'values', 'append', '--params', JSON.stringify({ spreadsheetId: id, range: `'${TAB}'!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }), '--json', JSON.stringify({ values: plan.append.slice(i, i + BATCH).map((r) => r.values) })]);
  }
  const wrote = readTab(`'${TAB}'!A${before + 1}:P${before + plan.append.length}`);
  const want = plan.append.map((r) => r.values);
  const ok = norm(wrote) === norm(want) && readTab(`'${TAB}'!A:P`).length === before + plan.append.length;
  console.log(JSON.stringify({ appended: plan.append.length, firstNewLine: before + 1, lastNewLine: before + plan.append.length, readback: ok ? 'OK' : 'MISMATCH' }));
  if (!ok) process.exitCode = 2;
}

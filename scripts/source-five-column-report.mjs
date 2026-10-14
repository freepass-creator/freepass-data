// 5칸 지표 보고(읽기 전용): 비공개 폴더의 heartbeats.jsonl 에서 원천별 마지막 줄의 정합 지표를 한 줄씩 출력한다.
//   node scripts/source-five-column-report.mjs [heartbeats.jsonl 경로] [--json]
// 경로를 주지 않으면 $SOURCE_CYCLE_PRIVATE_DIR/heartbeats.jsonl. 번호는 원본 줄에 이미 끝 4자리뿐이며 네트워크·쓰기 0.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const path = args.find(a => !a.startsWith('--')) ?? join(process.env.SOURCE_CYCLE_PRIVATE_DIR || join(homedir(), '.codex', 'private', 'source-cycle'), 'heartbeats.jsonl');
const mod = await import(pathToFileURL(join(process.cwd(), 'dist', 'src', 'application', 'source-five-column-report.js')).href);
const lines = (await readFile(path, 'utf8').catch(() => '')).split('\n');
const rows = mod.fiveColumnRows(lines);
if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else for (const row of rows) console.log(mod.fiveColumnLine(row));
if (!rows.length) { console.error('HEARTBEATS_EMPTY_OR_UNREADABLE'); process.exitCode = 1; }

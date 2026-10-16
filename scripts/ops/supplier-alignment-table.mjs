// 공급사별 배포 catalog 집계(읽기 전용): 저장된 /api/catalog 응답 JSON → 마크다운 표(공급사-catalog-집계 형식).
//   node scripts/ops/supplier-alignment-table.mjs <catalog.json> [--deposit all|any] [--deposit-basis value|state] [--out <표.md>]
// 보증금미상 기본 = 보증금이 아는 값인 가격 행이 하나도 없는 차량(--deposit all, 칸 값 기준 --deposit-basis value).
// 네트워크·쓰기 없음(--out 지정 시 그 파일만 씀). 출력에는 공급사 이름과 건수만 있고 차량번호·키·원문은 없다.
// 사전: npm run build (dist 필요).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const valueFlags = new Set(['--deposit', '--deposit-basis', '--out']);
const path = args.find((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
if (!path) throw new Error('usage: supplier-alignment-table <catalog.json> [--deposit all|any] [--deposit-basis value|state] [--out file.md]');
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const depositMode = flag('--deposit') ?? 'all';
const depositBasis = flag('--deposit-basis') ?? 'value';
if (!['any', 'all'].includes(depositMode) || !['value', 'state'].includes(depositBasis)) throw new Error('DEPOSIT_OPTION_INVALID');
const mod = await import(pathToFileURL(join(process.cwd(), 'dist', 'src', 'application', 'supplier-catalog-aggregate.js')).href);
const aggregate = mod.aggregateCatalog(JSON.parse(readFileSync(path, 'utf8')), { depositMode, depositBasis });
const markdown = mod.catalogAggregateMarkdown(aggregate, new Date().toISOString());
const out = flag('--out');
if (out) writeFileSync(out, markdown); else process.stdout.write(markdown);
if (!aggregate.rows.length) { console.error('CATALOG_EMPTY_OR_UNRECOGNIZED'); process.exitCode = 1; }

/** 정체성 보류 재분류 보고(읽기 전용, 쓰기 0·네트워크 0): 정체성 스냅숏 → «마스터에 있는데 못 잡은 것» vs «마스터에 정말 없는 것».
 *   npm run classify:identity-holds -- --input <snapshot.json> [--supplier RP012] [--listable-only] [--examples 5]
 * 번호는 끝 4자리만, 원문 차명·마스터 이름만 출력한다. 종료 코드: 0 정상 · 2 설정 오류. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyIdentityHolds } from '../application/identity-hold-classification.js';
import { parseIdentitySnapshot } from './build-identity-promotion-plan.js';

export function classifyIdentityHoldsCli(argv: string[], log: (line: string) => void = console.log): number {
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const input = arg('--input');
  if (!input) { log('설정 오류: --input <snapshot.json> 필요'); return 2; }
  let parsed: ReturnType<typeof parseIdentitySnapshot>;
  try { parsed = parseIdentitySnapshot(JSON.parse(readFileSync(input, 'utf8'))); } catch { log('설정 오류: 스냅숏 JSON 을 읽을 수 없음'); return 2; }
  const supplier = arg('--supplier'), listableOnly = argv.includes('--listable-only'), examples = Math.max(0, Math.min(20, Number(arg('--examples') ?? '5') || 0));
  const products = parsed.products.filter(p => (!supplier || p.supplier === supplier) && (!listableOnly || p.listable));
  const report = classifyIdentityHolds(products, parsed.masters);
  log(`대상 ${products.length}대 · 마스터 미특정 보류(NO_MASTER_MATCH·AMBIGUOUS_MASTER) ${report.total}대`);
  for (const [cls, n] of Object.entries(report.byClass)) log(`  ${cls}: ${n}`);
  log('연식 구분(2019+ = 최근 5~7년):');
  for (const [k, n] of Object.entries(report.byClassYear).sort()) log(`  ${k}: ${n}`);
  log('실패 유형(원문 패턴별 건수 / 정규화로 유일 매칭된 건수):');
  for (const p of report.patterns) log(`  ${p.pattern}: ${p.count} / ${p.resolved}`);
  for (const h of report.held.filter(x => x.cls === 'MATCH_FAILURE_UNIQUE').slice(0, examples)) log(`  예 ${h.plate4} [${h.via}] → ${h.candidates.join(' | ')}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(classifyIdentityHoldsCli(process.argv.slice(2)));

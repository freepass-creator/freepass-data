/** 엔진 정체성 정제 «왜 안 됐나» 진단(읽기 전용, 쓰기 0·네트워크 0): 정체성 스냅숏(export:identity-snapshot 결과)에서 끝 4자리로 고른 문서마다
 * ① 엔진 정제기(refineEngineIdentity — 회차가 쓰는 입력: 원문 차명·연식)와 ② 계획서 생성기(matchIdentity — 제조사·모델 입력 포함)의 결과를 나란히 낸다.
 *   npm run explain:engine-refine -- --input <snapshot.json> --plates 9203,9581 [--supplier RP012]
 * 번호는 끝 4자리만, 원문 차명·마스터 이름만 출력한다. 종료 코드: 0 정상 · 2 설정 오류. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { matchIdentity, refineEngineIdentity, type IdentityMaster, type IdentityProduct } from '../application/identity-promotion-plan.js';
import { parseIdentitySnapshot } from './build-identity-promotion-plan.js';

export type EngineRefineExplanation = { plate4: string; supplier: string; year: string; rawName: string; hasMakerModel: boolean; trimBlank: boolean;
  engine: { state: 'REFINED'; sub_model: string; trim: string | null } | { state: 'NULL' }; plan: string };

export function explainEngineRefine(products: ReadonlyArray<IdentityProduct & { supplier?: string }>, masters: readonly IdentityMaster[],
  plates: readonly string[], supplier = 'RP012'): EngineRefineExplanation[] {
  const want = new Set(plates);
  return products.filter(p => want.has(p.plate4) && (p.supplier ?? '') === supplier).map(p => {
    const engine = refineEngineIdentity({ rawName: p.rawName, year: p.year }, masters);
    const plan = matchIdentity(p, masters);
    return { plate4: p.plate4, supplier, year: p.year, rawName: p.rawName, hasMakerModel: !!(p.maker.trim() && p.model.trim()), trimBlank: !p.trim_name.trim(),
      engine: engine ? { state: 'REFINED' as const, sub_model: engine.sub_model, trim: engine.trim_name } : { state: 'NULL' as const },
      plan: plan.state === 'MATCH' ? `MATCH ${plan.master.sub_model} · 트림 ${plan.trim.state}` : `HOLD ${plan.reason}${plan.candidates.length ? ` (${plan.candidates.length})` : ''}` };
  });
}

export function explainEngineRefineCli(argv: string[], log: (line: string) => void = console.log): number {
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const input = arg('--input'), plates = (arg('--plates') ?? '').split(',').map(v => v.trim()).filter(v => /^\d{4}$/.test(v));
  if (!input || !plates.length) { log('설정 오류: --input <snapshot.json> --plates 9203,9581 필요'); return 2; }
  let parsed: ReturnType<typeof parseIdentitySnapshot>;
  try { parsed = parseIdentitySnapshot(JSON.parse(readFileSync(input, 'utf8'))); } catch { log('설정 오류: 스냅숏 JSON 을 읽을 수 없음'); return 2; }
  for (const e of explainEngineRefine(parsed.products, parsed.masters, plates, arg('--supplier') ?? 'RP012')) {
    log(`${e.plate4} ${e.supplier} 연식 ${e.year || '-'} | 원문 ${e.rawName} | 제조사·모델 ${e.hasMakerModel ? '있음' : '없음'}·트림 ${e.trimBlank ? '빈칸' : '있음'}`);
    log(`   엔진 정제기: ${e.engine.state === 'REFINED' ? `정제 → ${e.engine.sub_model} · 트림 ${e.engine.trim ?? '(빈칸)'}` : 'null(정제 안 함)'} · 계획서: ${e.plan}`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(explainEngineRefineCli(process.argv.slice(2)));

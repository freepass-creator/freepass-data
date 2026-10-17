// AI 정제용 마스터 후보 묶음(읽기 전용, 쓰기 0): node ai-refine-masters.mjs <identity스냅샷.json> [공급사=RP012]
// 대상 문서(노출·공급사·모델 빈칸)의 원문과 낱말이 겹치는 마스터 항목을 중복 없이 한 줄씩 낸다: ID|제조사|모델|세부모델|생산기간|트림
import { readFileSync } from 'node:fs';
const [file, supplierArg] = process.argv.slice(2);
const snap = JSON.parse(readFileSync(file, 'utf8')), supplier = supplierArg ?? 'RP012';
const products = (snap.products ?? []).filter(p => p.listable === true && (p.supplier ?? '') === supplier && !String(p.model ?? '').trim());
const masters = (snap.masters ?? []).filter(m => !m.retired);
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s_/,·\-()]+/g, '');
const words = s => String(s ?? '').normalize('NFKC').toLowerCase().split(/[^0-9a-z가-힣]+/u).filter(w => w.length >= 2);
const stop = new Set(['가솔린', '디젤', '하이브리드', '터보', '전기', 'lpg', '2wd', '4wd', 'awd', '신형', '더뉴', '디올뉴', '올뉴', '뉴', '현대', '기아', '제네시스', '르노코리아', '쉐보레', 'kg모빌리티', '쌍용']);
const keep = new Map();
for (const p of products) {
  const raw = `${p.rawName ?? ''} ${p.sub_model ?? ''}`, rawNorm = norm(raw), rawWords = new Set(words(raw).filter(w => !stop.has(w)));
  for (const m of masters) {
    const names = [m.sub_model, m.model, ...(m.sub_model_aliases ?? []), ...(m.model_aliases ?? [])].filter(Boolean);
    if (names.some(n => (norm(n).length >= 2 && rawNorm.includes(norm(n))) || words(n).some(w => !stop.has(w) && rawWords.has(w)))) keep.set(m.id, m);
  }
}
console.log(`# 대상 ${products.length}대, 마스터 ${keep.size}건`);
for (const m of [...keep.values()].sort((a, b) => `${a.maker}${a.model}${a.yearFrom}`.localeCompare(`${b.maker}${b.model}${b.yearFrom}`)))
  console.log([m.id, m.maker, m.model, m.sub_model, `${m.yearFrom ?? ''}-${m.yearTo ?? ''}`, (m.trims ?? []).map(t => t.name).join('/')].join('|'));

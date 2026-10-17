// AI 정제 입력 묶음(읽기 전용, 쓰기 0): node ai-refine-packet.mjs <identity스냅샷.json> [시작 인덱스=0] [개수=50] [공급사=RP012]
// 대상: 노출(listable) + 공급사 일치 + 모델 칸이 빈 문서. 차마다 원문·제원·현재 값과 «마스터 후보 목록»(재현율 우선, 최대 12)을 한 줄 JSON 으로 낸다.
// 번호는 끝 4자리만. 마스터 후보는 마스터에 있는 이름만(이름을 만들지 않는다).
import { readFileSync } from 'node:fs';
const [file, startArg, countArg, supplierArg] = process.argv.slice(2);
const snap = JSON.parse(readFileSync(file, 'utf8'));
const start = Number(startArg ?? 0), count = Number(countArg ?? 50), supplier = supplierArg ?? 'RP012';
const products = (snap.products ?? []).filter(p => p.listable === true && (p.supplier ?? '') === supplier && !String(p.model ?? '').trim());
const masters = (snap.masters ?? []).filter(m => !m.retired);
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s_/,·\-()]+/g, '');
const words = s => String(s ?? '').normalize('NFKC').toLowerCase().split(/[^0-9a-z가-힣]+/u).filter(w => w.length >= 2);
const stop = new Set(['가솔린', '디젤', '하이브리드', '터보', '전기', 'lpg', '2wd', '4wd', 'awd', '신형', '더뉴', '디올뉴', '올뉴', '뉴', '현대', '기아', '제네시스', '르노코리아', '쉐보레', 'kg모빌리티', '쌍용']);
const out = [];
for (const p of products.slice(start, start + count)) {
  const raw = `${p.rawName ?? ''} ${p.sub_model ?? ''}`;
  const rawNorm = norm(raw), rawWords = new Set(words(raw).filter(w => !stop.has(w)));
  const scored = [];
  for (const m of masters) {
    const names = [m.sub_model, m.model, ...(m.sub_model_aliases ?? []), ...(m.model_aliases ?? [])].filter(Boolean);
    let score = 0;
    for (const n of names) {
      const k = norm(n);
      if (k.length >= 2 && rawNorm.includes(k)) score = Math.max(score, k.length + 10);
      for (const w of words(n)) if (!stop.has(w) && rawWords.has(w)) score = Math.max(score, w.length);
    }
    if (norm(raw).includes(norm(m.maker)) && score) score += 2;
    if (score) scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.m.id).localeCompare(String(b.m.id)));
  out.push(JSON.stringify({
    i: products.indexOf(p), plate4: p.plate4, raw: p.rawName ?? '', year: p.year ?? '', fuel: p.fuel ?? '',
    cur: { maker: p.maker ?? '', model: p.model ?? '', sub: p.sub_model ?? '', trim: p.trim_name ?? '' },
    cand: scored.slice(0, 12).map(({ m }) => ({ id: m.id, maker: m.maker, model: m.model, sub: m.sub_model, y: `${m.yearFrom ?? ''}-${m.yearTo ?? ''}`, trims: (m.trims ?? []).map(t => t.name).slice(0, 12) })),
  }));
}
console.log(`# 대상 ${products.length}대 중 ${start}~${start + out.length - 1} (공급사 ${supplier})`);
console.log(out.join('\n'));

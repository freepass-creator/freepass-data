// 프리패스 데이터 vehicle_master → ERP4 정적 차종 스냅샷(public/data/vehicle-master.json) 투영.
// 정본은 프리패스 데이터이고 스냅샷은 사본이다(기준 한 장 규칙 12). 읽기 전용: 프리패스 데이터에 쓰지 않는다.
// 사용: node scripts/ops/export-vehicle-master-snapshot.mjs <기존 스냅샷 경로> <출력 경로> [--report <diff 보고서 경로>]
// 필요: dist 빌드(gcloud 사용자 토큰), 환경변수 FIREBASE_PROJECT_ID(없으면 freepasserp5).
import { readFileSync, writeFileSync } from 'node:fs';
import { gcloudUserToken } from '../../dist/src/infra/source-cycle-firestore.js';

const [inPath, outPath] = process.argv.slice(2, 4);
const reportAt = process.argv.indexOf('--report');
const reportPath = reportAt > 0 ? process.argv[reportAt + 1] : null;
if (!inPath || !outPath) throw new Error('usage: export-vehicle-master-snapshot <existing> <out> [--report <path>]');
const project = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
const tok = await gcloudUserToken();
const H = { authorization: 'Bearer ' + tok, 'content-type': 'application/json' };
const dec = v => {
  if (v == null || 'nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  return null;
};
const res = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:runQuery`,
  { method: 'POST', headers: H, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'vehicle_master' }] } }) });
if (!res.ok) throw new Error('FIRESTORE_READ_FAILED_' + res.status);
const docs = (await res.json()).filter(x => x.document).map(x => ({ id: decodeURIComponent(x.document.name.split('/').pop()),
  ...dec({ mapValue: { fields: x.document.fields || {} } }) }));
const raw = readFileSync(inPath, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const current = JSON.parse(raw);
const entries = Array.isArray(current) ? current : current.entries;
const byId = new Map(entries.map(e => [e.id, e]));
const live = docs.filter(d => d.retired !== true && d.maker && d.model && d.sub_model);
const out = [];
const aliasesOf = (d, old) => {
  const names = new Set([...(Array.isArray(d.sub_model_aliases) ? d.sub_model_aliases : []), ...(old?.aliases ?? [])]);
  if (old && old.sub_model && old.sub_model !== d.sub_model) names.add(old.sub_model);
  names.delete(d.sub_model);
  return [...names].filter(x => typeof x === 'string' && x.trim());
};
for (const d of live) {
  const old = byId.get(d.id);
  const aliases = aliasesOf(d, old);
  out.push({ id: d.id, maker: d.maker, model: d.model, sub_model: d.sub_model, gen_code: d.gen_code ?? '', origin: d.origin ?? old?.origin ?? '',
    year_start: d.year_start ?? old?.year_start ?? '', year_end: d.year_end ?? old?.year_end ?? '', title: d.title ?? old?.title ?? `${d.maker} ${d.sub_model}`,
    ...(aliases.length ? { aliases } : {}), variants: d.variants ?? old?.variants ?? [], trims: d.trims ?? old?.trims ?? [],
    market_class: d.market_class ?? old?.market_class ?? '', newcar_priced: d.newcar_priced ?? old?.newcar_priced ?? false });
}
// 기존 순서를 보존하고(diff 최소화) 새 행은 id 순으로 뒤에 붙인다.
const order = new Map(entries.map((e, i) => [e.id, i]));
out.sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e9) - (order.has(b.id) ? order.get(b.id) : 1e9) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const body = Array.isArray(current) ? out : { ...current, entries: out };
writeFileSync(outPath, JSON.stringify(body, null, 2).replace(/\n/g, eol) + (raw.endsWith('\n') ? eol : ''), 'utf8');
if (reportPath) {
  const nowIds = new Set(out.map(e => e.id));
  const added = out.filter(e => !byId.has(e.id));
  const removed = entries.filter(e => !nowIds.has(e.id));
  const renamed = out.filter(e => byId.has(e.id) && [e.maker, e.model, e.sub_model].join('|') !== [byId.get(e.id).maker, byId.get(e.id).model, byId.get(e.id).sub_model].join('|'));
  const trimsChanged = out.filter(e => byId.has(e.id) && JSON.stringify([...(byId.get(e.id).trims ?? [])].sort()) !== JSON.stringify([...(e.trims ?? [])].sort()));
  const lines = [`기존 스냅샷 ${entries.length}행 → 새 ${out.length}행 (프리패스 데이터 ${docs.length}행 중 폐기 표시·이름 없음 ${docs.length - live.length} 제외)`,
    `추가 ${added.length} · 제거 ${removed.length} · 이름(제조사·모델·세부모델) 변경 ${renamed.length} · 세부트림 목록 변경 ${trimsChanged.length}`,
    '', '## 제거(프리패스 데이터에서 폐기 표시되었거나 이름 없음)', ...removed.map(e => `- ${e.id} | ${e.maker} ${e.model} ${e.sub_model}`),
    '', '## 이름 변경', ...renamed.map(e => `- ${e.id} | ${byId.get(e.id).model} / ${byId.get(e.id).sub_model} → ${e.model} / ${e.sub_model}`),
    '', '## 추가', ...added.map(e => `- ${e.id} | ${e.maker} ${e.model} ${e.sub_model}`)];
  writeFileSync(reportPath, lines.join('\n'), 'utf8');
}
console.log(JSON.stringify({ before: entries.length, after: out.length, projectDocs: docs.length }));

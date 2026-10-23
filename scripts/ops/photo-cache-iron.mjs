// 아이언(RP006): 홈피 상세 페이지의 차량 사진(supabase 공개 버킷)을 photo_link(상세 주소)·photo_cache{src,urls} 로 잇는다. 이미 있는 값은 건드리지 않는다.
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { gcloudUserToken } from '../../dist/src/infra/source-cycle-firestore.js';
const dir = process.env.SOURCE_CYCLE_PRIVATE_DIR; const apply = process.argv.includes('--apply');
if (apply) {
  const { ensureWriterLease } = await import('../../dist/src/runtime/ensure-writer-lease.js');
  await ensureWriterLease(process.env, 'photo');
}
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; FreePassPhotoLink/1.0)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sm = await (await fetch('https://ironrentcar.com/sitemap.xml', { headers: UA })).text();
const pages = [...new Set([...sm.matchAll(new RegExp('<loc>(https://ironrentcar\\.com/vehicles/[0-9a-f-]{36}[^<]*)</loc>', 'g'))].map(m => m[1].replace(/&amp;/g, '&')))];
const IMG = new RegExp('https://cbtbscasurhavjvjfvpv\\.supabase\\.co/storage/v1/object/public/vehicle-product-images/vehicle-products/[A-Za-z0-9_.-]+\\.(?:webp|jpg|jpeg|png)', 'g');
const PLATE = new RegExp('<dt>차량번호</dt><dd>([^<]+)</dd>');
const byPlate = new Map(); const fails = [];
for (const url of pages) {
  try {
    const res = await fetch(url, { headers: UA }); if (!res.ok) { fails.push(url.slice(-12) + ':' + res.status); continue; }
    const html = await res.text();
    const decoded = html.replace(/%3A/gi, ':').replace(/%2F/gi, '/');
    const m = PLATE.exec(html); const plate = m ? m[1].replace(/\s+/g, '') : '';
    const imgs = [...new Set(decoded.match(IMG) ?? [])];
    if (plate && imgs.length) byPlate.set(plate, { url, imgs: imgs.slice(0, 12) }); else fails.push(url.slice(-12) + ':no-plate-or-img');
  } catch (e) { fails.push(url.slice(-12) + ':' + String(e.message).slice(0, 20)); }
  await sleep(250);
}
const tok = await gcloudUserToken(); const H = { authorization: 'Bearer ' + tok, 'content-type': 'application/json' };
const dec = v => { if (v == null) return v; if ('nullValue' in v) return null; if ('stringValue' in v) return v.stringValue; if ('integerValue' in v) return Number(v.integerValue); if ('booleanValue' in v) return v.booleanValue; if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])); if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec); return v; };
const r = await fetch('https://firestore.googleapis.com/v1/projects/freepasserp5/databases/(default)/documents:runQuery', { method: 'POST', headers: H, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'products' }], where: { fieldFilter: { field: { fieldPath: 'provider_company_code' }, op: 'EQUAL', value: { stringValue: 'RP006' } } } } }) });
const docs = (await r.json()).filter(x => x.document).map(x => x.document);
const targets = []; const noPage = [];
for (const d of docs) {
  const f = dec({ mapValue: { fields: d.fields } }); if (f.listable !== true) continue;
  if (f.photo_cache && Array.isArray(f.photo_cache.urls) && f.photo_cache.urls.length) continue;
  const plate = String(f.car_number).replace(/\s+/g, ''); const s = byPlate.get(plate);
  if (!s) { noPage.push(plate.slice(-4)); continue; }
  targets.push({ name: d.name, updateTime: d.updateTime, l4: plate.slice(-4), url: s.url, imgs: s.imgs, hasLink: typeof f.photo_link === 'string' && f.photo_link.trim() !== '' });
}
console.log(`상세 ${pages.length} · 사진 확보 ${byPlate.size} · 실패 ${fails.length}(${fails.slice(0, 4).join(',')}) · 채울 대상 ${targets.length} · 상세에 없음 ${noPage.length}(${noPage.join(',')})`);
mkdirSync(dir + '/backups-ironphoto', { recursive: true });
let ok = 0;
for (const t of targets) {
  if (!apply) continue;
  const cur = await (await fetch('https://firestore.googleapis.com/v1/' + t.name, { headers: H })).json();
  writeFileSync(`${dir}/backups-ironphoto/${t.l4}-${Date.now()}.json`, JSON.stringify(cur), 'utf8');
  const q = new URLSearchParams(); q.append('updateMask.fieldPaths', 'photo_cache'); if (!t.hasLink) q.append('updateMask.fieldPaths', 'photo_link'); q.set('currentDocument.updateTime', t.updateTime);
  const fields = { photo_cache: { mapValue: { fields: { src: { stringValue: t.url }, urls: { arrayValue: { values: t.imgs.map(u => ({ stringValue: u })) } } } } } };
  if (!t.hasLink) fields.photo_link = { stringValue: t.url };
  const w = await fetch('https://firestore.googleapis.com/v1/' + t.name + '?' + q, { method: 'PATCH', headers: H, body: JSON.stringify({ fields }) });
  if (!w.ok) { console.log(t.l4, 'FAILED', w.status); continue; }
  const g = dec({ mapValue: { fields: (await (await fetch('https://firestore.googleapis.com/v1/' + t.name, { headers: H })).json()).fields } });
  if (g.photo_cache?.urls?.length === t.imgs.length) { ok++; appendFileSync(dir + '/audit-ironphoto.jsonl', JSON.stringify({ at: new Date().toISOString(), l4: t.l4, n: t.imgs.length }) + '\n'); }
}
if (apply) console.log('APPLIED', ok + '/' + targets.length);

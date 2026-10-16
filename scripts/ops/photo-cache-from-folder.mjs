import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { gcloudUserToken } from '../../dist/src/infra/source-cycle-firestore.js';
const dir = process.env.SOURCE_CYCLE_PRIVATE_DIR; const apply = process.argv.includes('--apply'); const only = process.argv.find(a => a.startsWith('--code='))?.slice(7) ?? 'RP023';
const gws = process.env.GWS_BIN;
const run = (a, p) => JSON.parse((s => s.slice(s.indexOf('{')))(execFileSync(gws, a.concat(['--params', JSON.stringify(p)]), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })));
const FOLDER = new RegExp('/folders/([A-Za-z0-9_-]{20,})');
const tok = await gcloudUserToken(); const H = { authorization: 'Bearer ' + tok, 'content-type': 'application/json' };
const dec = v => { if (v == null) return v; if ('nullValue' in v) return null; if ('stringValue' in v) return v.stringValue; if ('integerValue' in v) return Number(v.integerValue); if ('booleanValue' in v) return v.booleanValue; if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])); if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec); return v; };
const r = await fetch('https://firestore.googleapis.com/v1/projects/freepasserp5/databases/(default)/documents:runQuery', { method: 'POST', headers: H, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'products' }], where: { compositeFilter: { op: 'AND', filters: [{ fieldFilter: { field: { fieldPath: 'provider_company_code' }, op: 'EQUAL', value: { stringValue: only } } }, { fieldFilter: { field: { fieldPath: 'listable' }, op: 'EQUAL', value: { booleanValue: true } } }] } } } }) });
const docs = (await r.json()).filter(x => x.document).map(x => x.document);
mkdirSync(dir + '/backups-docfolder', { recursive: true });
let n = 0, ok = 0, empty = 0, nolink = 0;
for (const d of docs) {
  const f = dec({ mapValue: { fields: d.fields } });
  if ((f.photo_cache?.urls?.length ?? 0) > 0) continue;
  const m = FOLDER.exec(String(f.photo_link ?? '')); if (!m) { nolink++; continue; }
  n++;
  let files = []; try { files = run(['drive', 'files', 'list'], { q: `'${m[1]}' in parents and trashed=false and mimeType contains 'image/'`, fields: 'files(id,name)', pageSize: 40 }).files ?? []; } catch { files = []; }
  files.sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true }));
  const urls = files.slice(0, 10).map(x => `https://drive.google.com/thumbnail?id=${x.id}&sz=w640`);
  if (!urls.length) { empty++; console.log(String(f.car_number).slice(-4), '폴더 이미지 없음/접근 불가'); continue; }
  if (!apply) { ok++; continue; }
  writeFileSync(`${dir}/backups-docfolder/${only}-${String(f.car_number).slice(-4)}-${Date.now()}.json`, JSON.stringify(d), 'utf8');
  const q = new URLSearchParams(); q.append('updateMask.fieldPaths', 'photo_cache'); q.set('currentDocument.updateTime', d.updateTime);
  const body = { fields: { photo_cache: { mapValue: { fields: { src: { stringValue: String(f.photo_link) }, urls: { arrayValue: { values: urls.map(u => ({ stringValue: u })) } } } } } } };
  const w = await fetch('https://firestore.googleapis.com/v1/' + d.name + '?' + q, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
  if (!w.ok) { console.log('FAILED', w.status); continue; }
  ok++; appendFileSync(dir + '/audit-docfolder.jsonl', JSON.stringify({ at: new Date().toISOString(), code: only, l4: String(f.car_number).slice(-4), n: urls.length }) + '\n');
}
console.log(`${apply ? 'APPLIED' : 'PLAN'} ${only}: 폴더 링크 있고 캐시 없음 ${n} · 채움 ${ok} · 이미지 없음 ${empty} · photo_link 없음 ${nolink}`);

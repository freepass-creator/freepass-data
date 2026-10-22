import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { gcloudUserToken } from '../../dist/src/infra/source-cycle-firestore.js';
const dir = process.env.SOURCE_CYCLE_PRIVATE_DIR; const apply = process.argv.includes('--apply'); const only = process.argv.find(a => a.startsWith('--code='))?.slice(7) ?? 'RP023';
const gws = process.env.GWS_BIN;
const run = (a, p) => JSON.parse((s => s.slice(s.indexOf('{')))(execFileSync(gws, a.concat(['--params', JSON.stringify(p)]), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })));
const FOLDER = new RegExp('/folders/([A-Za-z0-9_-]{20,})');
const tok = await gcloudUserToken(); const H = { authorization: 'Bearer ' + tok, 'content-type': 'application/json' };
const dec = v => { if (v == null) return v; if ('nullValue' in v) return null; if ('stringValue' in v) return v.stringValue; if ('integerValue' in v) return Number(v.integerValue); if ('booleanValue' in v) return v.booleanValue; if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])); if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec); return v; };
// ── CSV 모드(2026-10-22 PC1 커맨드): --folders=<번호,폴더 CSV> 면 번호 폴더로 photo_link + photo_cache 를 함께 쓴다(빈 캐시 문서만, 폴더 전체 최대 40장, 서류·사용X 제외).
//   사용: node scripts/ops/photo-cache-from-folder.mjs --folders=<csv> --code=RP004 [--max=40] [--apply]   (기본은 계획만, 쓰기 0)
const csvArg = process.argv.find(a => a.startsWith('--folders='))?.slice(10);
if (csvArg !== undefined) {
  if (!csvArg) throw new Error('FOLDERS_CSV_PATH_REQUIRED');
  if (!process.argv.some(a => /^--code=RP\d{3}$/.test(a))) throw new Error('CODE_REQUIRED_FOR_CSV_MODE');   // 기본값(RP023)으로 다른 공급사 문서를 쓰지 않는다
  const { readFileSync } = await import('node:fs');
  const { planPhotoCacheFromFolder } = await import('../../dist/src/application/photo-cache-folder-plan.js');
  const maxArg = Number(process.argv.find(a => a.startsWith('--max='))?.slice(6) ?? 40);
  const folderOf = v => FOLDER.exec(v)?.[1] ?? (/^[A-Za-z0-9_-]{20,}$/.test(v.trim()) ? v.trim() : null);
  const csvLines = readFileSync(csvArg, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  if (!/^(번호|차량번호)\s*,/.test(csvLines[0] ?? '')) throw new Error('CSV_HEADER_INVALID');   // 헤더 «번호,폴더» 필수(첫 행을 데이터로 버리지 않는다)
  const csvRows = csvLines.slice(1)
    .map(l => { const i = l.indexOf(','); return i > 0 ? { plate: l.slice(0, i).trim().replace(/\s+/g, ''), folder: folderOf(l.slice(i + 1)) } : null; })
    .filter(x => x && x.plate && x.folder);
  const seenPlates = new Set();
  for (const x of csvRows) { if (seenPlates.has(x.plate)) throw new Error('CSV_DUPLICATE_PLATE'); seenPlates.add(x.plate); }   // 같은 번호에 폴더 둘 → 사람이 하나로 정한 뒤 다시
  let failures = 0;
  // 맵 키 순서는 Firestore 가 바꿔 돌려줄 수 있다 — 되읽기 대조는 키를 정렬해 비교한다(2026-10-22 적용 시 9건이 키 순서 때문에 MISMATCH 로 오판).
  const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
  const base ='https://firestore.googleapis.com/v1/projects/freepasserp5/databases/(default)/documents/products/';
  mkdirSync(dir + '/backups-docfolder', { recursive: true });
  for (const x of csvRows) {
    const l4 = x.plate.slice(-4);
    const res = await fetch(base + encodeURIComponent(x.plate), { headers: H });
    if (!res.ok) { console.log(l4, res.status === 404 ? '문서 없음' : '문서 읽기 실패 ' + res.status); continue; }
    const d = await res.json(); const f = dec({ mapValue: { fields: d.fields } });
    let folderName = ''; try { folderName = run(['drive', 'files', 'get'], { fileId: x.folder, fields: 'name', supportsAllDrives: true }).name || ''; } catch { console.log(l4, '폴더 이름 조회 실패'); continue; }
    const listed = []; let page = null, pages = 0;
    do {
      const p = run(['drive', 'files', 'list'], { q: `'${x.folder}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`,
        fields: 'nextPageToken,files(id,name,mimeType,size,sha256Checksum)', pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true, ...(page ? { pageToken: page } : {}) });
      listed.push(...(p.files ?? [])); page = p.nextPageToken; pages++;
    } while (page && pages < 20);
    const now = new Date().toISOString();
    const plan = planPhotoCacheFromFolder({ plate: x.plate, expectedProvider: only, doc: f, folder: { id: x.folder, name: folderName }, max: maxArg, now,
      files: listed.map(y => ({ id: y.id, name: String(y.name ?? ''), mimeType: y.mimeType ?? null, size: Number(y.size) || null, sha256: y.sha256Checksum ?? null })) });
    if (plan.status !== 'WRITE') { console.log(l4, '건너뜀', plan.reason, JSON.stringify(plan.excluded ?? {})); continue; }
    console.log(l4, '계획', plan.count + '장', plan.setLink ? '(photo_link 새로)' : '(photo_link 유지)', JSON.stringify(plan.excluded), apply ? '' : '(시험)');
    if (!apply) continue;
    writeFileSync(`${dir}/backups-docfolder/${only}-${l4}-csv-${Date.now()}.json`, JSON.stringify(d), 'utf8');
    // 하위 칸만 마스크로 쓴다(photo_cache 안의 다른 키는 보존), 문서가 그사이 바뀌었으면 updateTime 조건으로 거절.
    const q = new URLSearchParams(); for (const p of ['photo_cache.src', 'photo_cache.urls', 'photo_cache.at']) q.append('updateMask.fieldPaths', p);
    if (plan.setLink) q.append('updateMask.fieldPaths', 'photo_link'); q.set('currentDocument.updateTime', d.updateTime);
    const str = v => ({ stringValue: v });
    const fields = { photo_cache: { mapValue: { fields: { src: str(plan.cache.src), urls: { arrayValue: { values: plan.cache.urls.map(str) } }, at: str(plan.cache.at) } } }, ...(plan.setLink ? { photo_link: str(plan.photoLink) } : {}) };
    const w = await fetch(base + encodeURIComponent(x.plate) + '?' + q, { method: 'PATCH', headers: H, body: JSON.stringify({ fields }) });
    if (!w.ok) { console.log(l4, '쓰기 실패', w.status); failures++; continue; }
    const rb = await fetch(base + encodeURIComponent(x.plate), { headers: H });
    const bd = rb.ok ? await rb.json() : null; const back = bd ? dec({ mapValue: { fields: bd.fields } }) : null;
    const same = !!back && back.photo_cache?.src === plan.cache.src && back.photo_cache?.at === plan.cache.at && String(back.photo_link ?? '').trim() === plan.photoLink
      && JSON.stringify(back.photo_cache?.urls) === JSON.stringify(plan.cache.urls)
      && Object.keys(f).filter(k => !['photo_cache', 'photo_link'].includes(k)).every(k => JSON.stringify(canon(f[k])) === JSON.stringify(canon(back[k])));   // 다른 칸 불변
    console.log(l4, '되읽기', same ? 'MATCH' : 'MISMATCH', plan.count + '장');
    if (!same) failures++;
    appendFileSync(dir + '/audit-docfolder.jsonl', JSON.stringify({ at: now, code: only, l4, n: plan.count, mode: 'csv', ok: same }) + '\n');
  }
  if (failures) { console.log('실패 ' + failures + '건 — 종료 코드 1'); process.exit(1); }
  process.exit(0);
}
const r = await fetch('https://firestore.googleapis.com/v1/projects/freepasserp5/databases/(default)/documents:runQuery', { method: 'POST', headers: H, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'products' }], where: { compositeFilter: { op: 'AND', filters: [{ fieldFilter: { field: { fieldPath: 'provider_company_code' }, op: 'EQUAL', value: { stringValue: only } } }, { fieldFilter: { field: { fieldPath: 'listable' }, op: 'EQUAL', value: { booleanValue: true } } }] } } } }) });
const docs = (await r.json()).filter(x => x.document).map(x => x.document);
mkdirSync(dir + '/backups-docfolder', { recursive: true });
let n = 0, ok = 0, empty = 0, nolink = 0;
for (const d of docs) {
  const f = dec({ mapValue: { fields: d.fields } });
  if ((f.photo_cache?.urls?.length ?? 0) > 0) continue;
  const m = FOLDER.exec(String(f.photo_link ?? '')); if (!m) { nolink++; continue; }
  n++;
  // 엔진이 F05 차량번호 칸 링크로 채운 photo_link(photo_link_source.kind SHARED_SHEET_PLATE_LINK, 2026-10-22): CSV 모드와 같은 계획 함수로 검증한다 —
  // 폴더 이름 번호 일치(불일치 거절)·사용X/서류 폴더 거절·서류 비율 보류·폴더 전체 최대 40장. 사람·옛 도구가 넣은 링크는 아래 옛 방식 그대로.
  if (f.photo_link_source?.kind === 'SHARED_SHEET_PLATE_LINK') {
    const l4 = String(f.car_number).slice(-4);
    const { planPhotoCacheFromFolder } = await import('../../dist/src/application/photo-cache-folder-plan.js');
    let folderName = ''; try { folderName = run(['drive', 'files', 'get'], { fileId: m[1], fields: 'name', supportsAllDrives: true }).name || ''; } catch { empty++; console.log(l4, '폴더 이름 조회 실패'); continue; }
    const listed = []; let page = null, pages = 0;
    try {
      do {
        const p = run(['drive', 'files', 'list'], { q: `'${m[1]}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`,
          fields: 'nextPageToken,files(id,name,mimeType,size,sha256Checksum)', pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true, ...(page ? { pageToken: page } : {}) });
        listed.push(...(p.files ?? [])); page = p.nextPageToken; pages++;
      } while (page && pages < 20);
    } catch { empty++; console.log(l4, '폴더 목록 조회 실패'); continue; }
    const at = new Date().toISOString();
    const plan = planPhotoCacheFromFolder({ plate: String(f.car_number ?? ''), expectedProvider: only, doc: f, folder: { id: m[1], name: folderName }, now: at,
      files: listed.map(y => ({ id: y.id, name: String(y.name ?? ''), mimeType: y.mimeType ?? null, size: Number(y.size) || null, sha256: y.sha256Checksum ?? null })) });
    if (plan.status !== 'WRITE' || plan.setLink) { empty++; console.log(l4, '건너뜀', plan.status === 'WRITE' ? 'LINK_STATE' : plan.reason); continue; }
    if (!apply) { ok++; console.log(l4, '계획', plan.count + '장', '(시트 링크, 시험)'); continue; }
    writeFileSync(`${dir}/backups-docfolder/${only}-${l4}-sheet-${Date.now()}.json`, JSON.stringify(d), 'utf8');
    const q = new URLSearchParams(); for (const p of ['photo_cache.src', 'photo_cache.urls', 'photo_cache.at']) q.append('updateMask.fieldPaths', p);
    q.set('currentDocument.updateTime', d.updateTime);
    const str = v => ({ stringValue: v });
    const w = await fetch('https://firestore.googleapis.com/v1/' + d.name + '?' + q, { method: 'PATCH', headers: H,
      body: JSON.stringify({ fields: { photo_cache: { mapValue: { fields: { src: str(plan.cache.src), urls: { arrayValue: { values: plan.cache.urls.map(str) } }, at: str(plan.cache.at) } } } } }) });
    if (!w.ok) { console.log(l4, '쓰기 실패', w.status); continue; }
    ok++; appendFileSync(dir + '/audit-docfolder.jsonl', JSON.stringify({ at, code: only, l4, n: plan.count, mode: 'sheet-link' }) + '\n');
    continue;
  }
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

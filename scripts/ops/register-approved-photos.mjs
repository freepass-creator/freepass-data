// 드라이브 번호 폴더 이미지 → products/{차량번호}.photo_original_refs[] 등록(승인 사진, 방법 AUTO_KAKAO_COLLECT).
// 입력: CSV(헤더 «번호,폴더» 또는 «차량번호,폴더링크»; 폴더는 ID 또는 drive.google.com/drive/folders/<ID> 링크).
// 사용: node scripts/ops/register-approved-photos.mjs <링크목록.csv | --root <공급사 폴더 ID·링크>> [--apply] [--max 10] [--by <등록자 이름>] [--method AUTO_KAKAO_COLLECT|IANCAR_COMPRESSED_COPY|SONOGONG_DRIVE_COPY]
// --root: 공급사 사진 루트 폴더(예: freepasspics/손오공)의 직계 «번호 [차종]» 폴더를 전부 읽어 CSV 대신 쓴다. 같은 번호 폴더가 둘 이상이면 그 번호는 등록하지 않는다.
// SONOGONG_DRIVE_COPY(손오공 드라이브 사본, 2026-10-15 대표 «구글 드라이브에 오니까 데이터 담당이 연결»): 공급사 RP012 문서이고 photo_original_refs 가 «비어 있을 때만» 쓴다.
// IANCAR_COMPRESSED_COPY(이안카 압축 사본, copy:iancar-photos 결과 CSV): 공급사 RP031 문서이고 photo_original_refs 가 «비어 있을 때만» 쓴다(있으면 건너뜀, 덮어쓰지 않음).
// 안전: 기본은 계획만(쓰기 0). 적용 시 문서별 백업(비공개 디렉터리)·updateTime 조건·한 건씩 되읽기. 서류 하위 폴더는 직계 이미지만 읽어 자동 제외.
// 필요: gws(드라이브 읽기, sha256Checksum 사용 — 바이트를 내려받지 않는다), gcloud 사용자 토큰, FIREBASE_PROJECT_ID(없으면 freepasserp5), dist 빌드.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { gcloudUserToken } from '../../dist/src/infra/source-cycle-firestore.js';
import { vehiclePhotoKey } from '../../dist/src/domain/consumer-output-contract.js';
import { folderMatchesPlate, plateFoldersFromChildren } from '../../dist/src/domain/photo-folder-match.js';   // 폴더↔차량번호 일치 검증(Codex 검토)

const rootAt = process.argv.indexOf('--root'); const ROOT = rootAt > 0 ? process.argv[rootAt + 1] : null;
const csvPath = ROOT ? null : process.argv[2];
const apply = process.argv.includes('--apply');
const maxAt = process.argv.indexOf('--max'); const MAX = Math.max(1, Math.min(50, maxAt > 0 ? Number(process.argv[maxAt + 1]) : 10));
const byAt = process.argv.indexOf('--by'); const BY = (byAt > 0 ? process.argv[byAt + 1] : 'b3q-auto-register').slice(0, 60);
const methodAt = process.argv.indexOf('--method'); const METHOD = methodAt > 0 ? process.argv[methodAt + 1] : 'AUTO_KAKAO_COLLECT';
// 공급사 사본 등록 방법 → 허용 공급사(그 공급사 문서이고 사진 칸이 비어 있을 때만 쓴다).
const SUPPLIER_COPY = { IANCAR_COMPRESSED_COPY: 'RP031', SONOGONG_DRIVE_COPY: 'RP012' };
if (!['AUTO_KAKAO_COLLECT', ...Object.keys(SUPPLIER_COPY)].includes(METHOD)) throw new Error('METHOD_NOT_ALLOWED');
if (!csvPath && !ROOT) throw new Error('usage: register-approved-photos <csv | --root <폴더>> [--apply] [--max N] [--by 이름] [--method AUTO_KAKAO_COLLECT|IANCAR_COMPRESSED_COPY|SONOGONG_DRIVE_COPY]');
const project = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
const dir = process.env.SOURCE_CYCLE_PRIVATE_DIR || '.';
const gws = process.env.GWS_BIN || 'gws';
const run = (a, p) => JSON.parse((s => s.slice(s.indexOf('{')))(execFileSync(gws, a.concat(['--params', JSON.stringify(p)]), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })));
const MEDIA = { 'image/jpeg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp' };
const folderIdOf = v => { const m = /\/folders\/([A-Za-z0-9_-]{20,})/.exec(v); return m ? m[1] : /^[A-Za-z0-9_-]{20,}$/.test(v.trim()) ? v.trim() : null; };
const rows = ROOT ? [] : readFileSync(csvPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1)
  .map(l => { const i = l.indexOf(','); return i > 0 ? { plate: l.slice(0, i).trim().replace(/\s+/g, ''), folder: folderIdOf(l.slice(i + 1)) } : null; })
  .filter(r => r && r.plate && r.folder);
const tok = await gcloudUserToken();
const H = { authorization: 'Bearer ' + tok, 'content-type': 'application/json' };
const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/products/`;
const dec = v => { if (v == null || 'nullValue' in v) return null; if ('stringValue' in v) return v.stringValue; if ('integerValue' in v) return Number(v.integerValue); if ('doubleValue' in v) return v.doubleValue; if ('booleanValue' in v) return v.booleanValue; if ('timestampValue' in v) return v.timestampValue; if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])); if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec); return null; };
const enc = v => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'string' ? { stringValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
mkdirSync(dir + '/backups-approved-photos', { recursive: true });
const out = [];
if (ROOT) {
  const rootId = folderIdOf(ROOT);
  if (!rootId) throw new Error('ROOT_FOLDER_INVALID');
  const children = []; let pageToken;
  do {
    const page = run(['drive', 'files', 'list'], { q: `'${rootId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`, fields: 'nextPageToken,files(id,name)',
      pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true, ...(pageToken ? { pageToken } : {}) });
    children.push(...(page.files ?? [])); pageToken = page.nextPageToken;
  } while (pageToken);
  const found = plateFoldersFromChildren(children);
  rows.push(...found.rows);
  out.push(`루트 폴더: 번호 폴더 ${found.rows.length}개, 같은 번호 중복 ${found.ambiguous.length}개(등록 안 함), 번호 아님 ${found.skipped}개`);
}

// 문서 ID 가 번호가 아닌 공급사가 있다(이안카 = iancar_<해시>): 번호 ID 문서가 없으면 car_number 로 «정확히 1건» 찾는다. 여러 건이면 등록하지 않는다.
const queryUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:runQuery`;
async function docIdFor(plate) {
  const direct = await fetch(base + encodeURIComponent(plate), { headers: H });
  if (direct.status !== 404) return { id: plate, res: direct };
  const q = await fetch(queryUrl, { method: 'POST', headers: H, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'products' }],
    where: { fieldFilter: { field: { fieldPath: 'car_number' }, op: 'EQUAL', value: { stringValue: plate } } }, limit: 3 } }) });
  const hits = q.ok ? (await q.json()).filter(x => x.document) : [];
  if (hits.length !== 1) return { id: null, many: hits.length > 1 };
  const id = hits[0].document.name.split('/').pop();
  return { id, res: await fetch(base + encodeURIComponent(id), { headers: H }) };
}

for (const r of rows) {
  const found = await docIdFor(r.plate);
  if (!found.id) { out.push(`${r.plate.slice(-4)} ${found.many ? '문서 여러 개 — 등록 안 함' : '문서 없음'}`); continue; }
  const docId = found.id; const res = found.res;
  const doc = await res.json(); const f = dec({ mapValue: { fields: doc.fields } });
  const key = vehiclePhotoKey(f);
  if (!key) { out.push(`${r.plate.slice(-4)} vehicleKey 불가(공급사 코드 없음)`); continue; }
  if (SUPPLIER_COPY[METHOD]) {
    if (f.provider_company_code !== SUPPLIER_COPY[METHOD]) { out.push(`${r.plate.slice(-4)} ${SUPPLIER_COPY[METHOD]} 문서 아님`); continue; }
    if (Array.isArray(f.photo_original_refs) && f.photo_original_refs.length) { out.push(`${r.plate.slice(-4)} 이미 사진 있음(빈 칸만 씀)`); continue; }
  }
  // 공유 드라이브(freepasserp.com) 폴더도 읽는다: supportsAllDrives·includeItemsFromAllDrives.
  let folderName = '';
  try { folderName = run(['drive', 'files', 'get'], { fileId: r.folder, fields: 'name', supportsAllDrives: true }).name || ''; } catch { out.push(`${r.plate.slice(-4)} 폴더 이름 조회 실패 — 등록 안 함`); continue; }
  if (!folderMatchesPlate(folderName, r.plate)) { out.push(`${r.plate.slice(-4)} 폴더 이름이 차량번호와 다름 — 등록 안 함`); continue; }
  const files = (run(['drive', 'files', 'list'], { q: `'${r.folder}' in parents and trashed=false and mimeType contains 'image/'`, fields: 'files(id,name,mimeType,size,sha256Checksum)', pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true }).files ?? [])
    .filter(x => MEDIA[x.mimeType] && /^[a-f0-9]{64}$/.test(x.sha256Checksum ?? '') && Number(x.size) > 0 && Number(x.size) <= 8 * 1024 * 1024)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true })).slice(0, MAX);
  if (!files.length) { out.push(`${r.plate.slice(-4)} 폴더 이미지 없음/체크섬 없음`); continue; }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const refs = files.map(x => ({ driveFileId: x.id, sha256: x.sha256Checksum, mediaType: MEDIA[x.mimeType], role: 'VEHICLE_PHOTO', zone: '차량사진', vehicleKey: key, approvedAt: now,
    vehiclePhotoVerifiedBy: BY, vehiclePhotoVerificationMethod: METHOD, vehiclePhotoVerifiedAt: now }));
  const prior = Array.isArray(f.photo_original_refs) ? f.photo_original_refs.length : 0;
  out.push(`${r.plate.slice(-4)} 계획 ${refs.length}장(기존 ${prior}장) ${apply ? '' : '(시험)'}`);
  if (!apply) continue;
  writeFileSync(`${dir}/backups-approved-photos/${r.plate.slice(-4)}-${Date.now()}.json`, JSON.stringify(doc), 'utf8');
  const q = new URLSearchParams(); q.append('updateMask.fieldPaths', 'photo_original_refs'); q.set('currentDocument.updateTime', doc.updateTime);
  const w = await fetch(base + encodeURIComponent(docId) + '?' + q, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { photo_original_refs: enc(refs) } }) });
  if (!w.ok) { out.push(`${r.plate.slice(-4)} 쓰기 실패 ${w.status}`); continue; }
  const back = dec({ mapValue: { fields: (await (await fetch(base + encodeURIComponent(docId), { headers: H })).json()).fields } });
  const ok = Array.isArray(back.photo_original_refs) && back.photo_original_refs.length === refs.length && back.photo_original_refs.every((x, i) => x.driveFileId === refs[i].driveFileId && x.sha256 === refs[i].sha256);
  out.push(`${r.plate.slice(-4)} 되읽기 ${ok ? 'MATCH' : 'MISMATCH'}`);
  appendFileSync(dir + '/audit-approved-photos.jsonl', JSON.stringify({ at: now, l4: r.plate.slice(-4), n: refs.length, prior, method: METHOD, ok }) + '\n');
}
console.log(out.join('\n'));

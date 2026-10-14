// 드라이브 번호 폴더 이미지 → products/{차량번호}.photo_original_refs[] 등록(승인 사진, 방법 AUTO_KAKAO_COLLECT).
// 입력: CSV(헤더 «번호,폴더» 또는 «차량번호,폴더링크»; 폴더는 ID 또는 drive.google.com/drive/folders/<ID> 링크).
// 사용: node scripts/ops/register-approved-photos.mjs <링크목록.csv> [--apply] [--max 10] [--by <등록자 이름>] [--method AUTO_KAKAO_COLLECT|IANCAR_COMPRESSED_COPY]
// IANCAR_COMPRESSED_COPY(이안카 압축 사본, copy:iancar-photos 결과 CSV): 공급사 RP031 문서이고 photo_original_refs 가 «비어 있을 때만» 쓴다(있으면 건너뜀, 덮어쓰지 않음).
// 안전: 기본은 계획만(쓰기 0). 적용 시 문서별 백업(비공개 디렉터리)·updateTime 조건·한 건씩 되읽기. 서류 하위 폴더는 직계 이미지만 읽어 자동 제외.
// 필요: gws(드라이브 읽기, sha256Checksum 사용 — 바이트를 내려받지 않는다), gcloud 사용자 토큰, FIREBASE_PROJECT_ID(없으면 freepasserp5), dist 빌드.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { gcloudUserToken } from '../../dist/src/infra/source-cycle-firestore.js';
import { vehiclePhotoKey } from '../../dist/src/domain/consumer-output-contract.js';
import { folderMatchesPlate } from '../../dist/src/domain/photo-folder-match.js';   // 폴더↔차량번호 일치 검증(Codex 검토)

const csvPath = process.argv[2];
const apply = process.argv.includes('--apply');
const maxAt = process.argv.indexOf('--max'); const MAX = Math.max(1, Math.min(50, maxAt > 0 ? Number(process.argv[maxAt + 1]) : 10));
const byAt = process.argv.indexOf('--by'); const BY = (byAt > 0 ? process.argv[byAt + 1] : 'b3q-auto-register').slice(0, 60);
const methodAt = process.argv.indexOf('--method'); const METHOD = methodAt > 0 ? process.argv[methodAt + 1] : 'AUTO_KAKAO_COLLECT';
if (!['AUTO_KAKAO_COLLECT', 'IANCAR_COMPRESSED_COPY'].includes(METHOD)) throw new Error('METHOD_NOT_ALLOWED');
if (!csvPath) throw new Error('usage: register-approved-photos <csv> [--apply] [--max N] [--by 이름] [--method AUTO_KAKAO_COLLECT|IANCAR_COMPRESSED_COPY]');
const project = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
const dir = process.env.SOURCE_CYCLE_PRIVATE_DIR || '.';
const gws = process.env.GWS_BIN || 'gws';
const run = (a, p) => JSON.parse((s => s.slice(s.indexOf('{')))(execFileSync(gws, a.concat(['--params', JSON.stringify(p)]), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })));
const MEDIA = { 'image/jpeg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp' };
const folderIdOf = v => { const m = /\/folders\/([A-Za-z0-9_-]{20,})/.exec(v); return m ? m[1] : /^[A-Za-z0-9_-]{20,}$/.test(v.trim()) ? v.trim() : null; };
const rows = readFileSync(csvPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1)
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

for (const r of rows) {
  const res = await fetch(base + encodeURIComponent(r.plate), { headers: H });
  if (res.status === 404) { out.push(`${r.plate.slice(-4)} 문서 없음`); continue; }
  const doc = await res.json(); const f = dec({ mapValue: { fields: doc.fields } });
  const key = vehiclePhotoKey(f);
  if (!key) { out.push(`${r.plate.slice(-4)} vehicleKey 불가(공급사 코드 없음)`); continue; }
  if (METHOD === 'IANCAR_COMPRESSED_COPY') {
    if (f.provider_company_code !== 'RP031') { out.push(`${r.plate.slice(-4)} 이안카 문서 아님`); continue; }
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
  const w = await fetch(base + encodeURIComponent(r.plate) + '?' + q, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { photo_original_refs: enc(refs) } }) });
  if (!w.ok) { out.push(`${r.plate.slice(-4)} 쓰기 실패 ${w.status}`); continue; }
  const back = dec({ mapValue: { fields: (await (await fetch(base + encodeURIComponent(r.plate), { headers: H })).json()).fields } });
  const ok = Array.isArray(back.photo_original_refs) && back.photo_original_refs.length === refs.length && back.photo_original_refs.every((x, i) => x.driveFileId === refs[i].driveFileId && x.sha256 === refs[i].sha256);
  out.push(`${r.plate.slice(-4)} 되읽기 ${ok ? 'MATCH' : 'MISMATCH'}`);
  appendFileSync(dir + '/audit-approved-photos.jsonl', JSON.stringify({ at: now, l4: r.plate.slice(-4), n: refs.length, prior, method: METHOD, ok }) + '\n');
}
console.log(out.join('\n'));

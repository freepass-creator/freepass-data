// 사진 연결 승격 계획(읽기 전용): 드라이브 번호 폴더 목록 × 상품 문서 스냅샷 → 등록 도구용 CSV(번호,폴더) + 보류 목록.
//   node scripts/ops/plan-photo-links.mjs <folders.json> <products.json> <out.csv> [--max N] [--include-existing]
// folders.json: [{ id, name(=차량번호), files:[{id,name,mimeType,size,sha256Checksum}] }]   (gws 드라이브 목록 결과를 B3Q 가 정리)
// products.json: [{ plate, listable, photoRefCount, hasVehicleKey }]
// 쓰기: out.csv(전체 번호 포함 → 비공개 디렉터리에만). 표준 출력에는 끝 4자리 보류 목록만. 이어서 scripts/ops/register-approved-photos.mjs <out.csv> [--apply] 가 백업·되읽기와 함께 등록한다.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [foldersPath, productsPath, outPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!foldersPath || !productsPath || !outPath) throw new Error('usage: plan-photo-links <folders.json> <products.json> <out.csv> [--max N] [--include-existing]');
const maxAt = process.argv.indexOf('--max');
const mod = await import(pathToFileURL(join(process.cwd(), 'dist', 'src', 'application', 'photo-link-promotion.js')).href);
const plan = mod.planPhotoLinks(JSON.parse(readFileSync(foldersPath, 'utf8')), JSON.parse(readFileSync(productsPath, 'utf8')),
  { ...(maxAt > 0 ? { maxPerRun: Number(process.argv[maxAt + 1]) } : {}), includeExisting: process.argv.includes('--include-existing') });
writeFileSync(outPath, mod.photoLinkCsv(plan), { mode: 0o600 });
console.log(JSON.stringify({ status: 'PLAN_BUILT', writes: 0, ...plan.stats, held: plan.held }, null, 2));

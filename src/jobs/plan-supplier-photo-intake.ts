/** 공급사 사진 인입 계획(DRY_RUN, 쓰기 0): 드라이브 폴더 스냅숏 + 상품 스냅숏 JSON → 매칭·분류 계획 요약.
 *   npm run plan:supplier-photo-intake -- --input <snapshot.json> [--max-vehicles 50]
 * 입력 JSON: { "suppliers": [ { "supplierCode": "RP012", "folders": [ {id,name,files:[{id,name,mimeType,size,sha256}](sha256 없는 이미지는 «체크섬 없음»으로 제외),subfolderCount} ], "products": [ {plate,hasPhotoRefs} ] } ] }
 * 환경: FREEPASS_DATA_PHOTO_INTAKE_SUPPLIERS(기본 비어 있음 = 아무것도 안 함), FREEPASS_DATA_PHOTO_COPY_SUPPLIERS(서빙 허용표).
 * 출력: 끝 4자리 번호와 건수만(파일 id·이름·전체 번호 없음). 이 잡은 드라이브·Firestore 를 읽지도 쓰지도 않는다. 종료 코드: 0 정상 · 2 설정 오류. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parsePhotoCopySuppliers } from '../domain/consumer-output-contract.js';
import { INTAKE_MAX_VEHICLES_PER_RUN, intakeSuppliers, planSupplierIntake, summarizeSupplierPlan, type IntakeSupplierInput } from '../application/supplier-photo-intake-plan.js';

export function planSupplierPhotoIntakeCli(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void = console.log): number {
  const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const input = arg('--input');
  if (!input) { log('설정 오류: --input <snapshot.json> 필요'); return 2; }
  const maxRaw = arg('--max-vehicles');
  const maxVehicles = maxRaw === undefined ? undefined : Number(maxRaw);
  if (maxVehicles !== undefined && (!Number.isInteger(maxVehicles) || maxVehicles < 1)) { log('설정 오류: --max-vehicles 는 1 이상의 정수'); return 2; }
  const targets = intakeSuppliers(env.FREEPASS_DATA_PHOTO_INTAKE_SUPPLIERS, parsePhotoCopySuppliers(env.FREEPASS_DATA_PHOTO_COPY_SUPPLIERS));
  if (targets.size === 0) { log('인입 대상 공급사 없음(FREEPASS_DATA_PHOTO_INTAKE_SUPPLIERS 비어 있음·허용표 밖) — 처리 안 함'); return 0; }
  let snapshot: { suppliers?: IntakeSupplierInput[] };
  try { snapshot = JSON.parse(readFileSync(input, 'utf8')); } catch { log('설정 오류: 스냅숏 JSON 을 읽을 수 없음'); return 2; }
  if (!Array.isArray(snapshot.suppliers)) { log('설정 오류: suppliers 배열 없음'); return 2; }
  log('모드: DRY_RUN(쓰기 0)');
  // 회차 상한은 공급사마다가 아니라 «전체 합산»이다(Codex #690 (b)): 앞 공급사가 쓴 대수를 뺀 나머지만 다음 공급사에 준다.
  let remaining = maxVehicles ?? INTAKE_MAX_VEHICLES_PER_RUN;
  for (const supplier of snapshot.suppliers) {
    const plan = planSupplierIntake(supplier, { allowedSuppliers: targets, maxVehicles: remaining });
    remaining = Math.max(0, remaining - plan.counts.PLANNED);
    for (const line of summarizeSupplierPlan(plan)) log(line);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(planSupplierPhotoIntakeCli(process.argv.slice(2), process.env));

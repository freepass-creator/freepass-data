import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createIancarOneApiClient, IANCAR_ONE_PAGE_SIZE } from '../adapters/iancar-one-api.js';

// 직접 확인(읽기 전용, 저장 없음): 이안카 ONE API 를 그 순간 읽는다. 기존 어댑터의 «요청 층»(createIancarOneApiClient)만 쓰고
// 수집 함수(collectIancarOne*: 페이지 지문·적재 준비)는 거치지 않는다. 열쇠는 비밀 저장소에서 이 프로세스 안으로만 읽고 출력하지 않는다.
//   tsx src/jobs/read-iancar-source.ts                       목록 전체(요약)
//   tsx src/jobs/read-iancar-source.ts --plate4 6235         그 차 하나: 상세 + 기간별 요금
//   --out <저장소 밖 경로.json>                               원천 응답 그대로(차량번호 포함) — 증거용
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const plate4 = arg('--plate4'), out = arg('--out');
// 차량번호 전체가 들어가는 증거 파일은 저장소(.git 이 있는 폴더) 밖에만 쓴다.
const assertOutsideRepo = (path: string | undefined) => {
  if (!path) return;
  for (let dir = dirname(resolve(path)); ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, '.git'))) { console.error('OUTPUT_PATH_INSIDE_REPOSITORY'); process.exit(2); }
    if (dirname(dir) === dir) break;
  }
};
assertOutsideRepo(out); assertOutsideRepo(arg('--map-out'));
const maskPlates = (text: string) => text.replace(/\d{2,3}\s?[가-힣]\s?(\d{4})/g, '…$1'); // 화면 출력의 차량번호는 끝 4자리만
const apiKey = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${process.env.IANCAR_ONE_API_SECRET || 'freepass-data-iancar-one-api'}`,
  `--project=${process.env.FIREBASE_PROJECT_ID || 'freepasserp5'}`], { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const client = createIancarOneApiClient({ apiKey });
const readAt = new Date().toISOString();
const records: Record<string, unknown>[] = []; let syncedAt: string | undefined; let stale: boolean | undefined; let total = 0;
for (let page = 1; page <= 100; page++) {
  const body = await client.listVehicles(page, IANCAR_ONE_PAGE_SIZE) as { success?: boolean; data?: Record<string, unknown>[]; synced_at?: string; stale?: boolean; pagination?: { total?: number; page_size?: number } };
  // fail-closed: 실패 응답·배열 아님·오래된(stale) 응답·총수 없음은 정상 원천으로 쓰지 않는다
  if (body.success !== true || !Array.isArray(body.data) || typeof body.pagination?.total !== 'number') { console.error('IANCAR_LIST_RESPONSE_INVALID'); process.exit(3); }
  if (body.stale === true) { console.error('IANCAR_LIST_STALE'); process.exit(3); }
  // 원천 갱신 시각이 유효하고 신선도 한도(이안카 60분) 안이어야 한다 — 오래된 AVAILABLE 목록으로 편입·재노출을 계획하지 않는다
  const syncedMs = Date.parse(String(body.synced_at ?? ''));
  if (!Number.isFinite(syncedMs) || syncedMs > Date.now() + 60_000 || Date.now() - syncedMs > 60 * 60_000) { console.error('IANCAR_LIST_SYNCED_AT_INVALID_OR_OLD'); process.exit(3); }
  // 페이지마다 같은 회차(synced_at)·같은 총수여야 한다 — 회차가 섞인 목록은 완전 수집이 아니다
  if (page > 1 && (body.synced_at !== syncedAt || body.pagination?.total !== total)) { console.error('IANCAR_LIST_PAGES_INCONSISTENT'); process.exit(3); }
  records.push(...(body.data ?? [])); syncedAt = body.synced_at; stale = body.stale; total = body.pagination?.total ?? records.length;
  if (!body.data?.length || records.length >= total) break;
}
// fail-closed: 목록이 응답한 총수와 읽은 수가 다르면 불완전 — 쓰기 전 계획의 입력으로 쓰지 못하게 종료한다.
// 차량별 상태 검증(어댑터 규칙과 같음): 상태 enum·available boolean·서로 일관 — 누락·불일치는 판매 불가/가능으로 추정하지 않고 중단
const STATUSES = ['AVAILABLE', 'RESERVED', 'RENTED', 'PREPARING', 'UNAVAILABLE'];
if (records.some(r => !STATUSES.includes(String(r.inventory_status)) || typeof r.available !== 'boolean' || r.available !== (r.inventory_status === 'AVAILABLE'))) { console.error('IANCAR_VEHICLE_STATUS_INVALID'); process.exit(3); }
const idSeen = new Set(records.map(r => String(r.vehicle_id ?? ''))), plateSeen = new Set(records.map(r => String(r.plate_number ?? '').replace(/\s+/g, '')));
if (idSeen.size !== records.length || idSeen.has('') || plateSeen.size !== records.length || plateSeen.has('')) { console.error('IANCAR_LIST_DUPLICATE_OR_MISSING_ID'); process.exit(3); } // 페이지 중복·식별자 누락은 완전 수집이 아니다
if (records.length !== total) { console.error(`IANCAR_LIST_INCOMPLETE read=${records.length} total=${total}`); process.exit(3); }
if (process.argv.includes('--conditions')) { // 전 차량 기간별 요금·보증금(조건) 직접 읽기 — 차량당 getRates 1회, 동시 3
  const mapOut = arg('--map-out');
  const rows: Record<string, unknown>[] = []; let next = 0; const keys = new Set<string>();
  const worker = async () => { for (;;) { const r = records[next++]; if (!r) return;
    const rates = await client.getRates(String(r.vehicle_id)) as { success?: boolean; data?: Array<Record<string, unknown>> };
    if (rates.success !== true || !Array.isArray(rates.data)) { console.error('IANCAR_RATES_RESPONSE_INVALID'); process.exit(3); }
    const price: Record<string, { rent: unknown; deposit: unknown }> = {}; const lowest = new Map<number, number>();
    for (const t of rates.data ?? []) { const m = Number(t.rental_period), km = Number(t.contracted_mileage);
      const key = `${m}_${t.mileage_period === 'month' ? '월' : '연'}${km}km`; price[key] = { rent: t.monthly_rate, deposit: t.deposit }; keys.add(key);
      if ((lowest.get(m) ?? Infinity) > km) { lowest.set(m, km); price[String(m)] = { rent: t.monthly_rate, deposit: t.deposit }; keys.add(String(m)); } }
    rows.push({ plate_number: r.plate_number, status: r.inventory_status, price }); } };
  await Promise.all([worker(), worker(), worker()]);
  if (out) writeFileSync(out, JSON.stringify({ readAt, syncedAt, stale, total, records: rows }));
  if (mapOut) writeFileSync(mapOut, JSON.stringify({ car_number: 'plate_number', ...Object.fromEntries([...keys].flatMap(k => [[`price.${k}.rent`, `price.${k}.rent`], [`price.${k}.deposit`, `price.${k}.deposit`]])) }));
  console.log(JSON.stringify({ readAt, syncedAt, stale, vehicles: rows.length, termKeys: keys.size }));
} else if (plate4) {
  const hit = records.filter(r => String(r.plate_number ?? '').replace(/\s/g, '').endsWith(plate4));
  const detail = [];
  for (const r of hit) {
    const id = String(r.vehicle_id);
    const [vehicle, rates] = await Promise.all([client.getVehicle(id), client.getRates(id)]) as [{ success?: boolean; data?: unknown }, { success?: boolean; data?: unknown }];
    // fail-closed: 상세·요금이 실패 응답이면 목록값·빈 요금으로 대체하지 않고 중단
    if (vehicle.success !== true || typeof vehicle.data !== 'object' || vehicle.data === null || rates.success !== true || !Array.isArray(rates.data)) { console.error('IANCAR_DETAIL_OR_RATES_RESPONSE_INVALID'); process.exit(3); }
    // 상세에도 목록과 같은 상태·신선도·식별자 검증(상세가 목록과 다른 상태를 주면 중단)
    const dv = vehicle.data as Record<string, unknown>;
    if (!['AVAILABLE', 'RESERVED', 'RENTED', 'PREPARING', 'UNAVAILABLE'].includes(String(dv.inventory_status)) || typeof dv.available !== 'boolean' || dv.available !== (dv.inventory_status === 'AVAILABLE')
      || dv.stale === true || String(dv.vehicle_id) !== id || String(dv.plate_number ?? '').replace(/\s+/g, '') !== String(r.plate_number ?? '').replace(/\s+/g, '')
      || String(dv.inventory_status) !== String(r.inventory_status)) { console.error('IANCAR_DETAIL_STATUS_INVALID_OR_MISMATCH'); process.exit(3); }
    detail.push({ list: r, vehicle, rates });
  }
  if (out) writeFileSync(out, JSON.stringify({ readAt, syncedAt, stale, detail }));
  console.log(maskPlates(JSON.stringify({ readAt, syncedAt, stale, 찾음: hit.length, detail: detail.map(d => ({ ...d, list: { ...d.list, plate_number: `…${plate4}` } })) }, null, 1)));
} else {
  if (out) writeFileSync(out, JSON.stringify({ capturedAt: readAt, syncedAt, stale, total, records }));
  console.log(JSON.stringify({ capturedAt: readAt, syncedAt, stale, total, records: records.length, fields: Object.keys(records[0] ?? {}) }, null, 1));
}

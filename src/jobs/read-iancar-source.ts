import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createIancarOneApiClient, IANCAR_ONE_PAGE_SIZE } from '../adapters/iancar-one-api.js';

// 직접 확인(읽기 전용, 저장 없음): 이안카 ONE API 를 그 순간 읽는다. 기존 어댑터의 «요청 층»(createIancarOneApiClient)만 쓰고
// 수집 함수(collectIancarOne*: 페이지 지문·적재 준비)는 거치지 않는다. 열쇠는 비밀 저장소에서 이 프로세스 안으로만 읽고 출력하지 않는다.
//   tsx src/jobs/read-iancar-source.ts                       목록 전체(요약)
//   tsx src/jobs/read-iancar-source.ts --plate4 6235         그 차 하나: 상세 + 기간별 요금
//   --out <저장소 밖 경로.json>                               원천 응답 그대로(차량번호 포함) — 증거용
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const plate4 = arg('--plate4'), out = arg('--out');
const apiKey = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${process.env.IANCAR_ONE_API_SECRET || 'freepass-data-iancar-one-api'}`,
  `--project=${process.env.FIREBASE_PROJECT_ID || 'freepasserp5'}`], { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const client = createIancarOneApiClient({ apiKey });
const readAt = new Date().toISOString();
const records: Record<string, unknown>[] = []; let syncedAt: string | undefined; let stale: boolean | undefined; let total = 0;
for (let page = 1; page <= 100; page++) {
  const body = await client.listVehicles(page, IANCAR_ONE_PAGE_SIZE) as { data?: Record<string, unknown>[]; synced_at?: string; stale?: boolean; pagination?: { total?: number; page_size?: number } };
  records.push(...(body.data ?? [])); syncedAt = body.synced_at; stale = body.stale; total = body.pagination?.total ?? records.length;
  if (!body.data?.length || records.length >= total) break;
}
if (process.argv.includes('--conditions')) { // 전 차량 기간별 요금·보증금(조건) 직접 읽기 — 차량당 getRates 1회, 동시 3
  const mapOut = arg('--map-out');
  const rows: Record<string, unknown>[] = []; let next = 0; const keys = new Set<string>();
  const worker = async () => { for (;;) { const r = records[next++]; if (!r) return;
    const rates = await client.getRates(String(r.vehicle_id)) as { data?: Array<Record<string, unknown>> };
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
    const [vehicle, rates] = await Promise.all([client.getVehicle(id), client.getRates(id)]);
    detail.push({ list: r, vehicle, rates });
  }
  if (out) writeFileSync(out, JSON.stringify({ readAt, syncedAt, stale, detail }));
  console.log(JSON.stringify({ readAt, syncedAt, stale, 찾음: hit.length, detail: detail.map(d => ({ ...d, list: { ...d.list, plate_number: `…${plate4}` } })) }, null, 1));
} else {
  if (out) writeFileSync(out, JSON.stringify({ capturedAt: readAt, syncedAt, stale, total, records }));
  console.log(JSON.stringify({ capturedAt: readAt, syncedAt, stale, total, records: records.length, fields: Object.keys(records[0] ?? {}) }, null, 1));
}

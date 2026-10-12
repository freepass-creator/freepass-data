// 이안카 ONE 원천 갱신 주기 관측 — 목록 1건만 읽는다(쓰기·적재 없음, 토큰 0).
// 열쇠는 환경변수 EANCAR_ONE_API_KEY 에서만 읽고 출력하지 않는다.
// 목적: 공급사 synced_at 이 우리 15분 신선도 기준(900초) 안에 드는 비율과 갱신 간격을 실측해 수집 주기 결정을 돕는다.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const FRESHNESS_LIMIT_MS = 900_000;

/** entries: [{ at: ISO 관측 시각, syncedAt: ISO 공급사 갱신 시각, stale: boolean }] 시간순 */
export function summarize(entries) {
  const rows = entries.filter(e => e && Date.parse(e.at) && Date.parse(e.syncedAt));
  if (!rows.length) return { samples: 0 };
  const changes = [];
  let prev = null;
  for (const r of rows) {
    if (prev && r.syncedAt !== prev) changes.push(r.syncedAt);
    prev = r.syncedAt;
  }
  const intervalsMin = changes.slice(1).map((t, i) => Math.round((Date.parse(t) - Date.parse(changes[i])) / 60000));
  const fresh = rows.filter(r => !r.stale && Date.parse(r.at) - Date.parse(r.syncedAt) <= FRESHNESS_LIMIT_MS).length;
  const last = rows.at(-1);
  return {
    samples: rows.length,
    freshRatio: Number((fresh / rows.length).toFixed(3)),
    observedChanges: changes.length,
    intervalsMin,
    lastAgeMin: Math.round((Date.parse(last.at) - Date.parse(last.syncedAt)) / 60000),
    lastSyncedAt: last.syncedAt
  };
}

export async function probeOnce(key, fetchImpl = fetch, now = () => new Date()) {
  const res = await fetchImpl('https://eancarone.com/v1/vehicles?page=1&page_size=1', { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`ONE_HTTP_${res.status}`);
  const body = await res.json();
  const data = body.data ?? body;
  const syncedAt = body.synced_at ?? data.synced_at;
  const stale = body.stale ?? data.stale;
  if (typeof syncedAt !== 'string' || typeof stale !== 'boolean') throw new Error('ONE_SHAPE_UNEXPECTED');
  return { at: now().toISOString(), syncedAt, stale };
}

if (process.argv[1]?.endsWith('iancar-one-freshness.mjs')) {
  const file = process.argv[2];
  if (!file) { console.error('사용: node scripts/iancar-one-freshness.mjs <기록파일.jsonl> [--summary]'); process.exit(64); }
  if (!process.argv.includes('--summary')) {
    const key = process.env.EANCAR_ONE_API_KEY;
    if (!key) { console.error('EANCAR_ONE_API_KEY 필요'); process.exit(64); }
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(await probeOnce(key)) + '\n');
  }
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  console.log(JSON.stringify(summarize(lines)));
}

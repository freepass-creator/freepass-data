// 공급사 갱신 신선도 계산 — 순수 함수(입출력 없음). 읽기 전용 도구 scripts/supplier-freshness.mjs 가 쓴다.
// 구분: «우리 수집 관측»(_var_polled_at 등, 우리가 물어본 시각)과 «공급사 변경 관측»(내용 지문이 달라진 시각)을 섞지 않는다.
import { createHash } from 'node:crypto';

export const DIGEST_FIELDS = ['price', 'status', 'status_label_raw', 'vehicle_status', 'status_kind', 'mileage', 'options', '원문', 'listable'];
export const STALE_FACTOR = 3;
export const MIN_INTERVALS = 3; // 평소 주기를 믿으려면 변경이 있었던 회차가 최소 이만큼
export const OUR_STALE_HOURS = 6; // 판매 중 차량의 우리 관측 경과 중앙값이 이보다 크면 «우리 수집 정체»

export const sha = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const stable = v => Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
export const digestOf = fields => sha(JSON.stringify(stable(Object.fromEntries(DIGEST_FIELDS.map(k => [k, fields[k] ?? null])))));

export function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decodeValue(x)]));
  return null;
}

// 숫자(밀리초 또는 초)·ISO 문자열 → 밀리초. 해석 불가면 null.
export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
export function ourObservedMs(f) {
  const all = ['_var_polled_at', '_direct_ingest_at', '_mirror_at', '_var_synced_at'].map(k => toMs(f[k])).filter(x => x != null);
  return all.length ? Math.max(...all) : null;
}

export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1))];
}
const median = a => percentile([...a].sort((x, y) => x - y), 0.5);

// state: { vehicles: {id:{sup,digest,firstSeen,lastChange,lastObserved}}, runs: [{t, baseline, sup:{code:{changed,n}}}] }
export function emptyState() { return { version: 2, vehicles: {}, runs: [], sup: {} }; }
export const BURST_MERGE_MS = 3600_000; // 1시간 안의 연속 변경 관측은 공급사의 한 번 갱신으로 본다
export const NEVER_CHANGED_STALE_H = 72; // 기준선 이후 이 시간 동안 변경이 한 번도 없으면 정체

export function applySnapshot(state, rows, nowMs) {
  state.sup ??= {};
  const baseline = Object.keys(state.vehicles).length === 0;
  const perSup = {};
  const seen = new Set();
  for (const r of rows) {
    const code = r.sup || '(미상)';
    const s = (perSup[code] ??= { changed: 0, n: 0 });
    s.n++;
    seen.add(r.id);
    const prev = state.vehicles[r.id];
    if (!prev) {
      state.vehicles[r.id] = { sup: code, digest: r.digest, firstSeen: nowMs, lastChange: baseline ? null : nowMs, lastObserved: r.ourMs };
      if (!baseline) s.changed++; // 새로 나타난 차 = 공급사 변경으로 센다
    } else {
      if (prev.digest !== r.digest) { prev.digest = r.digest; prev.lastChange = nowMs; s.changed++; }
      prev.sup = code; prev.lastObserved = r.ourMs;
    }
  }
  for (const id of Object.keys(state.vehicles)) if (!seen.has(id)) {
    const gone = state.vehicles[id]; delete state.vehicles[id];
    if (!baseline) (perSup[gone.sup] ??= { changed: 0, n: 0 }).changed++; // 목록에서 사라진 차(판매·삭제)도 공급사 변경
  }
  for (const [code, s] of Object.entries(perSup)) {
    const rec = (state.sup[code] ??= { firstRunMs: nowMs, lastChangeMs: null, gapsH: [] });
    if (baseline || s.changed === 0) continue;
    if (rec.lastChangeMs != null && nowMs - rec.lastChangeMs >= BURST_MERGE_MS) rec.gapsH = [...rec.gapsH, (nowMs - rec.lastChangeMs) / 3600_000].slice(-20);
    rec.lastChangeMs = nowMs;
  }
  state.runs.push({ t: nowMs, baseline, sup: perSup });
  state.runs = state.runs.filter(x => x.t >= nowMs - 30 * 86400_000); // 30일만 보관
  return state;
}

// 공급사별 지표. rows: 이번 스냅샷 {id,sup,listable,ourMs}
export function computeMetrics(state, rows, nowMs, { staleFactor = STALE_FACTOR } = {}) {
  const day = 86400_000, hour = 3600_000;
  const out = {};
  for (const r of rows) {
    const code = r.sup || '(미상)';
    const m = (out[code] ??= { code, total: 0, listable: 0, _obs: [], _tch: [], _chg: [], changed24h: 0 });
    m.total++;
    const v = state.vehicles[r.id];
    if (v?.lastChange != null && nowMs - v.lastChange <= day) m.changed24h++;
    if (r.listable) {
      m.listable++;
      if (r.ourMs != null) m._obs.push((nowMs - r.ourMs) / hour);
      if (r.touchedMs != null) m._tch.push((nowMs - r.touchedMs) / hour);
      if (v?.lastChange != null) m._chg.push((nowMs - v.lastChange) / hour);
    }
  }
  const realRuns = state.runs.filter(x => !x.baseline);
  for (const m of Object.values(out)) {
    const rec = state.sup?.[m.code];
    m.lastChangeMs = rec?.lastChangeMs ?? null;
    m.typicalIntervalH = rec && rec.gapsH.length >= MIN_INTERVALS - 1 ? median(rec.gapsH) : null;
    m.sinceFirstRunH = rec ? (nowMs - rec.firstRunMs) / hour : null;
    m.stampCoverage = m.listable ? m._obs.length / m.listable : null;
    const obs = m._obs.sort((a, b) => a - b), chg = m._chg.sort((a, b) => a - b);
    const tch = m._tch.sort((a, b) => a - b);
    m.anyWriteAgeH = { median: percentile(tch, 0.5), p90: percentile(tch, 0.9) }; // 문서가 마지막으로 쓰인 시각(어떤 작성자든) — 수집 관측의 상한 근거
    m.ourObservedAgeH = { median: percentile(obs, 0.5), p90: percentile(obs, 0.9) };
    m.sinceChangeH = { median: percentile(chg, 0.5), p90: percentile(chg, 0.9) };
    m.sinceLastChangeH = m.lastChangeMs == null ? null : (nowMs - m.lastChangeMs) / hour;
    delete m._obs; delete m._chg; delete m._tch;
    m.verdict = verdictOf(m, realRuns.length, staleFactor);
  }
  return Object.values(out).sort((a, b) => b.listable - a.listable);
}

// 우리 수집이 멈춘 것(관측 도장 경과가 큼)과 공급사 정체(우리는 계속 물었는데 변경이 없음)를 분리한다. 우리 쪽이 먼저다.
export function verdictOf(m, realRunCount, staleFactor = STALE_FACTOR) {
  const stampOld = m.ourObservedAgeH.median == null || m.ourObservedAgeH.median > OUR_STALE_HOURS || (m.stampCoverage ?? 1) < 0.5;
  // 문서 마지막 쓰기(anyWriteAgeH)는 전 상품에 일괄 점검이 쓰므로 근거로 쓰지 않는다(참고 열). 도장이 없거나 오래되면 «관측 도장 정체»
  // — 시트 계열은 이 도장을 안 찍을 수 있어 «우리 수집 정체 확정»이 아니라 source_runs 로 확인할 후보다.
  if (m.listable && stampOld) return 'OBSERVATION_STAMP_STALE';
  if (m.lastChangeMs == null && realRunCount >= MIN_INTERVALS && (m.sinceFirstRunH ?? 0) > NEVER_CHANGED_STALE_H) return 'SUPPLIER_STALE'; // 기준선 이후 변경 0
  if (realRunCount < MIN_INTERVALS || m.typicalIntervalH == null) return 'BASELINE_COLLECTING';
  if (m.sinceLastChangeH != null && m.sinceLastChangeH > m.typicalIntervalH * staleFactor) return 'SUPPLIER_STALE';
  return 'OK';
}

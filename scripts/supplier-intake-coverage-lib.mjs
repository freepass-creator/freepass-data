// 새 수집 파이프라인(source_runs→raw) 편입 현황 계산 — 순수 함수. 읽기 전용 도구 scripts/supplier-intake-coverage.mjs 가 쓴다.
// 차량번호는 해시로만 다룬다(출력·저장 금지).
import { createHash } from 'node:crypto';

export const sha = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
export const normalizePlate = value => String(value ?? '').replace(/\s+/g, '');

// 공급사 코드 → 공통 시트 탭 이름. 시트 탭이 없는 공급사(아이카 RP004)는 직접 수집기 run 이 생기기 전까지 편입 0 이다.
export const SUPPLIER_ROUTES = Object.freeze({
  RP021: { label: '빌린카', sheetTab: '빌린카', nativeSourcePrefix: null },
  RP004: { label: '아이카', sheetTab: null, nativeSourcePrefix: 'supplier:RP004:' }
});

/**
 * products: [{plate, supplier, listable}], rawRows: [{tab, plate}] (최신 완료 공통 시트 run 의 raw), runs: [{sourceId, observedAt, status}]
 * 편입률 = 판매 중 차량 중 «최신 완료 run 의 원문에 같은 차량번호가 있는» 비율.
 */
export function intakeCoverage({ products, rawRows, runs, nowMs, routes = SUPPLIER_ROUTES }) {
  const rawByTab = new Map();
  for (const r of rawRows) {
    const p = normalizePlate(r.plate);
    if (!p) continue;
    const key = r.tab ?? '';
    if (!rawByTab.has(key)) rawByTab.set(key, new Set());
    rawByTab.get(key).add(sha(p));
  }
  const completedLatest = prefix => runs
    .filter(r => r.status === 'COMPLETED' && r.sourceId?.startsWith(prefix))
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0] ?? null;
  return Object.entries(routes).map(([code, route]) => {
    const mine = products.filter(p => p.supplier === code);
    const sold = mine.filter(p => p.listable === true);
    const tabSet = route.sheetTab ? rawByTab.get(route.sheetTab) ?? new Set() : new Set();
    const intaken = route.sheetTab ? sold.filter(p => tabSet.has(sha(normalizePlate(p.plate)))).length : 0;
    const lastRun = route.sheetTab ? completedLatest('shared-sheet:') : completedLatest(route.nativeSourcePrefix);
    return { code, label: route.label, route: route.sheetTab ? 'SHARED_SHEET' : 'NATIVE_COLLECTOR',
      listable: sold.length, total: mine.length, intaken, intakeRate: sold.length ? +(intaken / sold.length).toFixed(3) : null,
      rawPlatesInTab: route.sheetTab ? tabSet.size : null, lastRunObservedAt: lastRun?.observedAt ?? null,
      lastRunAgeMin: lastRun ? Math.round((nowMs - Date.parse(lastRun.observedAt)) / 60000) : null,
      verdict: !sold.length ? 'NO_LISTABLE' : intaken === sold.length ? 'FULL' : intaken === 0 ? 'NOT_INTAKEN' : 'PARTIAL' };
  });
}

export function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  return null;
}
export const decodeFields = fields => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeValue(v)]));

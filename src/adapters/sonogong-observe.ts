/** 손오공(RP012) 원천 ↔ ERP5 문서 차이표(관측 전용, 쓰기 0).
 * 사용자 대조(2026-10-14): 손오공 화면 331대 vs 우리 반영 135대(−196). 엔진 RP012 는 관측 전용이고 ERP4 는 변동값만 기존 문서에 써서
 * 신규 편입 경로가 없었다. 이 모듈은 읽기 결과(버킷 관측)와 문서에서 «원천에만(NEW)/문서에만(MISSING)/양쪽(SAME)» 을 번호 기준으로 센다.
 * 번호는 끝 4자리만 내보내고, 상태 칸은 값의 분포(열거값)만 센다. */
import { classifySonokongRecord } from '../domain/consumer-output-contract.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import type { SonogongBucketObservation } from './supplier-source-capture.js';

type Json = Record<string, unknown>;
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const last4 = (plate: string) => plate.replace(/\D/g, '').slice(-4);
const STATUS_KEY = /status|state|stage|상태/i;
const SAFE_KEY = /^[A-Za-z_]{1,30}$/;
/** 보고 파일에 남는 상태 값은 열거형으로 보이는 짧은 값만이다: 숫자가 섞인 문자열(차량번호·연락처)·긴 메모는 «기타» 로 바꾼다(독립 검토: 40자 절단은 비식별이 아니다). */
const ALLOWED_STATUS_VALUES: ReadonlySet<string> = new Set([
  '즉시출고', '출고가능', '출고협의', '상품화중', '차량검수', '계약중', '출고불가', '배차문의', '수리중', '배차중', '배차가능', '게시', '미게시',
  'AVAILABLE', 'PREPARING', 'RESERVED', 'CONTRACT', 'CONTRACTED', 'SOLD', 'UNAVAILABLE', 'HOLD', 'ACTIVE', 'INACTIVE', 'PENDING', 'READY', 'CLOSED', 'DELIVERED']);
/** 명시적 열거만 값을 남긴다(독립 검토 2026-10-14: 패턴 검사는 «홍길동» 같은 이름을 통과시켰다). 그 밖의 문자열·큰 수는 «기타». */
const safeStatusValue = (value: string | number | boolean): string => {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) < 1000 ? String(value) : '기타';
  const v = value.trim();
  return ALLOWED_STATUS_VALUES.has(v) ? v : '기타';
};

const hasPrice = (detail: Json | null) => Array.isArray(detail?.estimates) && (detail!.estimates as unknown[]).some(e => object(e)
  && e.creditType === 'LOW' && [12, 24, 36, 48, 60].some(m => {
    const v = e[`monthly${m}`];
    return v !== undefined && v !== null && v !== '' && Number(v) > 0;
  }));

export type SonogongObservedVehicle = { id: string; plate: string | null; bucket: string; carSource: string; commercialType: string | null;
  priced: boolean; detailMissing: boolean; statusValues: Record<string, string> };

export function readSonogongVehicles(observations: readonly SonogongBucketObservation[]): SonogongObservedVehicle[] {
  const out: SonogongObservedVehicle[] = [];
  for (const observation of observations) for (const record of observation.records) {
    const list = record.list, plateRaw = typeof list.carNumber === 'string' ? list.carNumber.replace(/\s+/g, '') : '';
    const cls = classifySonokongRecord({ bucket: list.carSource, plateNumber: list.carNumber });
    const statusValues: Record<string, string> = {};
    for (const source of [list, record.detail ?? {}]) for (const [key, value] of Object.entries(source)) {
      if (STATUS_KEY.test(key) && SAFE_KEY.test(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) statusValues[key] = safeStatusValue(value);
    }
    out.push({ id: String(list.id), plate: isAssignedPlate(plateRaw) ? plateIdentityKey(plateRaw) : null, bucket: observation.bucket,
      carSource: String(list.carSource ?? ''), commercialType: cls.status === 'CLASSIFIED' ? cls.commercialType : null,
      priced: hasPrice(record.detail), detailMissing: record.detail === null, statusValues });
  }
  return out;
}

export function summarizeSonogong(observations: readonly SonogongBucketObservation[],
  docs: ReadonlyArray<{ plate: string | null; listable: boolean; status?: string | null }>) {
  const vehicles = readSonogongVehicles(observations);
  const plates = new Map<string, SonogongObservedVehicle>();
  const duplicatePlates: string[] = [];
  for (const v of vehicles) if (v.plate) { if (plates.has(v.plate)) duplicatePlates.push(v.plate); else plates.set(v.plate, v); }
  const docByPlate = new Map<string, { listable: boolean; status: string }>();
  for (const d of docs) if (d.plate && isAssignedPlate(d.plate)) docByPlate.set(plateIdentityKey(d.plate), { listable: d.listable, status: d.status ?? '' });
  const onlySource = [...plates.keys()].filter(p => !docByPlate.has(p)).sort();
  const onlyDocs = [...docByPlate.keys()].filter(p => !plates.has(p)).sort();
  const both = [...plates.keys()].filter(p => docByPlate.has(p));
  const tally = (list: Array<string | null>) => list.reduce<Record<string, number>>((acc, k) => { const key = k ?? 'UNCLASSIFIED'; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {});
  const statusTally: Record<string, Record<string, number>> = {};
  for (const v of vehicles) for (const [k, val] of Object.entries(v.statusValues)) { (statusTally[k] ??= {})[val] = (statusTally[k]![val] ?? 0) + 1; }
  const docsExposed = [...docByPlate.values()].filter(d => d.listable).length;
  // 형식 오류·빈 버킷·선언 총계 불일치를 «0건 정상» 으로 읽지 않는다(B3Q 독립 검토 지적 ③과 같은 기준).
  const invalidBuckets = observations.filter(o => !o.complete || o.records.length === 0 || o.records.length !== o.declaredTotal
    || o.records.some(r => !object(r.list) || r.list.id === undefined || r.list.id === null)).map(o => o.bucket);
  return {
    valid: observations.length > 0 && invalidBuckets.length === 0, invalidBuckets,
    buckets: observations.map(o => ({ bucket: o.bucket, declaredTotal: o.declaredTotal, rows: o.records.length,
      detailFailures: o.records.filter(r => r.detail === null).length, complete: o.complete, observedAt: o.observedAt })),
    sourceVehicles: vehicles.length, sourceWithPlate: plates.size, sourceWithoutPlate: vehicles.filter(v => !v.plate).length,
    duplicatePlateCount: duplicatePlates.length, detailMissing: vehicles.filter(v => v.detailMissing).length,
    sourceByCommercialType: tally(vehicles.map(v => v.commercialType)),
    sourcePriced: vehicles.filter(v => v.priced).length, sourceUnpriced: vehicles.filter(v => !v.priced).length,
    statusFieldValues: statusTally,
    docs: docByPlate.size, docsExposed,
    both: both.length, newCount: onlySource.length, missingCount: onlyDocs.length,
    newByCommercialType: tally(onlySource.map(p => plates.get(p)!.commercialType)),
    newPriced: onlySource.filter(p => plates.get(p)!.priced).length,
    newLast4: onlySource.map(last4).sort(), missingLast4: onlyDocs.map(last4).sort(),
  };
}

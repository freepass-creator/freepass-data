import { decodeErp5Value, inspectErp5Capture, type Erp5SourceCapture } from './erp5-source-capture.js';
import { plateIdentityKey, isAssignedPlate } from '../domain/vehicle-plate.js';
import type { F03Snapshot, VehicleIdentity } from '../domain/vehicle-identity-resolution.js';
import { stableDigest } from '../shared/stable-digest.js';

export const F03_SPREADSHEET_ID = '1oMB9eoNnQFxUyRK4CSxYh_hKrtCf7s_79xLs-GYwXCE';
export const F03_RANGES = ["'차종마스터'!A1:S", "'별칭'!A1:H"] as const;
const F03_MAIN = ['원산지', '제조사', '모델', '세부모델', '세부트림', '생산시작', '생산종료'];
const F03_ALIAS = ['구분', '옛 이름(원본·이전 표기)', '모델', 'F03 표시명', 'F03 세부모델행키'];

export type VehicleIdentityInputs = {
  schema: 'vehicle-identity-inputs/v1';
  f03: F03Snapshot; f03ReadAt: string; f03Digest: string;
  /** Existing FreePass Data identity by plate. Plates seen with conflicting values are dropped (no Data value). */
  data: Array<{ plate: string; identity: VehicleIdentity }>; dataReadTime: string; dataDigest: string;
};

/** F03 values.batchGet (main tab, alias tab) → snapshot. Rows marked 「통합→」 in 클로드 엔카대조 are merged rows and excluded. */
export function f03SnapshotFromBatchGet(raw: { valueRanges?: Array<{ values?: unknown[][] }> }): F03Snapshot {
  const [main, alias] = raw?.valueRanges ?? [];
  const m = (main?.values ?? []) as unknown[][], a = (alias?.values ?? []) as unknown[][];
  const s = (v: unknown) => String(v ?? '').trim();
  const head = (rows: unknown[][], want: string[]) => want.every((h, i) => s(rows[0]?.[i]) === h);
  if (!head(m, F03_MAIN) || !head(a, F03_ALIAS)) throw new Error('F03_SNAPSHOT_HEADER_MISMATCH');
  const mh = m[0]!.map(s), col = (name: string) => mh.indexOf(name);
  const merged = col('클로드 엔카대조'), subKey = col('세부모델행키');
  if (merged < 0 || subKey < 0) throw new Error('F03_SNAPSHOT_HEADER_MISMATCH');
  const rows = m.slice(1).filter(r => s(r[4]) && !s(r[merged]).startsWith('통합→')).map(r => ({
    maker: s(r[1]), model: s(r[2]), subModel: s(r[3]), trimName: s(r[4]), start: s(r[5]), end: s(r[6]), subModelKey: s(r[subKey]) }));
  const aliases = a.slice(1).filter(r => s(r[0]) && s(r[1]) && s(r[3])).map(r => ({
    kind: s(r[0]), oldName: s(r[1]), model: s(r[2]), displayName: s(r[3]), key: s(r[4]) }));
  if (!rows.length) throw new Error('F03_SNAPSHOT_EMPTY');
  return { rows, aliases };
}

/** ERP5 products capture → plate-keyed existing identities (maker/model/sub_model/trim_name as stored, not re-interpreted). */
export function dataIdentitiesFromErp5(capture: Erp5SourceCapture): VehicleIdentityInputs['data'] {
  const byPlate = new Map<string, VehicleIdentity | null>();
  const field = (doc: { fields?: Record<string, unknown> }, k: string) => {
    try { const v = decodeErp5Value(doc.fields?.[k] ?? { nullValue: null }); return typeof v === 'string' ? v.trim() : ''; } catch { return ''; }
  };
  for (const doc of capture.collections.products.documents as Array<{ fields?: Record<string, unknown> }>) {
    const plateRaw = field(doc, 'car_number');
    if (!isAssignedPlate(plateRaw)) continue;
    const plate = plateIdentityKey(plateRaw);
    const id: VehicleIdentity = [field(doc, 'maker'), field(doc, 'model'), field(doc, 'sub_model'), field(doc, 'trim_name')];
    if (!id[0] || !id[1]) continue;
    const seen = byPlate.get(plate);
    byPlate.set(plate, seen === undefined ? id : seen && seen.join('|') === id.join('|') ? seen : null);
  }
  return [...byPlate].filter((e): e is [string, VehicleIdentity] => e[1] !== null).map(([plate, identity]) => ({ plate, identity }))
    .sort((x, y) => x.plate.localeCompare(y.plate));
}

/** Offline: a verified ERP5 capture file already read by the audited `inspect-erp5-source` job. */
export function verifiedErp5CaptureFromJson(json: unknown): Erp5SourceCapture {
  inspectErp5Capture(json as Erp5SourceCapture);
  return json as Erp5SourceCapture;
}
export function buildVehicleIdentityInputs(f03: F03Snapshot, f03ReadAt: string, capture: Erp5SourceCapture): VehicleIdentityInputs {
  const data = dataIdentitiesFromErp5(capture);
  return { schema: 'vehicle-identity-inputs/v1', f03, f03ReadAt, f03Digest: stableDigest(f03),
    data, dataReadTime: capture.readTime, dataDigest: stableDigest(data) };
}
export function assertVehicleIdentityInputs(x: unknown): asserts x is VehicleIdentityInputs {
  const v = x as VehicleIdentityInputs;
  if (!v || v.schema !== 'vehicle-identity-inputs/v1' || !Array.isArray(v.f03?.rows) || !Array.isArray(v.data) ||
      stableDigest(v.f03) !== v.f03Digest || stableDigest(v.data) !== v.dataDigest) throw new Error('VEHICLE_IDENTITY_INPUTS_INVALID');
}

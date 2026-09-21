import { createHash } from 'node:crypto';

/** Offline evidence format. Real consumer mappers must be reviewed separately. */
export type PilotRow = {
  productId: string;
  vehicleId: string;
  offerId: string;
  supplierId: string;
  termKey: string;
  termMonths: number;
  commercialType: string;
  status: string;
  listable: boolean;
  monthlyRent: number;
  currency: 'KRW';
  depositState: 'KNOWN' | 'ZERO' | 'NOT_APPLICABLE';
  depositAmount: number | null;
  mileageLimitKmPerYear: number;
};

type Observation = {
  sourceId: string;
  sourceRevision: string;
  scope: string;
  observedAt: string;
  complete: boolean;
  evidenceRef: string;
};

type Snapshot = Observation & {
  mapperVersion: string;
  expectedRowCount: number;
  rows: PilotRow[];
};

export type ReadPilotInput = {
  version: 'read-pilot/v1';
  consumerId: 'ERP_COM' | 'F01' | 'F86';
  maxAgeMs: number;
  upstream: Snapshot;
  legacy: Snapshot;
  freepass: Snapshot & {
    release: {
      releaseId: string;
      schemaVersion: string;
      inputDigest: string;
      dataDigest: string;
      activatedAt: string;
    };
  };
};

const fields: Array<keyof PilotRow> = [
  'productId', 'vehicleId', 'offerId', 'supplierId', 'termKey', 'termMonths',
  'commercialType', 'status', 'listable', 'monthlyRent', 'currency',
  'depositState', 'depositAmount', 'mileageLimitKmPerYear'
];
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0 && x === x.trim();
const natural = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const timestamp = (x: unknown): x is string => {
  if (!text(x) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(x)
    || !Number.isFinite(Date.parse(x))) return false;
  // Date.parse normalizes some impossible calendar days, e.g. February 30.
  const [year, month, day] = x.slice(0, 10).split('-').map(Number);
  return month! >= 1 && month! <= 12 && day! >= 1
    && day! <= new Date(Date.UTC(year!, month!, 0)).getUTCDate()
    && Number(x.slice(11, 13)) < 24;
};
const key = (row: PilotRow) => JSON.stringify([row.productId, row.offerId, row.termKey]);

export type ReadPilotReport = {
  status: 'HOLD' | 'MISMATCH' | 'SNAPSHOT_MATCH';
  scope: 'OFFLINE_SUPPLIED_EVIDENCE_ONLY';
  cutoverAuthorized: false;
  evidenceDigest: string;
  reasons: string[];
  differences: Array<{ target: 'legacy' | 'freepass'; rowKeyDigest: string; fields: string[] }>;
};

/** No network, database, writes, runtime startup, or implicit fallback. */
export function checkReadPilot(raw: unknown, now = new Date().toISOString()): ReadPilotReport {
  const report: ReadPilotReport = {
    status: 'HOLD', scope: 'OFFLINE_SUPPLIED_EVIDENCE_ONLY', cutoverAuthorized: false,
    evidenceDigest: sha256(JSON.stringify(raw) ?? 'undefined'), reasons: [], differences: []
  };
  const hold = (reason: string) => { report.reasons.push(reason); };
  if (!object(raw) || raw.version !== 'read-pilot/v1'
    || !text(raw.consumerId) || !['ERP_COM', 'F01', 'F86'].includes(raw.consumerId)
    || !natural(raw.maxAgeMs) || raw.maxAgeMs === 0 || !timestamp(now)) {
    hold('INVALID_INPUT_OR_FRESHNESS_POLICY');
    return report;
  }
  const nowMs = Date.parse(now);
  const fresh = (value: unknown) => timestamp(value)
    && Date.parse(value) <= nowMs && nowMs - Date.parse(value) <= Number(raw.maxAgeMs);
  for (const name of ['upstream', 'legacy', 'freepass'] as const) {
    const snapshot = raw[name];
    if (!object(snapshot)) { hold(`${name}:MISSING_OBSERVATION`); continue; }
    for (const field of ['sourceId', 'sourceRevision', 'scope', 'evidenceRef']) {
      if (!text(snapshot[field])) hold(`${name}:MISSING_${field}`);
    }
    if (snapshot.complete !== true) hold(`${name}:INCOMPLETE`);
    if (!fresh(snapshot.observedAt)) hold(`${name}:STALE_OR_INVALID_TIME`);
    if (!text(snapshot.mapperVersion)) hold(`${name}:MISSING_MAPPER_VERSION`);
    if (!Array.isArray(snapshot.rows) || !natural(snapshot.expectedRowCount)
      || snapshot.expectedRowCount === 0 || snapshot.rows.length !== snapshot.expectedRowCount) {
      hold(`${name}:EMPTY_OR_INCOMPLETE_ROWS`);
      continue;
    }
    const keys = new Set<string>();
    for (const row of snapshot.rows) {
      if (!object(row) || fields.some(field => !(field in row))
        || Object.keys(row).some(field => !fields.includes(field as keyof PilotRow))
        || ['productId', 'vehicleId', 'offerId', 'supplierId', 'termKey', 'commercialType', 'status'].some(field => !text(row[field]))
        || !natural(row.termMonths) || row.termMonths === 0 || !natural(row.monthlyRent)
        || row.currency !== 'KRW' || typeof row.listable !== 'boolean'
        || !['NEW_RENT', 'USED_RENT', 'NEW_SUBSCRIPTION', 'USED_SUBSCRIPTION', 'OGONG_SUBSCRIPTION', 'PICKUP_SUBSCRIPTION'].includes(String(row.commercialType))
        || !['AVAILABLE', 'RESERVED', 'IN_USE', 'RETURNED', 'MAINTENANCE', 'ACCIDENT', 'SOLD', 'RETIRED', 'HOLD', 'ARCHIVED'].includes(String(row.status))
        || !text(row.depositState) || !['KNOWN', 'ZERO', 'NOT_APPLICABLE'].includes(row.depositState)
        || (row.depositState === 'KNOWN' && (!natural(row.depositAmount) || row.depositAmount === 0))
        || (row.depositState === 'ZERO' && row.depositAmount !== 0)
        || (row.depositState === 'NOT_APPLICABLE' && row.depositAmount !== null)
        || !natural(row.mileageLimitKmPerYear)) {
        hold(`${name}:INVALID_OR_UNKNOWN_ROW_FACTS`);
        break;
      }
      const rowKey = key(row as PilotRow);
      if (keys.has(rowKey)) { hold(`${name}:DUPLICATE_ROW_KEY`); break; }
      keys.add(rowKey);
    }
  }
  if (report.reasons.length) return report;
  const input = raw as unknown as ReadPilotInput;
  for (const name of ['legacy', 'freepass'] as const) {
    for (const field of ['sourceId', 'sourceRevision', 'scope'] as const) {
      if (input[name][field] !== input.upstream[field]) hold(`${name}:UPSTREAM_${field}_MISMATCH`);
    }
  }
  const release = input.freepass.release;
  if (!object(release) || !text(release.releaseId) || !text(release.schemaVersion)
    || !text(release.inputDigest) || !/^[a-f0-9]{64}$/.test(release.inputDigest)
    || !text(release.dataDigest) || !/^[a-f0-9]{64}$/.test(release.dataDigest) || !fresh(release.activatedAt)
    || Date.parse(release.activatedAt) > Date.parse(input.freepass.observedAt)) {
    hold('INVALID_OR_STALE_RELEASE_EVIDENCE');
  }
  if (report.reasons.length) return report;
  const upstream = new Map(input.upstream.rows.map(row => [key(row), row]));
  for (const target of ['legacy', 'freepass'] as const) {
    const downstream = new Map(input[target].rows.map(row => [key(row), row]));
    for (const rowKey of [...new Set([...upstream.keys(), ...downstream.keys()])].sort()) {
      const left = upstream.get(rowKey);
      const right = downstream.get(rowKey);
      const changed = !left ? ['EXTRA_VS_UPSTREAM'] : !right ? ['MISSING_VS_UPSTREAM']
        : fields.filter(field => left[field] !== right[field]);
      if (changed.length) report.differences.push({ target, rowKeyDigest: sha256(rowKey), fields: changed });
    }
  }
  report.status = report.differences.length ? 'MISMATCH' : 'SNAPSHOT_MATCH';
  return report;
}

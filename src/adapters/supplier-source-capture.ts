import { createHash } from 'node:crypto';
import { collectSupplierSource, validateSourceIntakeBatch, type SourceIntakeBatch, type SupplierSourceAdapter } from '../domain/source-intake.js';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const plate = (value: unknown) => text(value).replace(/\s+/g, '').toUpperCase();
const buckets = ['LOW_SONOKONG_DAILY', 'LOW_SONOKONG', 'LOW_TCAR'] as const;

// Transport/auth is injected by an authorized connector. These adapters neither
// copy legacy credentials nor guess endpoints, terms, amounts or availability.
export type SonogongBucketObservation = {
  bucket: typeof buckets[number]; observedAt: string; revision: string;
  declaredTotal: number | null; complete: boolean;
  records: Array<{ list: Record<string, unknown>; detail: Record<string, unknown> | null }>;
};

export function sonogongSourceAdapter(input: {
  expectedFreshnessSeconds: number;
  readBucket: (bucket: SonogongBucketObservation['bucket']) => Promise<SonogongBucketObservation>;
}): SupplierSourceAdapter {
  return {
    adapterId: 'sonogong-api', sourceId: 'supplier:RP012:sonogong-original-api', scope: 'inventory',
    read: async () => {
      const observations: SonogongBucketObservation[] = [];
      // Sequential, bounded reads; failure does not become an empty bucket.
      for (const bucket of buckets) {
        const observation = await input.readBucket(bucket);
        if (observation.bucket !== bucket || !text(observation.revision)
          || !Number.isFinite(Date.parse(observation.observedAt))) throw new Error('INVALID_SONOGONG_BUCKET');
        observations.push(observation);
      }
      let complete = true;
      const records: SourceIntakeBatch['records'] = [];
      for (const observation of observations) {
        complete &&= observation.complete === true && Number.isSafeInteger(observation.declaredTotal)
          && observation.declaredTotal === observation.records.length;
        for (const record of observation.records) {
          if (!object(record.list) || (typeof record.list.id !== 'string' && typeof record.list.id !== 'number')
            || !String(record.list.id).trim() || !plate(record.list.carNumber)) throw new Error('INVALID_SONOGONG_IDENTITY');
          if (!record.detail) complete = false;
          else if (String(record.detail.id) !== String(record.list.id)
            || plate(record.detail.carNumber) !== plate(record.list.carNumber)) throw new Error('SONOGONG_DETAIL_IDENTITY_MISMATCH');
          const payload = structuredClone({ bucket: observation.bucket,
            sourceRevision: observation.revision, observedAt: observation.observedAt,
            list: record.list, detail: record.detail });
          records.push({ sourceRecordId: `${observation.bucket}:${record.list.id}`,
            sourceFingerprint: fingerprint(payload), payload });
        }
      }
      const checksum = fingerprint(observations);
      const batch: SourceIntakeBatch = {
        laneId: 'PRODUCT_VEHICLE', source: { sourceId: 'supplier:RP012:sonogong-original-api',
          kind: 'API', displayName: '손오공 원본 API', expectedFreshnessSeconds: input.expectedFreshnessSeconds,
          authorityScope: ['Observed bucket/list/detail only; no inferred rates or source absence'] },
        observedAt: observations.map(o => o.observedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0]!,
        observationTimes: observations.map(o => o.observedAt),
        sourceRevision: `sonogong-raw/1:${checksum}`, checksum,
        coverage: { mode: complete ? 'FULL' : 'PARTIAL', completeness: complete ? 'COMPLETE' : 'INCOMPLETE',
          scope: 'LOW_SONOKONG_DAILY + LOW_SONOKONG + LOW_TCAR list and detail',
          note: 'Non-atomic bucket observations; terms/policy completeness and absence authority are not established.' }, records,
      };
      validateSourceIntakeBatch(batch);
      return batch;
    },
  };
}

export type WelrixSheetObservation = {
  // Binding must come from the approved source registry, never partner.sheet_url.
  sourceId: string; sheetId: string; tabId: string; range: string; revision: string;
  observedAt: string; expectedRows: number | null; complete: boolean;
  headers: unknown[]; rows: unknown[][]; identityColumn: number;
};

export function welrixSourceAdapter(input: {
  sourceId: string; sheetId: string; tabId: string; range: string;
  scope: 'inventory' | 'policy'; expectedFreshnessSeconds: number;
  readGrid: () => Promise<WelrixSheetObservation>;
}): SupplierSourceAdapter {
  return {
    adapterId: 'welrix-sheet', sourceId: input.sourceId, scope: input.scope,
    read: async () => {
      const grid = await input.readGrid();
      if (!text(input.sheetId) || !text(input.tabId) || !text(input.range)
        || grid.sourceId !== input.sourceId || grid.sheetId !== input.sheetId
        || grid.tabId !== input.tabId || grid.range !== input.range || !text(grid.revision)
        || !Number.isSafeInteger(grid.identityColumn) || grid.identityColumn < 0
        || grid.identityColumn >= grid.headers.length) throw new Error('WELRIX_SHEET_BINDING_MISMATCH');
      const complete = grid.complete === true && Number.isSafeInteger(grid.expectedRows)
        && grid.expectedRows === grid.rows.length;
      const records = grid.rows.map((cells, rowIndex) => {
        const identity = input.scope === 'inventory' ? plate(cells[grid.identityColumn]) : text(cells[grid.identityColumn]);
        if (!identity) throw new Error('WELRIX_ROW_IDENTITY_MISSING');
        // Policy UID can repeat across different condition rows. RAW row identity
        // is not a Canonical policy ID; original cells/positions remain evidence.
        const sourceRecordId = input.scope === 'inventory' ? identity : `${grid.tabId}:row:${rowIndex}:${identity}`;
        const payload = structuredClone({ sheetId: grid.sheetId, tabId: grid.tabId, range: grid.range,
          rowIndex, headers: grid.headers, cells });
        return { sourceRecordId, sourceFingerprint: fingerprint(payload), payload };
      });
      const checksum = fingerprint(grid);
      const batch: SourceIntakeBatch = {
        laneId: 'PRODUCT_VEHICLE', source: { sourceId: input.sourceId, kind: 'GOOGLE_SHEET',
          displayName: '웰릭스 원본 시트', expectedFreshnessSeconds: input.expectedFreshnessSeconds,
          authorityScope: [`RP013 ${input.scope} observed original cells only`] },
        observedAt: grid.observedAt, sourceRevision: `welrix-raw/1:${grid.revision}:${checksum}`, checksum,
        coverage: { mode: complete ? 'FULL' : 'PARTIAL', completeness: complete ? 'COMPLETE' : 'INCOMPLETE',
          scope: `RP013 ${input.scope} selected tab/range`, note: 'Inventory and policy are separate observations; no unit inference.' }, records,
      };
      validateSourceIntakeBatch(batch);
      return batch;
    },
  };
}

export { collectSupplierSource };

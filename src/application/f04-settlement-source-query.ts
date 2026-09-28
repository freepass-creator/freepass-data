import { F04_SOURCE_ID } from '../adapters/f04-settlement-source.js';
import type { SourceIngestionStore } from '../ports/source-store.js';
import { stableDigest } from '../shared/stable-digest.js';

export type F04SettlementSourceQuery = {
  tab: string | null;
  query: string | null;
  limit: number;
  includeValues: boolean;
};

export async function readF04SettlementSource(
  sourceStore: SourceIngestionStore,
  input: F04SettlementSourceQuery
) {
  const head = await sourceStore.getSourceHead(F04_SOURCE_ID);
  if (!head) throw new Error('F04_SOURCE_HEAD_NOT_FOUND');
  const run = await sourceStore.getRun(head.runId);
  if (!run || run.status !== 'COMPLETED' || run.headStatus !== 'CURRENT') {
    throw new Error('F04_SOURCE_HEAD_NOT_CURRENT');
  }

  const normalizedQuery = input.query?.toLocaleLowerCase('ko-KR') ?? null;
  const raw = await sourceStore.listRaw(head.runId);
  const rows = raw.filter((record) => {
    if (record.payload.recordType !== 'SHEET_ROW') return false;
    if (input.tab && record.payload.sheetTitle !== input.tab) return false;
    if (!normalizedQuery) return true;
    return JSON.stringify(record.payload.displayValues ?? [])
      .toLocaleLowerCase('ko-KR')
      .includes(normalizedQuery);
  });
  const digest = stableDigest({
    runId: run.runId,
    checksum: run.checkpoint?.checksum ?? null,
    matchedIds: rows.map((record) => record.sourceRecordId).sort(),
  });

  return {
    total: raw.length,
    matched: rows.length,
    digest,
    head,
    run,
    rows: rows
      .sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId))
      .slice(0, input.limit)
      .map((record) => ({
        sourceRecordId: record.sourceRecordId,
        sheetTitle: record.payload.sheetTitle,
        rowNumber: record.payload.rowNumber,
        ...(input.includeValues ? {
          displayValues: record.payload.displayValues,
          formulaValues: record.payload.formulaValues,
        } : {}),
      })),
  };
}

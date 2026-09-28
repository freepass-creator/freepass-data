import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildF04SettlementSourceBatch,
  type F04WorkbookSnapshot,
} from '../adapters/f04-settlement-source.js';
import { ingestRawSourceBatch } from '../application/ingest-raw-source.js';
import { MemorySourceStore } from '../infra/source-memory-store.js';

const inputPath = process.env.F04_SNAPSHOT_FILE?.trim();
const outputPath = process.env.F04_BATCH_FILE?.trim();
if (!inputPath || !outputPath) {
  throw new Error('F04_SNAPSHOT_FILE and F04_BATCH_FILE are required');
}

const input = JSON.parse(
  await readFile(resolve(inputPath), 'utf8')
) as F04WorkbookSnapshot;
const batch = buildF04SettlementSourceBatch(input);
await writeFile(resolve(outputPath), `${JSON.stringify(batch)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});

const manifests = batch.records.filter(
  (record) => record.payload.recordType === 'SHEET_MANIFEST'
).length;
const rows = batch.records.length - manifests;
const verificationStore = new MemorySourceStore();
const verifiedRun = await ingestRawSourceBatch(
  verificationStore,
  batch,
  input.observedAt
);
const persistedRows = await verificationStore.listRaw(verifiedRun.runId);
if (persistedRows.length !== batch.records.length) {
  throw new Error('F04_MEMORY_PERSISTENCE_COUNT_MISMATCH');
}

console.log(JSON.stringify({
  status: batch.coverage.completeness === 'COMPLETE' ? 'READY' : 'HOLD',
  sourceId: batch.source.sourceId,
  sourceRevision: batch.sourceRevision,
  checksum: batch.checksum,
  coverage: batch.coverage,
  sheetCount: manifests,
  nonEmptyRowCount: rows,
  rawRecordCount: batch.records.length,
  verification: {
    backend: 'MEMORY_ONLY',
    runId: verifiedRun.runId,
    status: verifiedRun.status,
    headStatus: verifiedRun.headStatus,
    persistedRawCount: persistedRows.length,
  },
  outputPath: resolve(outputPath),
}, null, 2));

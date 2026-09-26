import { readFile } from 'node:fs/promises';
import { createSourceIngestDataAccessRuntime } from './data-access-runtime.js';
import type { SourceIntakeBatch } from '../domain/source-intake.js';

if (process.env.SETTLEMENT_SOURCE_INGEST_APPROVED !== 'true') {
  throw new Error('SETTLEMENT_SOURCE_INGEST_APPROVED=true required');
}

const inline = process.env.SETTLEMENT_SOURCE_BATCH_JSON?.trim() ?? '';
const file = process.env.SETTLEMENT_SOURCE_BATCH_FILE?.trim() ?? '';
if ((!inline && !file) || (inline && file)) {
  throw new Error(
    'Provide exactly one of SETTLEMENT_SOURCE_BATCH_JSON or SETTLEMENT_SOURCE_BATCH_FILE'
  );
}

const raw = inline || await readFile(file, 'utf8');
const batch = JSON.parse(raw) as SourceIntakeBatch;
if (batch.laneId !== 'SETTLEMENT') {
  throw new Error('SETTLEMENT_SOURCE_BATCH_MUST_USE_SETTLEMENT_LANE');
}

const runtime = await createSourceIngestDataAccessRuntime();
const run = await runtime.ingestRawBatch(batch);

console.log(JSON.stringify({
  status: run.status,
  runId: run.runId,
  sourceId: run.sourceId,
  headStatus: run.headStatus,
  rawCount: run.rawCount,
  coverage: run.coverage,
  checkpoint: run.checkpoint ?? null,
}, null, 2));

import { F04_SOURCE_ID } from '../adapters/f04-settlement-source.js';
import { createF04SettlementQueryDataAccessRuntime } from './data-access-runtime.js';

const requestedLimit = Number(process.env.F04_QUERY_LIMIT ?? '100');
if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) {
  throw new Error('F04_QUERY_LIMIT must be an integer from 1 to 500');
}

const tab = process.env.F04_QUERY_TAB?.trim() || null;
const query = process.env.F04_QUERY_TEXT?.trim().toLocaleLowerCase('ko-KR') || null;
const includeValues = process.env.F04_QUERY_INCLUDE_VALUES === 'true';
const runtime = await createF04SettlementQueryDataAccessRuntime();
const result = await runtime.query({
  tab,
  query,
  limit: requestedLimit,
  includeValues,
});

console.log(JSON.stringify({
  sourceId: F04_SOURCE_ID,
  runId: result.run.runId,
  headStatus: result.run.headStatus,
  coverage: result.run.coverage,
  checkpoint: result.run.checkpoint,
  totalRawRecordCount: result.total,
  matchedRowCount: result.matched,
  returnedRowCount: result.rows.length,
  resultDigest: result.digest,
  filters: { tab, queryApplied: Boolean(query), includeValues },
  rows: result.rows,
}, null, 2));

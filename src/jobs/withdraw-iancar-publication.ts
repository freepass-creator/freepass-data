import { execFileSync } from 'node:child_process';
import { runIancarPublicationWithdrawal } from './data-access-runtime.js';

const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--expected-count=301', '--expected-open=223'].includes(arg)))
  throw new Error('UNKNOWN_IANCAR_WITHDRAWAL_OPTION');
const input = { apply: args.includes('--apply'), expectedCount: 301, expectedOpen: 223 };
if (!input.apply) console.log(JSON.stringify(await runIancarPublicationWithdrawal(input)));
else {
  if (process.env.IANCAR_PUBLICATION_WITHDRAWAL_APPROVED !== 'true')
    throw new Error('IANCAR_PUBLICATION_WITHDRAWAL_APPROVED_REQUIRED');
  // The active refresh must exclude RP031 before withdrawal, not after it.
  const workflow = JSON.parse(execFileSync('gh', ['api',
    'repos/freepass-creator/freepasserp4/contents/.github/workflows/erp5-ssot-refresh.yml?ref=main'],
  { encoding: 'utf8', windowsHide: true }));
  const body = Buffer.from(workflow.content, 'base64').toString('utf8');
  if (!body.includes('RP031_API_CUTOVER_HOLD') || !body.includes("source.partnerCode !== 'RP031'"))
    throw new Error('IANCAR_LEGACY_SOURCE_NOT_FENCED');
  const runs = JSON.parse(execFileSync('gh', ['api',
    'repos/freepass-creator/freepasserp4/actions/workflows/erp5-ssot-refresh.yml/runs?per_page=100',
    '--jq', '[.workflow_runs[] | select(.status != "completed") | {id,status}]'],
  { encoding: 'utf8', windowsHide: true }));
  if (runs.length !== 0)
    throw new Error('IANCAR_LEGACY_REFRESH_NOT_DRAINED');
  const result = await runIancarPublicationWithdrawal(input);
  console.log(JSON.stringify(result));
}

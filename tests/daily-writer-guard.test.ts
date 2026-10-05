import { describe, expect, it } from 'vitest';
import { DAILY_WRITER_ALLOWED_COLLECTIONS, evaluateDailyWriterGuard } from '../src/domain/daily-writer-guard.js';
import { FIRESTORE_COLLECTIONS } from '../src/infra/firestore-layout.js';

const account = 'github-data-inventory-writer@freepasserp5.iam.gserviceaccount.com';
const db = 'projects/freepasserp5/databases/(default)/documents';
const doc = (c: string) => `${db}/${c}/x1`;
const commit = (at: string, names: string[], who = account) => ({ timestamp: at, protoPayload: {
  methodName: 'google.firestore.v1.Firestore.Commit', authenticationInfo: { principalEmail: who }, resourceName: db,
  request: { writes: names.map((name) => ({ update: { name } })) } } });
const run = { head_branch: 'main', event: 'schedule', status: 'completed', conclusion: 'success',
  run_started_at: '2026-10-05T18:40:00Z', updated_at: '2026-10-05T18:55:00Z' };
const skippedJobSteps = [
  { name: 'Set up job', conclusion: 'success' },
  { name: 'Daily schedule and manual apply gate', conclusion: 'success' },
  { name: 'Run actions/checkout@v4', conclusion: 'skipped' },
  { name: 'Run actions/setup-node@v4', conclusion: 'skipped' },
  { name: 'Run npm ci --ignore-scripts', conclusion: 'skipped' },
  { name: 'Require the Data delivery identity, sheet and private evidence bucket', conclusion: 'skipped' },
  { name: 'Run google-github-actions/auth@v2', conclusion: 'skipped' },
  { name: 'Run google-github-actions/setup-gcloud@v2', conclusion: 'skipped' },
  { name: 'Capture and plan (no writes) — counts only in the public log', conclusion: 'skipped' },
  { name: 'Apply to FreePass Data (writes) — counts only in the public log', conclusion: 'skipped' },
  { name: 'Preserve private capture, plan and reports (location not printed)', conclusion: 'skipped' },
  { name: 'Remove temporary files', conclusion: 'skipped' },
  { name: 'Complete job', conclusion: 'success' },
];
const oldWritingJobSteps = [
  { name: 'Set up job', conclusion: 'success' },
  { name: 'Daily schedule and manual apply gate', conclusion: 'success' },
  { name: 'Run actions/checkout@v4', conclusion: 'success' },
  { name: 'Run actions/setup-node@v4', conclusion: 'success' },
  { name: 'Run npm ci --ignore-scripts', conclusion: 'success' },
  { name: 'Require the Data delivery identity, sheet and private evidence bucket', conclusion: 'success' },
  { name: 'Run google-github-actions/auth@v2', conclusion: 'success' },
  { name: 'Run google-github-actions/setup-gcloud@v2', conclusion: 'success' },
  { name: 'Capture, plan and (apply) — counts only in the public log', conclusion: 'success' },
  { name: 'Preserve private capture, plan and reports (location not printed)', conclusion: 'success' },
  { name: 'Remove temporary files', conclusion: 'success' },
  { name: 'Post Run google-github-actions/auth@v2', conclusion: 'success' },
  { name: 'Post Run actions/setup-node@v4', conclusion: 'success' },
  { name: 'Post Run actions/checkout@v4', conclusion: 'success' },
  { name: 'Complete job', conclusion: 'success' },
];
const now = new Date('2026-10-05T19:30:00Z');
const judge = (entries: unknown[], runs: unknown[] = [run]) =>
  evaluateDailyWriterGuard({ entries: entries as never, runs: runs as never, account, now, lookbackHours: 26 });

describe('daily writer guard', () => {
  it('allowed collections are real Canonical/source/evidence collections, never legacy products', () => {
    const real = new Set(Object.values(FIRESTORE_COLLECTIONS).flatMap((g) => Object.values(g as Record<string, string>)));
    for (const c of DAILY_WRITER_ALLOWED_COLLECTIONS) expect(real.has(c)).toBe(true);
    expect(DAILY_WRITER_ALLOWED_COLLECTIONS).not.toContain('products');
  });
  it('is OK for allowed writes inside a main daily run; ignores other principals and non-write methods', () => {
    const read = { timestamp: '2026-10-05T19:00:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.RunQuery',
      authenticationInfo: { principalEmail: account }, resourceName: doc('products') } };
    const r = judge([commit('2026-10-05T18:45:00Z', [doc('catalog_products'), doc('raw_records')]),
      commit('2026-10-05T19:20:00Z', [doc('products')], 'someone-else@example.com'), read]);
    expect(r).toMatchObject({ status: 'OK', writes: 1, writesWithDocumentPaths: 1, outsideRuns: 0, silentApplies: 0 });
  });
  it('alerts on products named by writes, resourceName, or CreateDocument parent + collectionId', () => {
    expect(judge([commit('2026-10-05T18:45:00Z', [doc('products')])]).outsideCollections).toEqual({ products: 1 });
    const byResource = { timestamp: '2026-10-05T18:45:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.UpdateDocument',
      authenticationInfo: { principalEmail: account }, resourceName: doc('products') } };
    expect(judge([byResource]).reasons).toEqual(['DAILY_WRITER_OUTSIDE_ALLOWED_COLLECTIONS']);
    const create = { timestamp: '2026-10-05T18:45:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.CreateDocument',
      authenticationInfo: { principalEmail: account }, request: { parent: db, collectionId: 'products' } } };
    expect(judge([create]).outsideCollections).toEqual({ products: 1 });
    const other = commit('2026-10-05T18:45:00Z', ['projects/freepasserp5/databases/other/documents/catalog_products/x']);
    expect(judge([other]).outsideCollections['(other-database)']).toBeGreaterThan(0);
    const otherDbOnly = { timestamp: '2026-10-05T18:45:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.Commit',
      authenticationInfo: { principalEmail: account }, resourceName: 'projects/freepasserp5/databases/other' } };
    expect(judge([otherDbOnly]).reasons).toContain('DAILY_WRITER_OUTSIDE_ALLOWED_COLLECTIONS');
  });
  it('never prints an unknown collection name in the public report', () => {
    const r = judge([commit('2026-10-05T18:45:00Z', [doc('SENSITIVE_VALUE')])]);
    expect(r.outsideCollections).toEqual({ '(other)': 1 });
    expect(JSON.stringify(r)).not.toContain('SENSITIVE_VALUE');
  });
  it('alerts on writes outside every main daily run, and ignores branch or queued runs as windows', () => {
    const bare = { timestamp: '2026-10-05T12:00:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.Commit',
      authenticationInfo: { principalEmail: account } } };
    const outside = judge([bare]);
    expect(outside.status).toBe('ALERT');
    expect(outside.reasons).toContain('DAILY_WRITER_OUTSIDE_SCHEDULED_RUN');
    const late = commit('2026-10-05T19:20:00Z', [doc('catalog_products')]);
    expect(judge([late], [{ ...run, head_branch: 'feature', status: 'in_progress', run_started_at: '2026-10-05T19:10:00Z' },
      { ...run, status: 'queued', run_started_at: '2026-10-05T19:10:00Z' },
      { ...run, status: 'pending', run_started_at: '2026-10-05T19:10:00Z' }]).reasons).toContain('DAILY_WRITER_OUTSIDE_SCHEDULED_RUN');
  });
  it('holds on a write whose document path cannot be read, even inside a daily run', () => {
    const bare = { timestamp: '2026-10-05T18:45:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.Commit',
      authenticationInfo: { principalEmail: account } } };
    expect(judge([bare])).toMatchObject({ status: 'HOLD', reasons: ['DAILY_WRITER_DOCUMENT_PATH_MISSING'], writesWithoutDocumentPaths: 1 });
    // A database-level resourceName or a stray string elsewhere in the request is not a document path.
    const dbOnly = { ...bare, protoPayload: { ...bare.protoPayload, resourceName: db, request: { note: doc('catalog_products') } } };
    expect(judge([dbOnly])).toMatchObject({ status: 'HOLD', writesWithoutDocumentPaths: 1 });
  });
  it('holds when a successful apply run left no write log (audit log off or missing)', () => {
    expect(judge([])).toMatchObject({ status: 'HOLD', reasons: ['DAILY_WRITER_AUDIT_LOG_MISSING'], silentApplies: 1 });
    const dryRun = { ...run, event: 'workflow_dispatch', display_title: 'shared-sheet-daily dry-run' };
    expect(judge([], [dryRun]).status).toBe('OK');
  });
  it('does not count only when shared-sheet-daily steps prove the gate ran and write steps were skipped', () => {
    expect(judge([], [{ ...run, jobSteps: skippedJobSteps }])).toMatchObject({ status: 'OK', silentApplies: 0 });
  });
  it('holds for the actual older write run because non-allowlisted steps succeeded', () => {
    expect(judge([], [{ ...run, jobSteps: oldWritingJobSteps }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
  });
  it('malformed step entries (null, non-object, missing / empty / non-string name or conclusion) hold instead of throwing', () => {
    const bad: unknown[] = [null, 'x', 7, [], { conclusion: 'skipped' }, { name: '', conclusion: 'skipped' }, { name: '  ', conclusion: 'skipped' },
      { name: 42, conclusion: 'skipped' }, { name: 'Run something', conclusion: null }, { name: 'Run something' }];
    for (const entry of bad) {
      expect(() => judge([], [{ ...run, jobSteps: [...skippedJobSteps, entry] }])).not.toThrow();
      expect(judge([], [{ ...run, jobSteps: [...skippedJobSteps, entry] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    }
  });
  it('a nameless step holds even when it is skipped', () => {
    expect(judge([], [{ ...run, jobSteps: [...skippedJobSteps, { conclusion: 'skipped' }] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
  });
  it('any repeated step name holds, not only the three required steps', () => {
    const dup = [...skippedJobSteps, { name: 'Run actions/checkout@v4', conclusion: 'skipped' }];
    expect(judge([], [{ ...run, jobSteps: dup }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    const dupSetup = [...skippedJobSteps, { name: 'Set up job', conclusion: 'success' }];
    expect(judge([], [{ ...run, jobSteps: dupSetup }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
  });
  it('fails closed unless the exact gate/capture/apply skipped pattern is confirmed', () => {
    const changedName = skippedJobSteps.map((s) => s.name === 'Daily schedule and manual apply gate'
      ? { ...s, name: 'Daily schedule apply gate' } : s);
    const partialSkipped = skippedJobSteps.map((s) => s.name === 'Apply to FreePass Data (writes) — counts only in the public log'
      ? { ...s, conclusion: 'success' } : s);
    const gateNotSuccess = skippedJobSteps.map((s) => s.name === 'Daily schedule and manual apply gate'
      ? { ...s, conclusion: 'skipped' } : s);
    const unknownSuccess = [...skippedJobSteps, { name: 'Persist snapshot', conclusion: 'success' }];
    const failureStep = skippedJobSteps.map((s) => s.name === 'Run actions/checkout@v4' ? { ...s, conclusion: 'failure' } : s);
    const renamedApply = skippedJobSteps.map((s) => s.name === 'Apply to FreePass Data (writes) — counts only in the public log'
      ? { ...s, name: 'Apply to FreePass Data (writes)' } : s);
    const duplicateGate = [...skippedJobSteps, { name: 'Daily schedule and manual apply gate', conclusion: 'success' }];
    expect(judge([], [{ ...run, jobSteps: changedName }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    expect(judge([], [{ ...run, jobSteps: [] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    expect(judge([], [{ ...run, jobSteps: partialSkipped }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    expect(judge([], [{ ...run, jobSteps: [{ name: 'Apply to FreePass Data (writes) — counts only in the public log', conclusion: 'success' }] }]))
      .toMatchObject({ status: 'HOLD', silentApplies: 1 });
    expect(judge([], [{ ...run, jobSteps: gateNotSuccess }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    expect(judge([], [{ ...run, jobSteps: unknownSuccess }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    expect(judge([], [{ ...run, jobSteps: failureStep }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    expect(judge([], [{ ...run, jobSteps: renamedApply }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    expect(judge([], [{ ...run, jobSteps: duplicateGate }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    expect(judge([], [{ ...run, jobSteps: null }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    expect(judge([], [run])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
  });
});

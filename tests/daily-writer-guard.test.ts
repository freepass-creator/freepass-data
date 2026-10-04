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
});

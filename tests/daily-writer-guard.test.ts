import { describe, expect, it } from 'vitest';
import { DAILY_WRITER_ALLOWED_COLLECTIONS, evaluateDailyWriterGuard } from '../src/domain/daily-writer-guard.js';
import { FIRESTORE_COLLECTIONS } from '../src/infra/firestore-layout.js';

const account = 'github-data-inventory-writer@freepasserp5.iam.gserviceaccount.com';
const doc = (c: string) => `projects/freepasserp5/databases/(default)/documents/${c}/x1`;
const entry = (at: string, names: string[], who = account) => ({ timestamp: at, protoPayload: {
  methodName: 'google.firestore.v1.Firestore.Commit', authenticationInfo: { principalEmail: who },
  request: { writes: names.map((name) => ({ update: { name } })) } } });
const run = { run_started_at: '2026-10-05T18:40:00Z', updated_at: '2026-10-05T18:55:00Z', status: 'completed' };
const now = new Date('2026-10-05T19:30:00Z');

describe('daily writer guard', () => {
  it('allowed collections are real Canonical/source/evidence collections, never legacy products', () => {
    const real = new Set(Object.values(FIRESTORE_COLLECTIONS).flatMap((g) => Object.values(g as Record<string, string>)));
    for (const c of DAILY_WRITER_ALLOWED_COLLECTIONS) expect(real.has(c)).toBe(true);
    expect(DAILY_WRITER_ALLOWED_COLLECTIONS).not.toContain('products');
  });
  it('is OK for allowed writes inside a data-owned-refresh run and ignores other principals', () => {
    const r = evaluateDailyWriterGuard({ entries: [entry('2026-10-05T18:45:00Z', [doc('catalog_products'), doc('raw_records')]),
      entry('2026-10-05T19:20:00Z', [doc('products')], 'someone-else@example.com')], runs: [run], account, now });
    expect(r).toMatchObject({ status: 'OK', writes: 1, writesWithDocumentPaths: 1, outsideRuns: 0 });
  });
  it('alerts on a write to products even inside a run', () => {
    const r = evaluateDailyWriterGuard({ entries: [entry('2026-10-05T18:45:00Z', [doc('products')])], runs: [run], account, now });
    expect(r.status).toBe('ALERT');
    expect(r.reasons).toEqual(['DAILY_WRITER_OUTSIDE_ALLOWED_COLLECTIONS']);
    expect(r.outsideCollections).toEqual({ products: 1 });
  });
  it('alerts on a write outside every run window when the log carries no document paths', () => {
    const bare = { timestamp: '2026-10-05T12:00:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.Commit',
      authenticationInfo: { principalEmail: account } } };
    const r = evaluateDailyWriterGuard({ entries: [bare], runs: [run], account, now });
    expect(r).toMatchObject({ status: 'ALERT', reasons: ['DAILY_WRITER_OUTSIDE_SCHEDULED_RUN'], writesWithDocumentPaths: 0 });
  });
});

import { describe, expect, it } from 'vitest';
import { compareShadow } from '../src/migration/shadow.js';

describe('Change Mirror shadow parity', () => {
  it('does not report false mismatch while source revisions are not aligned', () => {
    const result = compareShadow({
      legacyCheckpoint: { sourceId: 'legacy', sourceRevision: '10', observedAt: '2026-09-20T10:00:00Z' },
      freepassCheckpoint: { sourceId: 'legacy', sourceRevision: '9', observedAt: '2026-09-20T10:00:01Z' },
      legacyRecords: [{ key: 'a', fingerprint: 'x' }],
      freepassRecords: [],
      settledWindowMs: 0,
      now: '2026-09-20T10:00:10Z'
    });
    expect(result.status).toBe('PENDING_LAG');
  });

  it('reports true mismatch only after aligned revision comparison', () => {
    const result = compareShadow({
      legacyCheckpoint: { sourceId: 'legacy', sourceRevision: '10', observedAt: '2026-09-20T10:00:00Z' },
      freepassCheckpoint: { sourceId: 'legacy', sourceRevision: '10', observedAt: '2026-09-20T10:00:02Z' },
      legacyRecords: [{ key: 'a', fingerprint: 'x' }],
      freepassRecords: [{ key: 'a', fingerprint: 'y' }],
      settledWindowMs: 0,
      now: '2026-09-20T10:00:10Z'
    });
    expect(result.status).toBe('TRUE_MISMATCH');
    expect(result.changed).toEqual(['a']);
  });
});

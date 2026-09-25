import { describe, expect, it } from 'vitest';
import { decideSourceHead } from '../src/domain/source.js';

const complete = { mode: 'FULL' as const, completeness: 'COMPLETE' as const };

describe('source head decision', () => {
  it('accepts the first complete valid observation', () => {
    expect(decideSourceHead(complete, '2026-09-26T00:00:00.000Z')).toEqual({
      eligible: true,
      acceptedAsHead: true,
      headStatus: 'CURRENT'
    });
  });

  it('keeps an older complete observation as STALE', () => {
    expect(decideSourceHead(
      complete,
      '2026-09-25T23:00:00.000Z',
      '2026-09-26T00:00:00.000Z'
    )).toEqual({
      eligible: true,
      acceptedAsHead: false,
      headStatus: 'STALE'
    });
  });

  it('rejects incomplete or invalid observations as INELIGIBLE', () => {
    expect(decideSourceHead(
      { mode: 'PARTIAL', completeness: 'INCOMPLETE' },
      '2026-09-26T01:00:00.000Z'
    ).headStatus).toBe('INELIGIBLE');

    expect(decideSourceHead(complete, 'not-a-time').headStatus).toBe('INELIGIBLE');
  });
});

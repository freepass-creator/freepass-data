import { describe, expect, it } from 'vitest';
import {
  buildVehicleMasterBackfillCompletionIndex,
  shouldSkipVehicleMasterBackfillPage,
} from '../src/application/vehicle-master-backfill.js';
import {
  sealVehicleMasterPipelineRecord,
  sealVehicleMasterSourceDocument,
} from '../src/domain/vehicle-master.js';
import type { VehicleMasterDiscoveredPage } from '../src/domain/vehicle-master-backfill.js';
import type { VehicleMasterSourceParser } from '../src/ports/vehicle-master-source-parser.js';

const now = '2026-09-26T00:00:00.000Z';

function parser(version: string): VehicleMasterSourceParser {
  return {
    parserId: 'FIXTURE_PARSER',
    parserVersion: version,
    canParse(input) {
      return Boolean(input.sourceUrl?.includes('/vehicle/'));
    },
    parse() {
      throw new Error('parse not used by completion tests');
    },
  };
}

function page(overrides: Partial<VehicleMasterDiscoveredPage> = {}): VehicleMasterDiscoveredPage {
  return {
    sourceKey: 'CARNOON',
    sourceType: 'CARNOON',
    sourceName: 'Carnoon',
    sourceUrl: 'https://www.carnoon.co.kr/newcar/vehicle/11572',
    discoveredFromUrl: 'https://www.carnoon.co.kr/newcar/search',
    modelHint: '쏘렌토',
    latestModelYearHint: 2027,
    currentHint: true,
    ...overrides,
  };
}

function evidence(input: {
  version: string;
  observedAt: string;
  finalUrl?: string;
  requestedUrl?: string;
}) {
  const finalUrl =
    input.finalUrl ?? 'https://www.carnoon.co.kr/newcar/vehicle/11572';
  const sourceDocumentId = `src_${input.version}_${input.observedAt}`;
  const source = sealVehicleMasterSourceDocument({
    sourceDocumentId,
    sourceType: 'CARNOON',
    sourceName: 'fixture',
    sourceUrl: finalUrl,
    publishedAt: null,
    observedAt: input.observedAt,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath: `vehicle-master/fixture/${sourceDocumentId}.html`,
    sha256: 'a'.repeat(64),
    mimeType: 'text/html',
    metadata: {
      ...(input.requestedUrl ? { requestedUrl: input.requestedUrl } : {}),
    },
  });
  const normalized = sealVehicleMasterPipelineRecord({
    recordId: `norm_${input.version}_${input.observedAt}`,
    kind: 'NORMALIZED_RECORD',
    sourceDocumentId,
    observedAt: input.observedAt,
    payload: {
      recordKind: 'SUMMARY',
      parserId: 'FIXTURE_PARSER',
      parserVersion: input.version,
      recordCount: 1,
    },
  });
  return { source, normalized };
}

describe('vehicle master backfill completion policy', () => {
  it('reprocesses a URL when the current parser version is newer', () => {
    const previous = evidence({
      version: '1.0.0',
      observedAt: '2026-09-25T23:00:00.000Z',
    });
    const completions = buildVehicleMasterBackfillCompletionIndex({
      sources: [previous.source],
      normalized: [previous.normalized],
    });

    expect(shouldSkipVehicleMasterBackfillPage({
      page: page(),
      completions,
      parsers: [parser('1.1.0')],
      now,
      currentTtlHours: 24,
    })).toBe(false);
  });

  it('keeps historical pages complete indefinitely for the same parser version', () => {
    const previous = evidence({
      version: '1.1.0',
      observedAt: '2020-01-01T00:00:00.000Z',
    });
    const completions = buildVehicleMasterBackfillCompletionIndex({
      sources: [previous.source],
      normalized: [previous.normalized],
    });

    expect(shouldSkipVehicleMasterBackfillPage({
      page: page({ currentHint: false, latestModelYearHint: 2020 }),
      completions,
      parsers: [parser('1.1.0')],
      now,
      currentTtlHours: 24,
    })).toBe(true);
  });

  it('recaptures current pages after TTL so newly added model years can appear', () => {
    const previous = evidence({
      version: '1.1.0',
      observedAt: '2026-09-24T00:00:00.000Z',
    });
    const completions = buildVehicleMasterBackfillCompletionIndex({
      sources: [previous.source],
      normalized: [previous.normalized],
    });

    expect(shouldSkipVehicleMasterBackfillPage({
      page: page({ currentHint: true }),
      completions,
      parsers: [parser('1.1.0')],
      now,
      currentTtlHours: 24,
    })).toBe(false);
  });

  it('skips a fresh current page inside TTL', () => {
    const previous = evidence({
      version: '1.1.0',
      observedAt: '2026-09-25T12:00:00.000Z',
    });
    const completions = buildVehicleMasterBackfillCompletionIndex({
      sources: [previous.source],
      normalized: [previous.normalized],
    });

    expect(shouldSkipVehicleMasterBackfillPage({
      page: page({ currentHint: true }),
      completions,
      parsers: [parser('1.1.0')],
      now,
      currentTtlHours: 24,
    })).toBe(true);
  });

  it('treats unknown current status as TTL-based rather than permanent', () => {
    const previous = evidence({
      version: '1.1.0',
      observedAt: '2026-09-24T00:00:00.000Z',
    });
    const completions = buildVehicleMasterBackfillCompletionIndex({
      sources: [previous.source],
      normalized: [previous.normalized],
    });

    expect(shouldSkipVehicleMasterBackfillPage({
      page: page({ currentHint: null }),
      completions,
      parsers: [parser('1.1.0')],
      now,
      currentTtlHours: 24,
    })).toBe(false);
  });

  it('recognizes completion through requested URL before redirect', () => {
    const requestedUrl = 'https://www.carnoon.co.kr/newcar/vehicle/11572';
    const previous = evidence({
      version: '1.1.0',
      observedAt: '2026-09-25T12:00:00.000Z',
      requestedUrl,
      finalUrl: 'https://www.carnoon.co.kr/newcar/vehicle/11572/',
    });
    const completions = buildVehicleMasterBackfillCompletionIndex({
      sources: [previous.source],
      normalized: [previous.normalized],
    });

    expect(completions.has(requestedUrl)).toBe(true);
    expect(shouldSkipVehicleMasterBackfillPage({
      page: page({ sourceUrl: requestedUrl }),
      completions,
      parsers: [parser('1.1.0')],
      now,
      currentTtlHours: 24,
    })).toBe(true);
  });

  it('never suppresses a captured page when no current parser can claim it', () => {
    const previous = evidence({
      version: '1.1.0',
      observedAt: '2026-09-25T12:00:00.000Z',
    });
    const completions = buildVehicleMasterBackfillCompletionIndex({
      sources: [previous.source],
      normalized: [previous.normalized],
    });

    expect(shouldSkipVehicleMasterBackfillPage({
      page: page({ sourceUrl: 'https://example.test/unparsed' }),
      completions,
      parsers: [parser('1.1.0')],
      now,
      currentTtlHours: 24,
    })).toBe(false);
  });
});

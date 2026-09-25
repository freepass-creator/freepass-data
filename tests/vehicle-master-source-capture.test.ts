import { describe, expect, it } from 'vitest';
import { captureVehicleMasterSource } from '../src/application/vehicle-master-source-capture.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import { sha256Bytes } from '../src/shared/binary-digest.js';
import type {
  VehicleMasterArchiveInput,
  VehicleMasterSourceArchive,
} from '../src/ports/vehicle-master-source-archive.js';
import type {
  VehicleMasterFetchedSource,
  VehicleMasterSourceFetcher,
} from '../src/ports/vehicle-master-source-fetcher.js';

class FakeFetcher implements VehicleMasterSourceFetcher {
  constructor(private readonly result: VehicleMasterFetchedSource) {}
  async fetch() {
    return structuredClone(this.result);
  }
}

class MemoryArchive implements VehicleMasterSourceArchive {
  private readonly values = new Map<string, string>();

  async archive(input: VehicleMasterArchiveInput) {
    const actual = sha256Bytes(input.bytes);
    if (actual !== input.expectedSha256) {
      throw new Error('TEST_ARCHIVE_SHA_MISMATCH');
    }
    const existing = this.values.get(input.storagePath);
    if (!existing) {
      this.values.set(input.storagePath, actual);
      return 'CREATED' as const;
    }
    if (existing === actual) return 'UNCHANGED' as const;
    throw new Error('TEST_ARCHIVE_PATH_COLLISION');
  }
}

const bytes = Buffer.from('<html><body>vehicle price table</body></html>', 'utf8');
const fetched: VehicleMasterFetchedSource = {
  requestedUrl: 'https://www.kia.com/kr/vehicles/sorento/price',
  finalUrl: 'https://www.kia.com/kr/vehicles/sorento/price',
  status: 200,
  contentType: 'text/html; charset=utf-8',
  bytes,
};

describe('vehicle master source capture', () => {
  it('archives bytes first and persists immutable SourceDocument provenance', async () => {
    const store = new MemoryVehicleMasterStore();
    const archive = new MemoryArchive();
    const fetcher = new FakeFetcher(fetched);

    const result = await captureVehicleMasterSource(
      { fetcher, archive, store },
      {
        sourceType: 'MANUFACTURER_OFFICIAL',
        sourceName: 'Kia Sorento price',
        sourceUrl: fetched.requestedUrl,
        publishedAt: '2026-09-01T00:00:00.000Z',
        observedAt: '2026-09-25T08:30:00.000Z',
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        effectiveTo: null,
        metadata: { vehicle: 'sorento', modelYear: 2027 },
      }
    );

    expect(result.archiveWrite).toBe('CREATED');
    expect(result.documentWrite).toBe('CREATED');
    expect(result.sourceDocument.sha256).toBe(sha256Bytes(bytes));
    expect(result.sourceDocument.storagePath).toContain(result.sourceDocument.sha256);
    expect(result.sourceDocument.sourceUrl).toBe(fetched.finalUrl);

    const persisted = await store.getSourceDocument(result.sourceDocument.sourceDocumentId);
    expect(persisted?.contentHash).toBe(result.sourceDocument.contentHash);
  });

  it('is idempotent for the same observation and reuses content-addressed bytes', async () => {
    const store = new MemoryVehicleMasterStore();
    const archive = new MemoryArchive();
    const fetcher = new FakeFetcher(fetched);
    const input = {
      sourceType: 'MANUFACTURER_OFFICIAL' as const,
      sourceName: 'Kia Sorento price',
      sourceUrl: fetched.requestedUrl,
      publishedAt: '2026-09-01T00:00:00.000Z',
      observedAt: '2026-09-25T08:30:00.000Z',
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      effectiveTo: null,
      metadata: { vehicle: 'sorento' },
    };

    const first = await captureVehicleMasterSource({ fetcher, archive, store }, input);
    const second = await captureVehicleMasterSource({ fetcher, archive, store }, input);

    expect(first.sourceDocument.sourceDocumentId).toBe(second.sourceDocument.sourceDocumentId);
    expect(second.archiveWrite).toBe('UNCHANGED');
    expect(second.documentWrite).toBe('UNCHANGED');
  });

  it('creates a new observation record while reusing identical archived bytes', async () => {
    const store = new MemoryVehicleMasterStore();
    const archive = new MemoryArchive();
    const fetcher = new FakeFetcher(fetched);

    const first = await captureVehicleMasterSource(
      { fetcher, archive, store },
      {
        sourceType: 'MANUFACTURER_OFFICIAL',
        sourceName: 'Kia Sorento price',
        sourceUrl: fetched.requestedUrl,
        observedAt: '2026-09-25T08:30:00.000Z',
      }
    );
    const second = await captureVehicleMasterSource(
      { fetcher, archive, store },
      {
        sourceType: 'MANUFACTURER_OFFICIAL',
        sourceName: 'Kia Sorento price',
        sourceUrl: fetched.requestedUrl,
        observedAt: '2026-09-26T08:30:00.000Z',
      }
    );

    expect(first.sourceDocument.sourceDocumentId).not.toBe(second.sourceDocument.sourceDocumentId);
    expect(second.archiveWrite).toBe('UNCHANGED');
    expect(second.documentWrite).toBe('CREATED');
    expect(first.sourceDocument.storagePath).toBe(second.sourceDocument.storagePath);
  });
});

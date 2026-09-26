import {
  deterministicVehicleMasterRecordId,
  sealVehicleMasterHashRecord,
  sealVehicleMasterSourceDocument,
  type VehicleMasterHashRecord,
  type VehicleMasterSourceDocument,
  type VehicleMasterWriteResult,
} from '../domain/vehicle-master.js';
import { sha256Bytes } from '../shared/binary-digest.js';
import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';
import type {
  VehicleMasterArchiveInput,
  VehicleMasterSourceArchive,
} from '../ports/vehicle-master-source-archive.js';
import type {
  VehicleMasterFetchedSource,
  VehicleMasterSourceFetcher,
} from '../ports/vehicle-master-source-fetcher.js';

export type CaptureVehicleMasterSourceInput = {
  sourceType: VehicleMasterSourceDocument['sourceType'];
  sourceName: string;
  sourceUrl: string;
  publishedAt?: string | null;
  observedAt: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  metadata?: Record<string, unknown>;
};

export type CaptureVehicleMasterSourceResult = {
  sourceDocument: VehicleMasterSourceDocument;
  hashRecord: VehicleMasterHashRecord;
  archiveWrite: 'CREATED' | 'UNCHANGED';
  documentWrite: VehicleMasterWriteResult;
  hashWrite: VehicleMasterWriteResult;
};

function extension(contentType: string | null, url: string) {
  const normalized = String(contentType ?? '').toLowerCase();
  if (normalized.includes('application/pdf')) return 'pdf';
  if (normalized.includes('application/json')) return 'json';
  if (normalized.includes('text/html')) return 'html';
  if (normalized.includes('text/plain')) return 'txt';

  const pathname = new URL(url).pathname.toLowerCase();
  for (const ext of ['pdf', 'json', 'html', 'htm', 'txt']) {
    if (pathname.endsWith(`.${ext}`)) return ext === 'htm' ? 'html' : ext;
  }
  return 'bin';
}

function stringMetadata(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) =>
        typeof child === 'string' ||
        typeof child === 'number' ||
        typeof child === 'boolean'
      )
      .map(([key, child]) => [key, String(child)])
  );
}

export async function persistFetchedVehicleMasterSource(
  dependencies: {
    archive: VehicleMasterSourceArchive;
    store: VehicleMasterStore;
  },
  input: CaptureVehicleMasterSourceInput,
  fetched: VehicleMasterFetchedSource
): Promise<CaptureVehicleMasterSourceResult> {
  const sha256 = sha256Bytes(fetched.bytes);
  const sourceDocumentId = deterministicVehicleMasterRecordId('srcdoc', {
    sourceType: input.sourceType,
    requestedUrl: fetched.requestedUrl,
    finalUrl: fetched.finalUrl,
    sha256,
    observedAt: input.observedAt,
  });
  const ext = extension(fetched.contentType, fetched.finalUrl);
  const storagePath =
    `vehicle-master/source-documents/${input.sourceType.toLowerCase()}/${sha256}.${ext}`;

  const archiveInput: VehicleMasterArchiveInput = {
    storagePath,
    bytes: fetched.bytes,
    expectedSha256: sha256,
    contentType: fetched.contentType,
    metadata: {
      sourceDocumentId,
      sourceType: input.sourceType,
      requestedUrl: fetched.requestedUrl,
      finalUrl: fetched.finalUrl,
      ...stringMetadata(input.metadata ?? {}),
    },
  };
  const archiveWrite = await dependencies.archive.archive(archiveInput);

  const sourceDocument = sealVehicleMasterSourceDocument({
    sourceDocumentId,
    sourceType: input.sourceType,
    sourceName: input.sourceName,
    sourceUrl: fetched.finalUrl,
    publishedAt: input.publishedAt ?? null,
    observedAt: input.observedAt,
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveTo: input.effectiveTo ?? null,
    storagePath,
    sha256,
    mimeType: fetched.contentType,
    metadata: {
      ...(input.metadata ?? {}),
      requestedUrl: fetched.requestedUrl,
      finalUrl: fetched.finalUrl,
      httpStatus: fetched.status,
      byteLength: fetched.bytes.byteLength,
    },
  });
  const documentWrite = await dependencies.store.putSourceDocument(sourceDocument);

  const hashRecord = sealVehicleMasterHashRecord({
    hashId: deterministicVehicleMasterRecordId('hash', {
      scope: 'SOURCE_BYTES',
      sourceDocumentId,
      algorithm: 'SHA-256',
      digest: sha256,
    }),
    scope: 'SOURCE_BYTES',
    algorithm: 'SHA-256',
    digest: sha256,
    sourceDocumentId,
    targetId: null,
    storagePath,
    byteLength: fetched.bytes.byteLength,
    mimeType: fetched.contentType,
    observedAt: input.observedAt,
    metadata: {
      sourceType: input.sourceType,
      sourceUrl: fetched.finalUrl,
    },
  });
  const hashWrite = await dependencies.store.putHash(hashRecord);

  return { sourceDocument, hashRecord, archiveWrite, documentWrite, hashWrite };
}

export async function captureVehicleMasterSource(
  dependencies: {
    fetcher: VehicleMasterSourceFetcher;
    archive: VehicleMasterSourceArchive;
    store: VehicleMasterStore;
  },
  input: CaptureVehicleMasterSourceInput
): Promise<CaptureVehicleMasterSourceResult> {
  const fetched = await dependencies.fetcher.fetch(input.sourceUrl);
  return persistFetchedVehicleMasterSource(
    { archive: dependencies.archive, store: dependencies.store },
    input,
    fetched
  );
}

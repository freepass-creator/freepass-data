import {
  deterministicVehicleMasterRecordId,
  sealVehicleMasterPipelineRecord,
  type VehicleMasterPipelineRecord,
  type VehicleMasterSourceDocument,
  type VehicleMasterWriteResult,
} from '../domain/vehicle-master.js';
import { stableDigest } from '../shared/stable-digest.js';
import { sha256Bytes } from '../shared/binary-digest.js';
import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';
import type { VehicleMasterFetchedSource } from '../ports/vehicle-master-source-fetcher.js';
import type { VehicleMasterSourceParser } from '../ports/vehicle-master-source-parser.js';
import type {
  VehicleMasterParseResult,
  VehicleMasterParsedTrim,
} from '../domain/vehicle-master-source.js';

export type ParseFetchedVehicleMasterSourceResult = {
  parserId: string;
  parserVersion: string;
  parseResult: VehicleMasterParseResult;
  sourceHashId: string;
  rawRecordId: string;
  normalizedRecordIds: string[];
  summaryRecordId: string;
  writes: VehicleMasterWriteResult[];
};

function persistedTrim(record: VehicleMasterParsedTrim) {
  const sourceText = record.sourceText ?? '';
  return {
    maker: record.maker,
    model: record.model,
    modelYear: record.modelYear,
    powertrainName: record.powertrainName,
    seats: record.seats,
    drivetrain: record.drivetrain,
    trimName: record.trimName,
    fuelType: record.fuelType,
    basePrice: record.basePrice,
    currency: record.currency,
    effectiveFrom: record.effectiveFrom ?? null,
    baseItems: record.baseItems,
    baseItemDetails: record.baseItemDetails ?? [],
    options: record.options,
    sourceTextHash: stableDigest(sourceText),
    sourceTextExcerpt: sourceText.slice(0, 16_000),
  };
}

function pipelineRecord(
  kind: VehicleMasterPipelineRecord['kind'],
  recordId: string,
  sourceDocumentId: string,
  observedAt: string,
  payload: Record<string, unknown>
) {
  return sealVehicleMasterPipelineRecord({
    recordId,
    kind,
    sourceDocumentId,
    observedAt,
    payload,
  });
}

async function assertPersistedSourceByteHash(
  store: VehicleMasterStore,
  sourceDocument: VehicleMasterSourceDocument,
  fetched: VehicleMasterFetchedSource
): Promise<string> {
  const sourceHashId = deterministicVehicleMasterRecordId('hash', {
    scope: 'SOURCE_BYTES',
    sourceDocumentId: sourceDocument.sourceDocumentId,
    algorithm: 'SHA-256',
    digest: sourceDocument.sha256,
  });
  const hashRecord = await store.getHash(sourceHashId);
  if (!hashRecord) {
    throw new Error('VEHICLE_MASTER_PARSE_SOURCE_HASH_RECORD_MISSING');
  }
  if (
    hashRecord.scope !== 'SOURCE_BYTES' ||
    hashRecord.algorithm !== 'SHA-256' ||
    hashRecord.digest !== sourceDocument.sha256 ||
    hashRecord.sourceDocumentId !== sourceDocument.sourceDocumentId ||
    hashRecord.storagePath !== sourceDocument.storagePath ||
    hashRecord.byteLength !== fetched.bytes.byteLength
  ) {
    throw new Error('VEHICLE_MASTER_PARSE_SOURCE_HASH_RECORD_MISMATCH');
  }
  return sourceHashId;
}

export async function parseFetchedVehicleMasterSource(
  dependencies: {
    store: VehicleMasterStore;
    parsers: readonly VehicleMasterSourceParser[];
  },
  input: {
    sourceDocument: VehicleMasterSourceDocument;
    fetched: VehicleMasterFetchedSource;
  }
): Promise<ParseFetchedVehicleMasterSourceResult> {
  const actualSha = sha256Bytes(input.fetched.bytes);
  if (actualSha !== input.sourceDocument.sha256) {
    throw new Error('VEHICLE_MASTER_PARSE_SOURCE_SHA_MISMATCH');
  }
  const sourceHashId = await assertPersistedSourceByteHash(
    dependencies.store,
    input.sourceDocument,
    input.fetched
  );

  const parseInput = {
    sourceDocumentId: input.sourceDocument.sourceDocumentId,
    sourceUrl: input.sourceDocument.sourceUrl,
    contentType: input.sourceDocument.mimeType,
    bytes: input.fetched.bytes,
  };
  const matching = dependencies.parsers.filter((parser) => parser.canParse(parseInput));
  if (matching.length === 0) {
    throw new Error('VEHICLE_MASTER_PARSER_NOT_FOUND');
  }
  if (matching.length > 1) {
    throw new Error(
      `VEHICLE_MASTER_PARSER_AMBIGUOUS:${matching.map((parser) => parser.parserId).sort().join(',')}`
    );
  }

  const parser = matching[0]!;
  const rawRecordId = deterministicVehicleMasterRecordId('raw', {
    sourceDocumentId: input.sourceDocument.sourceDocumentId,
    sha256: input.sourceDocument.sha256,
  });
  const raw = pipelineRecord(
    'RAW_RECORD',
    rawRecordId,
    input.sourceDocument.sourceDocumentId,
    input.sourceDocument.observedAt,
    {
      storagePath: input.sourceDocument.storagePath,
      sha256: input.sourceDocument.sha256,
      contentType: input.sourceDocument.mimeType,
      byteLength: input.fetched.bytes.byteLength,
      requestedUrl: input.fetched.requestedUrl,
      finalUrl: input.fetched.finalUrl,
    }
  );
  const writes: VehicleMasterWriteResult[] = [await dependencies.store.putPipelineRecord(raw)];

  const parseResult = parser.parse(parseInput);
  if (
    parseResult.parserId !== parser.parserId ||
    parseResult.parserVersion !== parser.parserVersion ||
    parseResult.sourceDocumentId !== input.sourceDocument.sourceDocumentId
  ) {
    throw new Error('VEHICLE_MASTER_PARSER_RESULT_IDENTITY_MISMATCH');
  }

  const normalizedRecordIds: string[] = [];
  for (const record of parseResult.records) {
    const persisted = persistedTrim(record);
    const normalizedRecordId = deterministicVehicleMasterRecordId('normalized', {
      sourceDocumentId: input.sourceDocument.sourceDocumentId,
      parserId: parser.parserId,
      parserVersion: parser.parserVersion,
      record: persisted,
    });
    const normalized = pipelineRecord(
      'NORMALIZED_RECORD',
      normalizedRecordId,
      input.sourceDocument.sourceDocumentId,
      input.sourceDocument.observedAt,
      {
        recordKind: 'TRIM',
        parserId: parser.parserId,
        parserVersion: parser.parserVersion,
        record: persisted,
      }
    );
    normalizedRecordIds.push(normalizedRecordId);
    writes.push(await dependencies.store.putPipelineRecord(normalized));
  }

  const summaryRecordId = deterministicVehicleMasterRecordId('normalized-summary', {
    sourceDocumentId: input.sourceDocument.sourceDocumentId,
    parserId: parser.parserId,
    parserVersion: parser.parserVersion,
    normalizedRecordIds,
    warnings: parseResult.warnings,
  });
  const summary = pipelineRecord(
    'NORMALIZED_RECORD',
    summaryRecordId,
    input.sourceDocument.sourceDocumentId,
    input.sourceDocument.observedAt,
    {
      recordKind: 'SUMMARY',
      parserId: parser.parserId,
      parserVersion: parser.parserVersion,
      recordCount: normalizedRecordIds.length,
      normalizedRecordIds,
      warnings: parseResult.warnings,
    }
  );
  writes.push(await dependencies.store.putPipelineRecord(summary));

  return {
    parserId: parser.parserId,
    parserVersion: parser.parserVersion,
    parseResult,
    sourceHashId,
    rawRecordId,
    normalizedRecordIds,
    summaryRecordId,
    writes,
  };
}

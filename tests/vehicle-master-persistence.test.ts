import { describe, expect, it } from 'vitest';
import {
  deterministicVehicleMasterId,
  sealVehicleMasterCompatibilityRule,
  sealVehicleMasterNode,
  sealVehicleMasterPipelineRecord,
  sealVehicleMasterSourceDocument,
} from '../src/domain/vehicle-master.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import { sha256Bytes } from '../src/infra/vehicle-master-source-archive.js';

const now = '2026-09-25T08:30:00.000Z';

function modelNode(revision = 1, canonicalName = '쏘렌토') {
  const id = deterministicVehicleMasterId('MODEL', {
    makeId: 'make_kia',
    canonicalCode: 'sorento',
  });
  return sealVehicleMasterNode({
    id,
    nodeType: 'MODEL',
    status: 'ACTIVE',
    revision,
    canonicalName,
    parentId: 'make_kia',
    refs: { makeId: 'make_kia' },
    aliases: ['Sorento', '쏘렌토', 'Sorento'],
    attributes: { bodyType: 'SUV' },
    sourceEvidenceIds: ['ev_2', 'ev_1', 'ev_1'],
    effectiveFrom: '2024-01-01T00:00:00.000Z',
    effectiveTo: null,
    createdAt: now,
    updatedAt: now,
  });
}

describe('vehicle master identity and persistence', () => {
  it('hashes source bytes deterministically before Firebase Storage upload', () => {
    expect(sha256Bytes(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('creates deterministic IDs independent of identity key order', () => {
    const a = deterministicVehicleMasterId('TRIM', {
      modelYearId: 'my_2027',
      powertrainId: 'pt_hev',
      canonicalCode: 'signature',
    });
    const b = deterministicVehicleMasterId('TRIM', {
      canonicalCode: 'signature',
      powertrainId: 'pt_hev',
      modelYearId: 'my_2027',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^trim_[a-f0-9]{24}$/);
  });

  it('normalizes aliases/evidence before hashing', () => {
    const record = modelNode();
    expect(record.aliases).toEqual(['Sorento', '쏘렌토']);
    expect(record.sourceEvidenceIds).toEqual(['ev_1', 'ev_2']);
    expect(record.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is idempotent and only permits a sequential canonical revision', async () => {
    const store = new MemoryVehicleMasterStore();
    const first = modelNode();

    await expect(store.putNode(first)).resolves.toBe('CREATED');
    await expect(store.putNode(first)).resolves.toBe('UNCHANGED');

    const second = modelNode(2, '쏘렌토 상품성 개선');
    await expect(store.putNode(second)).resolves.toBe('UPDATED');
    expect((await store.getNode(first.id))?.revision).toBe(2);

    const skipped = modelNode(4, '잘못된 건너뛴 revision');
    await expect(store.putNode(skipped)).rejects.toThrow('REVISION_CONFLICT');
  });

  it('requires Firebase Storage provenance for source documents', () => {
    expect(() => sealVehicleMasterSourceDocument({
      sourceDocumentId: 'srcdoc_kia_2027_sorento',
      sourceType: 'MANUFACTURER_OFFICIAL',
      sourceName: '기아 공식 가격표',
      sourceUrl: 'https://example.invalid/price.pdf',
      publishedAt: '2026-08-01T00:00:00.000Z',
      observedAt: now,
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      effectiveTo: null,
      storagePath: '',
      sha256: 'a'.repeat(64),
      mimeType: 'application/pdf',
      metadata: {},
    })).toThrow('STORAGE_PATH_REQUIRED');

    const doc = sealVehicleMasterSourceDocument({
      sourceDocumentId: 'srcdoc_kia_2027_sorento',
      sourceType: 'MANUFACTURER_OFFICIAL',
      sourceName: '기아 공식 가격표',
      sourceUrl: 'https://example.invalid/price.pdf',
      publishedAt: '2026-08-01T00:00:00.000Z',
      observedAt: now,
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      effectiveTo: null,
      storagePath: 'vehicle-master/source-documents/kia/2027/sorento-price.pdf',
      sha256: 'a'.repeat(64),
      mimeType: 'application/pdf',
      metadata: { maker: '기아' },
    });

    expect(doc.storagePath).toContain('vehicle-master/source-documents');
    expect(doc.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps ingestion records immutable for deterministic IDs', async () => {
    const store = new MemoryVehicleMasterStore();
    const record = sealVehicleMasterPipelineRecord({
      recordId: 'raw_1',
      kind: 'RAW_RECORD',
      sourceDocumentId: 'src_1',
      entityId: null,
      observedAt: now,
      payload: { trim: 'Signature' },
    });

    await expect(store.putPipelineRecord(record)).resolves.toBe('CREATED');
    await expect(store.putPipelineRecord(record)).resolves.toBe('UNCHANGED');

    const conflicting = sealVehicleMasterPipelineRecord({
      recordId: 'raw_1',
      kind: 'RAW_RECORD',
      sourceDocumentId: 'src_1',
      entityId: null,
      observedAt: now,
      payload: { trim: 'Prestige' },
    });
    await expect(store.putPipelineRecord(conflicting)).rejects.toThrow(
      'DETERMINISTIC_ID_COLLISION'
    );
  });

  it('rejects a self-referential option rule', () => {
    expect(() => sealVehicleMasterCompatibilityRule({
      id: 'rule_1',
      revision: 1,
      subjectId: 'opt_a',
      ruleType: 'REQUIRES',
      targetIds: ['opt_a'],
      scope: { modelYearId: 'my_2027' },
      condition: null,
      effect: 'VALID',
      priority: 100,
      sourceEvidenceIds: ['ev_1'],
      effectiveFrom: now,
      effectiveTo: null,
      createdAt: now,
      updatedAt: now,
    })).toThrow('selfRule');
  });
});

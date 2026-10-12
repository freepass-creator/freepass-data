import { describe, expect, it } from 'vitest';
import { applyKakaoInfoCandidates } from '../src/application/apply-kakao-info-candidates.js';
import { readKakaoKnownFacts } from '../src/application/read-kakao-known-facts.js';
import type { KakaoInfoCandidateInput } from '../src/domain/kakao-info-candidate.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';
import { stableDigest } from '../src/shared/stable-digest.js';

const candidate = (patch: Partial<KakaoInfoCandidateInput> = {}): KakaoInfoCandidateInput => ({
  supplierCode: 'RP001',
  roomCode: 'K-TESTFAKE',
  source: { sentAt: '2026-10-12T00:00:00.000Z', side: '상대', msgNo: '100', excerpt: '123가4567 재고 확인' },
  type: '재고',
  vehicle: {
    plate: '123가4567',
    model: 'TEST-FAKE-MODEL',
    plateEvidenceMsgNo: 100,
    plateEvidence: { source: 'LITERAL_IN_UTTERANCE', distance: 0 },
    plateStatusSameSentence: true,
  },
  fields: { 항목: '재고 확인', 요약: '재고 확인', 값: '재고 있음' },
  confidence: 0.8,
  needsSupplierConfirm: false,
  aiInvolved: true,
  status: 'CANDIDATE',
  ...patch,
});

const options = (inputs: KakaoInfoCandidateInput[], writeApproved = false) => ({
  expectedDigest: stableDigest(inputs),
  now: '2026-10-12T01:00:00.000Z',
  writeApproved,
  env: writeApproved ? {
    FREEPASS_KAKAO_INFO_APPLY: 'on',
    FREEPASS_KAKAO_INFO_WRITE_APPROVED: stableDigest(inputs),
  } : {},
});

const writeStore = () => Object.assign(new MemorySourceStore(), { productExists: async () => true });
const secondCandidate = () => candidate({
  source: { ...candidate().source, msgNo: '101', excerpt: '123가4567 second candidate' },
});

describe('applyKakaoInfoCandidates', () => {
  it('defaults to zero-write dry-run and rejects missing approval or digest drift', async () => {
    const store = new MemorySourceStore();
    const inputs = [candidate()];
    await expect(applyKakaoInfoCandidates(store, inputs, { ...options(inputs, true), expectedDigest: 'bad' }))
      .rejects.toThrow('KAKAO_INFO_DIGEST_MISMATCH');
    await expect(applyKakaoInfoCandidates(store, inputs, { ...options(inputs), writeApproved: true }))
      .rejects.toThrow('KAKAO_INFO_WRITE_NOT_APPROVED');
    const dry = await applyKakaoInfoCandidates(store, inputs, options(inputs));
    expect(dry).toMatchObject({ status: 'DRY_RUN', writesEnabled: false, counts: { writes: 0, created: 1 } });
    expect(await store.listCandidatesBySource('kakao-info-candidate')).toHaveLength(0);
  });

  it('applies with double approval, is idempotent, and refuses overwrite conflicts', async () => {
    const store = writeStore();
    const inputs = [candidate()];
    const applied = await applyKakaoInfoCandidates(store, inputs, options(inputs, true));
    expect(applied.counts).toMatchObject({ writes: 1, created: 1 });
    expect(applied.receipts[0]?.readbackDigest).toMatch(/[a-f0-9]{64}/);

    const same = await applyKakaoInfoCandidates(store, inputs, options(inputs));
    expect(same.receipts[0]?.result).toBe('SKIPPED_SAME');

    const conflictStore = Object.assign(new MemorySourceStore(), {
      productExists: async () => true,
      getCandidate: async () => ({
        ...(await store.listCandidatesBySource('kakao-info-candidate'))[0]!,
        sourceFingerprint: 'different',
      }),
    });
    await expect(applyKakaoInfoCandidates(conflictStore, inputs, options(inputs, true)))
      .rejects.toThrow('KAKAO_INFO_CANDIDATE_CONFLICT');
  });

  it('writes only CREATED candidates when an approved batch also contains SKIPPED_SAME candidates', async () => {
    const store = writeStore();
    const first = candidate();
    const second = secondCandidate();
    await applyKakaoInfoCandidates(store, [first], options([first], true));

    const mixed = await applyKakaoInfoCandidates(store, [first, second], options([first, second], true));
    expect(mixed.counts).toMatchObject({ input: 2, skippedSame: 1, created: 1, writes: 1 });
    expect(mixed.receipts.map(receipt => receipt.result)).toEqual(['SKIPPED_SAME', 'CREATED']);
    expect(await store.listCandidatesBySource('kakao-info-candidate')).toHaveLength(2);
  });

  it('treats the same stock candidate as idempotent after freshness expiry', async () => {
    const store = writeStore();
    const inputs = [candidate()];
    await applyKakaoInfoCandidates(store, inputs, options(inputs, true));

    const expiredOptions = {
      ...options(inputs, true),
      now: '2026-10-13T01:00:00.001Z',
    };
    const same = await applyKakaoInfoCandidates(store, inputs, expiredOptions);
    expect(same).toMatchObject({
      status: 'APPLIED',
      counts: { input: 1, skippedSame: 1, created: 0, conflict: 0, writes: 0 },
    });
    expect(same.receipts[0]?.result).toBe('SKIPPED_SAME');
  });

  it('treats a previously saved candidate as idempotent when a later batch adds another candidate', async () => {
    const store = writeStore();
    const first = candidate();
    const second = secondCandidate();
    await applyKakaoInfoCandidates(store, [first], options([first], true));

    const mixedOptions = {
      ...options([first, second], true),
      now: '2026-10-13T01:00:00.001Z',
    };
    const mixed = await applyKakaoInfoCandidates(store, [first, second], mixedOptions);
    expect(mixed.counts).toMatchObject({ input: 2, skippedSame: 1, created: 1, conflict: 0, writes: 1 });
    expect(mixed.receipts.map(receipt => receipt.result)).toEqual(['SKIPPED_SAME', 'CREATED']);
  });

  it('succeeds with zero writes when every approved candidate is already identical', async () => {
    const store = writeStore();
    const inputs = [candidate()];
    await applyKakaoInfoCandidates(store, inputs, options(inputs, true));

    const same = await applyKakaoInfoCandidates(store, inputs, options(inputs, true));
    expect(same).toMatchObject({
      status: 'APPLIED',
      counts: { input: 1, skippedSame: 1, created: 0, writes: 0 },
    });
    expect(await store.listCandidatesBySource('kakao-info-candidate')).toHaveLength(1);
  });

  it('fails readback when persisted candidate content drifts under the same id and fingerprint', async () => {
    const baseStore = writeStore();
    const inputs = [candidate()];
    const listCandidates = baseStore.listCandidates.bind(baseStore);
    const corruptingStore = Object.assign(baseStore, {
      listCandidates: async (runId: string) => (await listCandidates(runId)).map(record => ({
        ...record,
        candidate: {
          ...record.candidate,
          kakaoInfo: {
            ...((record.candidate as unknown as { kakaoInfo: Record<string, unknown> }).kakaoInfo),
            value: 'DRIFTED',
          },
        },
      })),
    });
    await expect(applyKakaoInfoCandidates(corruptingStore, inputs, options(inputs, true)))
      .rejects.toThrow('KAKAO_INFO_READBACK_MISMATCH');
  });

  it('fails readback when stored derived safety fields drift', async () => {
    const baseStore = writeStore();
    const inputs = [candidate({ type: '가격', fields: { 항목: '월렌탈', 요약: '가격', 값: 'TEST-FAKE-AMOUNT-12345' } })];
    const listCandidates = baseStore.listCandidates.bind(baseStore);
    const corruptingStore = Object.assign(baseStore, {
      listCandidates: async (runId: string) => (await listCandidates(runId)).map(record => ({
        ...record,
        candidate: {
          ...record.candidate,
          kakaoInfo: {
            ...((record.candidate as unknown as { kakaoInfo: Record<string, unknown> }).kakaoInfo),
            autoPromotable: true,
          },
        },
      })),
    });
    await expect(applyKakaoInfoCandidates(corruptingStore, inputs, options(inputs, true)))
      .rejects.toThrow('KAKAO_INFO_READBACK_MISMATCH');
  });

  it('treats same immutable body as conflict when skipped stored derived fields are corrupted', async () => {
    const store = writeStore();
    const inputs = [candidate()];
    await applyKakaoInfoCandidates(store, inputs, options(inputs, true));
    const stored = (await store.listCandidatesBySource('kakao-info-candidate'))[0]!;
    const corrupted = {
      ...stored,
      candidate: {
        ...stored.candidate,
        kakaoInfo: {
          ...((stored.candidate as unknown as { kakaoInfo: Record<string, unknown> }).kakaoInfo),
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      },
    };
    const corruptingStore = Object.assign(store, { getCandidate: async () => corrupted });
    await expect(applyKakaoInfoCandidates(corruptingStore, inputs, options(inputs, true)))
      .rejects.toThrow('KAKAO_INFO_CANDIDATE_CONFLICT');
  });

  it('downgrades missing product plates to vehicle-unspecified before writing', async () => {
    const store = Object.assign(new MemorySourceStore(), { productExists: async () => false });
    const inputs = [candidate()];
    const result = await applyKakaoInfoCandidates(store, inputs, options(inputs, true));
    expect(result.receipts[0]).toMatchObject({ result: 'CREATED', vehicleUnspecified: true });
    const persisted = await store.listCandidatesBySource('kakao-info-candidate');
    expect(persisted[0]?.candidate.issues).toContain('VEHICLE_UNSPECIFIED');
  });

  it('requires product existence checks for writes and reports unknown product checks in dry-run', async () => {
    const store = new MemorySourceStore();
    const inputs = [candidate()];
    const dry = await applyKakaoInfoCandidates(store, inputs, options(inputs));
    expect(dry.receipts[0]?.productExistence).toBe('UNKNOWN');
    await expect(applyKakaoInfoCandidates(store, inputs, options(inputs, true)))
      .rejects.toThrow('KAKAO_INFO_PRODUCT_EXISTS_PORT_REQUIRED');
  });
});

describe('readKakaoKnownFacts', () => {
  it('requires asOf, filters TTL boundaries, and marks price-like topics signalOnly', async () => {
    const store = writeStore();
    const price = [candidate({ type: '가격', fields: { 항목: '월렌트', 요약: '가격', 값: 'TEST-FAKE-AMOUNT-12345' } })];
    await applyKakaoInfoCandidates(store, price, options(price, true));
    await expect(readKakaoKnownFacts(store, { vehicleKey: '123가4567', supplierCode: 'RP001', topic: '가격', asOf: '' }))
      .rejects.toThrow('KAKAO_FACT_AS_OF_REQUIRED');
    expect(await readKakaoKnownFacts(store, {
      vehicleKey: '123가4567',
      supplierCode: 'RP001',
      topic: '가격',
      asOf: '2026-10-18T23:59:59.999Z',
    })).toMatchObject([{ item: '월렌트', signalOnly: true, valueSummary: 'TEST-FAKE-AMOUNT-12***' }]);
    expect(await readKakaoKnownFacts(store, {
      vehicleKey: '123가4567',
      supplierCode: 'RP001',
      topic: '가격',
      asOf: '2026-10-19T00:00:00.001Z',
    })).toEqual([]);
  });

  it('uses persisted supplier identity for supplier-specific reads', async () => {
    const store = writeStore();
    const inputs = [candidate()];
    await applyKakaoInfoCandidates(store, inputs, options(inputs, true));
    expect(await readKakaoKnownFacts(store, {
      vehicleKey: '123가4567',
      supplierCode: 'RP001',
      topic: inputs[0]!.type,
      asOf: '2026-10-12T01:00:00.000Z',
    })).toMatchObject([{ topic: inputs[0]!.type, roomCode: 'K-TESTFAKE' }]);
    expect(await readKakaoKnownFacts(store, {
      vehicleKey: '123가4567',
      supplierCode: 'RP999',
      topic: inputs[0]!.type,
      asOf: '2026-10-12T01:00:00.000Z',
    })).toEqual([]);
  });

  it('applies supplier, vehicle uid, invalid time, future sentAt, roomCode, and layer policies', async () => {
    const store = writeStore();
    const inputs = [
      candidate({ type: '서류요구', fields: { 항목: '서류', 요약: '서류요구', 값: '등본' } }),
      candidate({ type: '조건', fields: { 항목: '조건', 요약: '조건', 값: '조건 12345' } }),
    ];
    await applyKakaoInfoCandidates(store, inputs, options(inputs, true));
    const records = await store.listCandidatesBySource('kakao-info-candidate');
    const withFacts = records.map((record, index) => {
      const kakaoInfo = (record.candidate as unknown as { kakaoInfo: Record<string, unknown> }).kakaoInfo;
      return {
        ...record,
        candidate: {
          ...record.candidate,
          kakaoInfo: {
            ...kakaoInfo,
            supplierCode: kakaoInfo.type === '서류요구' ? 'RP001' : 'RP999',
            vehicle: {
              ...(kakaoInfo.vehicle as Record<string, unknown>),
              vehicleUid: kakaoInfo.type === '서류요구' ? 'vehicle-uid-1' : 'vehicle-uid-2',
            },
            ...(kakaoInfo.type === '서류요구' ? { roomCode: 'K-TOPROOM' } : {}),
          },
        },
      };
    });
    const fakeStore = { listCandidatesBySource: async () => withFacts };
    expect(await readKakaoKnownFacts(fakeStore, {
      vehicleUid: 'vehicle-uid-1',
      supplierCode: 'RP001',
      topic: '서류요구',
      asOf: '2026-10-12T01:00:00.000Z',
    })).toMatchObject([{ layer: 'T0', signalOnly: false, roomCode: 'K-TOPROOM' }]);
    expect(await readKakaoKnownFacts(fakeStore, {
      vehicleUid: 'vehicle-uid-2',
      supplierCode: 'RP001',
      topic: '조건',
      asOf: '2026-10-12T01:00:00.000Z',
    })).toEqual([]);
    expect(await readKakaoKnownFacts({ listCandidatesBySource: async () => [{
      ...withFacts[0]!,
      candidate: { ...withFacts[0]!.candidate, kakaoInfo: { ...(withFacts[0]!.candidate as unknown as { kakaoInfo: Record<string, unknown> }).kakaoInfo, expiresAt: 'bad' } },
    }] }, {
      vehicleUid: 'vehicle-uid-1',
      supplierCode: 'RP001',
      topic: '서류요구',
      asOf: '2026-10-12T01:00:00.000Z',
    })).toEqual([]);
    expect(await readKakaoKnownFacts({ listCandidatesBySource: async () => [{
      ...withFacts[0]!,
      candidate: { ...withFacts[0]!.candidate, kakaoInfo: { ...(withFacts[0]!.candidate as unknown as { kakaoInfo: Record<string, unknown> }).kakaoInfo, sentAt: '2026-10-12T01:06:00.001Z' } },
    }] }, {
      vehicleUid: 'vehicle-uid-1',
      supplierCode: 'RP001',
      topic: '서류요구',
      asOf: '2026-10-12T01:00:00.000Z',
    })).toEqual([]);
  });

  it('excludes and counts corrupted persisted derived expiry fields during reads', async () => {
    const store = writeStore();
    const inputs = [candidate()];
    await applyKakaoInfoCandidates(store, inputs, options(inputs, true));
    const stored = (await store.listCandidatesBySource('kakao-info-candidate'))[0]!;
    const result = await readKakaoKnownFacts({ listCandidatesBySource: async () => [{
      ...stored,
      candidate: {
        ...stored.candidate,
        kakaoInfo: {
          ...((stored.candidate as unknown as { kakaoInfo: Record<string, unknown> }).kakaoInfo),
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      },
    }] }, {
      vehicleKey: '123가4567',
      supplierCode: 'RP001',
      topic: inputs[0]!.type,
      asOf: '2026-10-12T01:00:00.000Z',
    });
    expect(result).toEqual([]);
    expect(result.warningCount).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import {
  reconcileVehicleMasterTrimFacts,
} from '../src/application/vehicle-master-reconcile.js';

describe('vehicle master cross-source reconciliation', () => {
  it('fills an explicit drivetrain from Carnoon when the official row leaves it unknown', () => {
    const rows = reconcileVehicleMasterTrimFacts([
      {
        sourceDocumentId: 'kia_official',
        record: {
          maker: '기아',
          model: '쏘렌토',
          modelYear: 2027,
          powertrainName: '2.5 가솔린 터보',
          seats: 5,
          drivetrain: null,
          trimName: '프레스티지',
          fuelType: 'GASOLINE',
          basePrice: 36410000,
          currency: 'KRW',
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          baseItems: ['스마트스트림 G2.5 터보 엔진'],
          options: [
            {
              name: '드라이브 와이즈',
              price: 1290000,
              note: '12.3인치 클러스터 적용 시',
              conditions: [{
                relation: 'REQUIRES',
                targetLabel: '12.3인치 클러스터',
                raw: '12.3인치 클러스터 적용 시',
              }],
              sourceText: '드라이브 와이즈(12.3인치 클러스터 적용 시) 1,290,000',
            },
          ],
          sourceText: 'official',
        },
      },
      {
        sourceDocumentId: 'carnoon',
        record: {
          maker: '기아',
          model: '더 뉴 쏘렌토',
          modelYear: 2027,
          powertrainName: '가솔린 2.5 터보',
          seats: 5,
          drivetrain: '2WD',
          trimName: '프레스티지',
          fuelType: 'GASOLINE',
          basePrice: 36410000,
          currency: 'KRW',
          effectiveFrom: null,
          baseItems: ['스마트스트림 G2.5 터보 엔진'],
          options: [
            {
              name: '드라이브 와이즈',
              price: 1290000,
              sourceText: '드라이브 와이즈 1,290,000',
            },
          ],
          sourceText: 'carnoon',
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      modelYear: 2027,
      seats: 5,
      drivetrain: '2WD',
      trimName: '프레스티지',
      basePrice: 36410000,
      sourceDocumentIds: ['carnoon', 'kia_official'],
      conflicts: [],
    }));
    expect(rows[0]?.fieldEvidence.drivetrain).toEqual(['carnoon']);
    expect(rows[0]?.options).toEqual([
      expect.objectContaining({
        name: '드라이브 와이즈',
        price: 1290000,
        sourceDocumentIds: ['carnoon', 'kia_official'],
        conditions: [
          expect.objectContaining({
            relation: 'REQUIRES',
            targetLabel: '12.3인치 클러스터',
          }),
        ],
      }),
    ]);
  });

  it('keeps conflicting non-null structural facts unresolved', () => {
    const base = {
      maker: '기아',
      model: '쏘렌토',
      modelYear: 2027,
      powertrainName: '2.5 가솔린 터보',
      trimName: '프레스티지',
      fuelType: 'GASOLINE',
      basePrice: 36410000,
      currency: 'KRW' as const,
      effectiveFrom: null,
      baseItems: [],
      options: [],
      sourceText: 'fixture',
    };

    const rows = reconcileVehicleMasterTrimFacts([
      {
        sourceDocumentId: 'source_a',
        record: { ...base, seats: 5, drivetrain: '2WD' },
      },
      {
        sourceDocumentId: 'source_b',
        record: { ...base, seats: 6, drivetrain: '2WD' },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.seats).toBeNull();
    expect(rows[0]?.conflicts).toEqual([
      expect.objectContaining({
        field: 'seats',
        values: [5, 6],
        sourceDocumentIds: ['source_a', 'source_b'],
      }),
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { auditVehicleNameReferenceParity } from '../src/application/vehicle-master-reference-parity.js';

describe('vehicle master reference naming parity', () => {
  const referenceRows = [
    { maker: '제네시스', model: 'G80', subModel: 'G80', yearStart: '2016-07', yearEnd: '2020-03' },
    { maker: '기아', model: 'K3', subModel: '올 뉴 K3', yearStart: '2018-02', yearEnd: '2021-04' },
    { maker: '기아', model: 'K5', subModel: 'K5 DL3', yearStart: '2019-11', yearEnd: '2023-10' },
    { maker: '기아', model: '니로', subModel: '니로', yearStart: '2016-03', yearEnd: '2021-12' },
  ];

  it('keeps exact Encar/F03 labels including approved codes', () => {
    const report = auditVehicleNameReferenceParity({
      referenceRows,
      masterRows: [
        { id: 'k5', maker: '기아', model: 'K5', subModel: 'K5 DL3', generationCode: 'DL3' },
      ],
    });
    expect(report.status).toBe('PASS');
    expect(report.counts.exactMasters).toBe(1);
  });

  it('finds G80 DH and 올 뉴 K3 BD as safe suffix-drift candidates', () => {
    const report = auditVehicleNameReferenceParity({
      referenceRows,
      masterRows: [
        { id: 'g80-dh', maker: '제네시스', model: 'G80', subModel: 'G80 DH', generationCode: 'DH', yearStart: '2016', yearEnd: '2020' },
        { id: 'k3-bd', maker: '기아', model: 'K3', subModel: '올 뉴 K3 BD', generationCode: 'BD', yearStart: '2018', yearEnd: '2021' },
      ],
      productRows: [
        { id: 'p1', plateNumber: '24저4970', maker: '제네시스', model: 'G80', subModel: 'G80 DH' },
      ],
    });
    expect(report.status).toBe('FAIL');
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: 'g80-dh', code: 'GENERATION_CODE_SUFFIX_DRIFT', suggestedSubModel: 'G80' }),
      expect.objectContaining({ entityId: 'k3-bd', code: 'GENERATION_CODE_SUFFIX_DRIFT', suggestedSubModel: '올 뉴 K3' }),
      expect.objectContaining({ entityId: '24저4970', code: 'PRODUCT_USES_DRIFTED_MASTER_NAME', relatedMasterId: 'g80-dh' }),
    ]));
  });

  it('holds a stripped name when its production window does not match', () => {
    const report = auditVehicleNameReferenceParity({
      referenceRows,
      masterRows: [
        { id: 'niro-sg2', maker: '기아', model: '니로', subModel: '니로 SG2', generationCode: 'SG2', yearStart: '2022', yearEnd: '현재' },
      ],
    });
    expect(report.issues).toContainEqual(expect.objectContaining({
      entityId: 'niro-sg2',
      code: 'GENERATION_CODE_SUFFIX_TIME_MISMATCH',
      severity: 'HOLD',
      suggestedSubModel: null,
    }));
  });

  it('does not call a master absent from the partial reference an error', () => {
    const report = auditVehicleNameReferenceParity({
      referenceRows,
      masterRows: [
        { id: 'historical', maker: 'BMW', model: 'M3', subModel: 'M3 E46', generationCode: 'E46' },
      ],
    });
    expect(report.status).toBe('PASS');
    expect(report.counts.outOfReferenceScopeMasters).toBe(1);
  });
});

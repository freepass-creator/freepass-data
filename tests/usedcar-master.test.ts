import { describe, expect, it } from 'vitest';
import {
  searchUsedcarMaster,
  validateUsedcarMasterSemantics,
  type UsedcarMasterRecord,
} from '../src/domain/usedcar-master.js';

function row(overrides: Partial<UsedcarMasterRecord> = {}): UsedcarMasterRecord {
  return {
    recordId: 'used_trim_sorento_2021_noblesse',
    vehicleModelId: 'model_sorento',
    generationId: 'gen_mq4',
    phaseId: 'phase_mq4_pre',
    modelYearId: 'my_2021',
    powertrainId: 'pt_hybrid',
    variantId: 'variant_5seat_2wd',
    trimId: 'trim_noblesse',
    maker: '기아',
    model: '쏘렌토',
    generationName: '4세대 MQ4',
    phaseName: '초기형',
    modelYear: 2021,
    powertrainName: '1.6 터보 하이브리드',
    trimName: '노블레스',
    configuration: {
      fuelType: 'HYBRID',
      drivetrain: '2WD',
      seats: 5,
    },
    aliases: ['MQ4', '쏘렌토 하이브리드'],
    originalBasePriceHistory: [],
    lifecycleStatus: 'HISTORICAL',
    identityStatus: 'RESOLVED',
    holdReasons: [],
    sourceEvidenceIds: ['src_kia_2021'],
    ...overrides,
  };
}

describe('usedcar master', () => {
  it('does not require model year or trim to find a vehicle family', () => {
    const records = [
      row(),
      row({
        recordId: 'used_trim_sorento_2021_prestige',
        trimId: 'trim_prestige',
        trimName: '프레스티지',
      }),
    ];

    const result = searchUsedcarMaster(records, { model: '쏘렌토' });

    expect(result).toHaveLength(2);
    expect(result.every((candidate) => candidate.matchedFields.includes('model'))).toBe(true);
  });

  it('accepts free text and progressively narrows when more facts are known', () => {
    const hybrid = row();
    const gasoline = row({
      recordId: 'used_trim_sorento_2021_gasoline',
      powertrainId: 'pt_gasoline',
      powertrainName: '2.5 가솔린 터보',
      configuration: {
        fuelType: 'GASOLINE',
        drivetrain: '2WD',
        seats: 5,
      },
      trimId: 'trim_signature',
      trimName: '시그니처',
      aliases: ['MQ4', '쏘렌토 가솔린'],
    });

    const freeText = searchUsedcarMaster([hybrid, gasoline], {
      searchText: '쏘렌토 하이브리드',
    });
    expect(freeText[0]?.record.recordId).toBe('used_trim_sorento_2021_noblesse');
    expect(freeText[0]?.unresolvedFields).not.toContain('searchText');
    expect(freeText[1]?.unresolvedFields).toContain('searchText');

    expect(searchUsedcarMaster([hybrid, gasoline], {
      model: '쏘렌토',
      modelYear: 2021,
      powertrain: '하이브리드',
      trim: '노블레스',
    }).map((x) => x.record.recordId)).toEqual([
      'used_trim_sorento_2021_noblesse',
    ]);
  });

  it('keeps a partial record searchable instead of inventing missing identity', () => {
    const partial = row({
      recordId: 'used_partial_sorento',
      modelYearId: null,
      powertrainId: null,
      variantId: null,
      trimId: null,
      modelYear: null,
      powertrainName: null,
      trimName: null,
      identityStatus: 'PARTIAL',
    });

    const result = searchUsedcarMaster([partial], { model: '쏘렌토' });

    expect(result).toHaveLength(1);
    expect(result[0]?.record.modelYear).toBeNull();
    expect(result[0]?.record.trimId).toBeNull();
  });

  it('fails semantic validation when a resolved record is missing stable identity', () => {
    const issues = validateUsedcarMasterSemantics([
      row({ trimId: null }),
    ]);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RESOLVED_STABLE_ID_REQUIRED',
        field: 'trimId',
      }),
    ]));
  });

  it('requires at least one known search fact', () => {
    expect(() => searchUsedcarMaster([row()], {}))
      .toThrow('USEDCAR_MASTER_QUERY_REQUIRED');
  });
});

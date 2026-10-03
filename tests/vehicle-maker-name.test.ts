import { describe, expect, it } from 'vitest';
import { canonicalVehicleMakerName, VEHICLE_MAKER_ALIASES } from '../src/domain/vehicle-maker-name.js';
import { auditVehicleNameReferenceParity } from '../src/application/vehicle-master-reference-parity.js';

describe('vehicle maker display names (Encar, 2026-10-03)', () => {
  it('maps the old F03 names to the Encar display name and keeps others', () => {
    expect(Object.fromEntries(Object.keys(VEHICLE_MAKER_ALIASES).map((name) => [name, canonicalVehicleMakerName(name)])))
      .toEqual({ 토요타: '도요타', 쉐보레: '쉐보레(GM대우)', 르노코리아: '르노코리아(삼성)', KG모빌리티: 'KG모빌리티(쌍용)' });
    for (const name of ['도요타', '쉐보레(GM대우)', '기아', ' 현대 ', 'constructor']) {
      expect(canonicalVehicleMakerName(name)).toBe(name.trim());
    }
  });

  it('keeps old-name masters and products in reference scope after F03 switches to Encar makers', () => {
    const referenceRows = [
      { maker: '쉐보레(GM대우)', model: '볼트(Volt)', subModel: '볼트(Volt)', yearStart: '2016-04', yearEnd: '2019-12' },
      { maker: '도요타', model: 'RAV4', subModel: 'RAV4 5세대', yearStart: '2019-01', yearEnd: '2026-06' },
    ];
    const report = auditVehicleNameReferenceParity({
      referenceRows,
      masterRows: [
        { id: 'volt', maker: '쉐보레', model: '볼트(Volt)', subModel: '볼트(Volt)' },
        { id: 'rav4', maker: '토요타', model: 'RAV4', subModel: 'RAV4 4세대' },
      ],
      productRows: [{ id: 'p1', plateNumber: '12가3456', maker: '토요타', model: 'RAV4', subModel: 'RAV4 4세대' }],
    });
    expect(report.counts.exactMasters).toBe(1);
    expect(report.counts.outOfReferenceScopeMasters).toBe(0);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: 'rav4', code: 'REFERENCE_NAME_MISMATCH', maker: '토요타' }),
      expect.objectContaining({ entityId: '12가3456', entityKind: 'PRODUCT' }),
    ]));
  });
});

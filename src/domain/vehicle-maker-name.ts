/**
 * F03 차종마스터 shows makers exactly as Encar does (대표 2026-10-03). Names already stored in
 * products, vehicle_master and supplier sheets stay valid as aliases of that display name.
 */
export const VEHICLE_MAKER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  토요타: '도요타',
  쉐보레: '쉐보레(GM대우)',
  르노코리아: '르노코리아(삼성)',
  KG모빌리티: 'KG모빌리티(쌍용)',
});

const text = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');

/** Encar display name for a maker; unknown names pass through unchanged. */
export function canonicalVehicleMakerName(value: string): string {
  const name = text(value);
  return Object.hasOwn(VEHICLE_MAKER_ALIASES, name) ? VEHICLE_MAKER_ALIASES[name]! : name;
}

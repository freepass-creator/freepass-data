/**
 * 제조사 정본 표기 = 엔카와 같되 괄호 없이 짧게(대표 2026-10-04 최종): 도요타 · 쉐보레 · 르노 · KGM.
 * 옛 이름·괄호 표기는 이미 저장된 products·vehicle_master·공급사 시트에서 계속 인식되도록 별칭으로 둔다.
 */
export const VEHICLE_MAKER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  토요타: '도요타',
  '쉐보레(GM대우)': '쉐보레',
  GM대우: '쉐보레',
  르노코리아: '르노',
  '르노코리아(삼성)': '르노',
  르노삼성: '르노',
  KG모빌리티: 'KGM',
  'KG모빌리티(쌍용)': 'KGM',
  쌍용: 'KGM',
});

const text = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');

/** Encar display name for a maker; unknown names pass through unchanged. */
export function canonicalVehicleMakerName(value: string): string {
  const name = text(value);
  return Object.hasOwn(VEHICLE_MAKER_ALIASES, name) ? VEHICLE_MAKER_ALIASES[name]! : name;
}

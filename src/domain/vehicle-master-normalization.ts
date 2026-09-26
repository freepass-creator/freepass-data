const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[^0-9a-z가-힣.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const POWERTRAIN_TOKEN_ALIASES: Record<string, string> = {
  hev: '하이브리드',
  hybrid: '하이브리드',
  ev: '전기',
  electric: '전기',
  gasoline: '가솔린',
  petrol: '가솔린',
  diesel: '디젤',
};

export type CanonicalFuelType =
  | 'HYBRID'
  | 'ELECTRIC'
  | 'DIESEL'
  | 'GASOLINE'
  | 'LPG';

export function canonicalPowertrainIdentity(value: string) {
  return normalize(value)
    .split(' ')
    .filter(Boolean)
    .map((token) => POWERTRAIN_TOKEN_ALIASES[token] ?? token)
    .sort()
    .join('|');
}

export function canonicalTrimIdentity(value: string) {
  return normalize(value).replace(/\s+/g, '');
}

export function inferPowertrainFuelType(value: string): CanonicalFuelType | null {
  const tokens = normalize(value).split(' ').filter(Boolean);
  const tokenSet = new Set(tokens);

  if (
    tokenSet.has('하이브리드') ||
    tokenSet.has('hev') ||
    tokenSet.has('phev') ||
    tokenSet.has('hybrid')
  ) return 'HYBRID';

  if (
    tokenSet.has('전기') ||
    tokenSet.has('ev') ||
    tokenSet.has('electric')
  ) return 'ELECTRIC';

  if (tokenSet.has('디젤') || tokenSet.has('diesel')) return 'DIESEL';
  if (tokenSet.has('가솔린') || tokenSet.has('gasoline') || tokenSet.has('petrol')) {
    return 'GASOLINE';
  }
  if (tokenSet.has('lpg')) return 'LPG';

  return null;
}

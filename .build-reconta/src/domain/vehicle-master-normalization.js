const normalize = (value) => value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[^0-9a-z가-힣.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
const POWERTRAIN_TOKEN_ALIASES = {
    hev: '하이브리드',
    hybrid: '하이브리드',
    ev: '전기',
    electric: '전기',
    gasoline: '가솔린',
    petrol: '가솔린',
    diesel: '디젤',
};
export function canonicalPowertrainIdentity(value) {
    return normalize(value)
        .split(' ')
        .filter(Boolean)
        .map((token) => POWERTRAIN_TOKEN_ALIASES[token] ?? token)
        .sort()
        .join('|');
}
export function canonicalTrimIdentity(value) {
    return normalize(value).replace(/\s+/g, '');
}
export function canonicalHierarchyLabelIdentity(value) {
    return normalize(value).replace(/\s+/g, '');
}
export function canonicalSupplementalIdentity(value) {
    return normalize(value).replace(/\s+/g, '');
}
export function inferPowertrainFuelType(value) {
    const tokens = normalize(value).split(' ').filter(Boolean);
    const tokenSet = new Set(tokens);
    if (tokenSet.has('하이브리드') ||
        tokenSet.has('hev') ||
        tokenSet.has('phev') ||
        tokenSet.has('hybrid'))
        return 'HYBRID';
    if (tokenSet.has('전기') ||
        tokenSet.has('ev') ||
        tokenSet.has('electric'))
        return 'ELECTRIC';
    if (tokenSet.has('디젤') || tokenSet.has('diesel'))
        return 'DIESEL';
    if (tokenSet.has('가솔린') || tokenSet.has('gasoline') || tokenSet.has('petrol')) {
        return 'GASOLINE';
    }
    if (tokenSet.has('lpg'))
        return 'LPG';
    return null;
}
const DRIVETRAIN_ALIASES = {
    '2wd': '2WD',
    '4wd': '4WD',
    'awd': 'AWD',
    'fwd': 'FWD',
    'rwd': 'RWD',
    'front wheel drive': 'FWD',
    'rear wheel drive': 'RWD',
    'all wheel drive': 'AWD',
    '전륜': 'FWD',
    '후륜': 'RWD',
};
export function canonicalDrivetrain(value) {
    if (!value)
        return null;
    return DRIVETRAIN_ALIASES[normalize(value)] ?? null;
}
export function canonicalSeatCount(value) {
    return typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 99
        ? value
        : null;
}
export function canonicalVariantIdentity(input) {
    return {
        seats: canonicalSeatCount(input.seats),
        drivetrain: canonicalDrivetrain(input.drivetrain),
    };
}
export function inferVariantFacts(value) {
    const normalized = normalize(value);
    const seatMatch = normalized.match(/(?:^|\s)(\d{1,2})\s*(?:인승|seat|seats|seater)(?:\s|$)/i);
    const seats = seatMatch ? canonicalSeatCount(Number(seatMatch[1])) : null;
    const drivetrain = Object.entries(DRIVETRAIN_ALIASES)
        .sort(([a], [b]) => b.length - a.length)
        .find(([alias]) => normalized === alias ||
        normalized.startsWith(`${alias} `) ||
        normalized.endsWith(` ${alias}`) ||
        normalized.includes(` ${alias} `))?.[1] ?? null;
    return { seats, drivetrain };
}

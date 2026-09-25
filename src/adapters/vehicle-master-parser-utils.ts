import type {
  VehicleMasterParsedCondition,
  VehicleMasterParsedOption,
  VehicleMasterParsedOptionKind,
  VehicleMasterParsedTrim,
} from '../domain/vehicle-master-source.js';

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

export function htmlToVehicleText(bytes: Buffer): string {
  let html = bytes.toString('utf8');
  html = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|section|article|button|option)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  for (const [entity, value] of Object.entries(ENTITIES)) {
    html = html.replaceAll(entity, value);
  }
  html = html
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
  return html
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function vehicleTextLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function parseKrw(value: string): number | null {
  const normalized = value.replace(/[^0-9]/g, '');
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isSafeInteger(amount) ? amount : null;
}

export function splitOptionPrice(line: string): VehicleMasterParsedOption | null {
  const match = line.match(/^(.+?)(?:\s+)?(\d{1,3}(?:,\d{3})+)\s*(?:원)?$/);
  if (!match?.[1] || !match[2]) return null;
  const name = match[1].trim();
  const price = parseKrw(match[2]);
  if (!name || price === null) return null;
  return { name, kind: classifyParsedOptionKind(name), price, sourceText: line };
}

export function uniqueParsedTrims(records: VehicleMasterParsedTrim[]) {
  const seen = new Map<string, VehicleMasterParsedTrim>();
  for (const record of records) {
    const key = JSON.stringify([
      record.maker,
      record.model,
      record.modelYear,
      record.powertrainName,
      record.seats,
      record.drivetrain,
      record.trimName,
      record.basePrice,
    ]);
    if (!seen.has(key)) seen.set(key, record);
  }
  return [...seen.values()];
}

export function isoDateFromKorean(
  year: string,
  month: string,
  day: string
): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}


export function normalizeParsedOptionCondition(
  option: VehicleMasterParsedOption
): VehicleMasterParsedOption {
  const match = option.name.match(/^(.*?)\((.+?)\)$/);
  if (!match?.[1] || !match[2]) return option;

  const baseName = match[1].trim();
  const raw = match[2].trim();
  const conditions: VehicleMasterParsedCondition[] = [];

  const requires = raw.match(/^(.+?)\s*(?:적용|선택)\s*시$/);
  if (requires?.[1]) {
    conditions.push({
      relation: 'REQUIRES',
      targetLabel: requires[1].trim(),
      raw,
    });
  }

  const excludes = raw.match(/^(.+?)\s*미적용\s*시$/);
  if (excludes?.[1]) {
    conditions.push({
      relation: 'EXCLUDES',
      targetLabel: excludes[1].trim(),
      raw,
    });
  }

  if (!conditions.length) return option;

  return {
    ...option,
    name: baseName,
    note: raw,
    conditions,
  };
}


export function classifyParsedOptionKind(name: string): VehicleMasterParsedOptionKind {
  const normalized = name.trim();
  if (/^\d+인승$/.test(normalized)) return 'SEATS';
  if (/^(?:전자식\s*)?(?:4WD|AWD)$/i.test(normalized)) return 'DRIVETRAIN';
  if (/^\[악세사리\]/.test(normalized) || /^\[액세서리\]/.test(normalized)) return 'ACCESSORY';
  if (
    /(?:펄|메탈릭|매트|화이트|블랙|그레이|실버|레드|블루|그린|브라운|베이지)$/.test(normalized) &&
    normalized.length <= 40
  ) {
    return 'COLOR';
  }
  return 'OPTION';
}

export function withParsedOptionKind(
  option: VehicleMasterParsedOption,
  kind: VehicleMasterParsedOptionKind
): VehicleMasterParsedOption {
  return { ...option, kind };
}


export function splitTopLevelComma(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      const item = value.slice(start, index).trim();
      if (item) out.push(item);
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export const VEHICLE_BASE_ITEM_CATEGORIES = new Set([
  '파워트레인',
  '첨단 운전자 보조(ADAS)',
  '첨단 운전자 보조',
  '안전',
  '외장',
  '내장',
  '시트',
  '편의',
  '인포테인먼트',
]);

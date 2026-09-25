import type {
  VehicleMasterParsedOption,
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
  return { name, price, sourceText: line };
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

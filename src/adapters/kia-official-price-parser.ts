import type {
  VehicleMasterParseResult,
  VehicleMasterParsedTrim,
} from '../domain/vehicle-master-source.js';
import type {
  VehicleMasterParseInput,
  VehicleMasterSourceParser,
} from '../ports/vehicle-master-source-parser.js';
import {
  htmlToVehicleText,
  isoDateFromKorean,
  normalizeParsedOptionCondition,
  parseKrw,
  splitOptionPrice,
  uniqueParsedTrims,
  vehicleTextLines,
} from './vehicle-master-parser-utils.js';

const TRIM_NAMES = new Set([
  '프레스티지',
  '노블레스',
  '시그니처',
  'X-Line',
  '블랙 에디션',
]);

function kiaModelName(text: string, url: string | null) {
  const title = text.match(/기아\s+([^\n]+?)\s+가격(?:\s*-|\n|$)/);
  if (title?.[1]) return title[1].trim();
  if (text.includes('쏘렌토')) return '쏘렌토';
  if (url) {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const vehicleIndex = parts.indexOf('vehicles');
    if (vehicleIndex >= 0 && parts[vehicleIndex + 1]) return parts[vehicleIndex + 1]!;
  }
  return 'UNKNOWN';
}

function modelYear(text: string) {
  const english = text.match(/\bThe\s+(20\d{2})\b/i);
  if (english?.[1]) return Number(english[1]);
  const korean = text.match(/\b(20\d{2})년형\b/);
  return korean?.[1] ? Number(korean[1]) : null;
}

function effectiveFrom(text: string) {
  const match = text.match(/(20\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일\s*기준/);
  return match?.[1] && match[2] && match[3]
    ? isoDateFromKorean(match[1], match[2], match[3])
    : null;
}

function selectedPowertrain(lines: string[]) {
  const pattern =
    /^(?:\d(?:\.\d+)?\s*)?(?:가솔린|디젤|터보 하이브리드|하이브리드|전기|EV)(?:\s|\(|$)/;
  return lines.find((line) => pattern.test(line) && line.length <= 50) ?? null;
}

function heroSeats(text: string) {
  const match = text.match(/\((?:[^)]*?)\b(\d+)인승\s*기준\)/);
  return match?.[1] ? Number(match[1]) : null;
}

function nextPrice(lines: string[], start: number) {
  for (let i = start; i < Math.min(lines.length, start + 5); i += 1) {
    const price = parseKrw(lines[i] ?? '');
    if (price !== null && /\d{1,3}(?:,\d{3})+/.test(lines[i] ?? '')) {
      return { price, index: i };
    }
  }
  return null;
}

export class KiaOfficialPriceParser implements VehicleMasterSourceParser {
  readonly parserId = 'KIA_OFFICIAL_PRICE';
  readonly parserVersion = '1.0.0';

  canParse(input: VehicleMasterParseInput) {
    if (!input.sourceUrl) return false;
    try {
      const url = new URL(input.sourceUrl);
      return (
        (url.hostname === 'kia.com' || url.hostname.endsWith('.kia.com')) &&
        /\/vehicles\/[^/]+\/price\/?$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  parse(input: VehicleMasterParseInput): VehicleMasterParseResult {
    const text = htmlToVehicleText(input.bytes);
    const lines = vehicleTextLines(text);
    const year = modelYear(text);
    const powertrainName = selectedPowertrain(lines);
    const model = kiaModelName(text, input.sourceUrl);
    const effective = effectiveFrom(text);
    const seats = heroSeats(text);
    const warnings: string[] = [];
    const records: VehicleMasterParsedTrim[] = [];

    if (!year) warnings.push('MODEL_YEAR_NOT_FOUND');
    if (!powertrainName) warnings.push('POWERTRAIN_NOT_FOUND');
    if (model === 'UNKNOWN') warnings.push('MODEL_NOT_FOUND');

    if (year && powertrainName) {
      for (let i = 0; i < lines.length; i += 1) {
        const trimName = lines[i] ?? '';
        if (!TRIM_NAMES.has(trimName)) continue;

        const priced = nextPrice(lines, i + 1);
        if (!priced) continue;

        const baseItems: string[] = [];
        const options = [];
        let inOptions = false;

        for (let j = priced.index + 1; j < lines.length; j += 1) {
          const line = lines[j] ?? '';
          if (j > priced.index + 1 && TRIM_NAMES.has(line)) break;
          if (/^트림\/가격/.test(line) || /^판매가격/.test(line)) break;
          if (line === '선택품목' || line.includes('선택품목 ')) {
            inOptions = true;
            continue;
          }
          if (line === '기아 순정 액세서리' || line.includes('기아 순정 액세서리')) {
            inOptions = true;
            continue;
          }

          if (inOptions) {
            const option = splitOptionPrice(line);
            if (option) options.push(normalizeParsedOptionCondition(option));
            continue;
          }

          if (
            line.length >= 2 &&
            line.length <= 500 &&
            !/^\d{1,3}(?:,\d{3})+$/.test(line) &&
            !line.startsWith('[Button')
          ) {
            baseItems.push(line);
          }
        }

        records.push({
          maker: '기아',
          model,
          modelYear: year,
          powertrainName,
          seats,
          drivetrain: null,
          trimName,
          fuelType:
            powertrainName.includes('하이브리드') ? 'HYBRID'
              : powertrainName.includes('전기') || powertrainName.includes('EV') ? 'ELECTRIC'
                : powertrainName.includes('디젤') ? 'DIESEL'
                  : powertrainName.includes('가솔린') ? 'GASOLINE'
                    : null,
          basePrice: priced.price,
          currency: 'KRW',
          effectiveFrom: effective,
          baseItems: [...new Set(baseItems)],
          options,
          sourceText: lines.slice(i, Math.min(lines.length, priced.index + 40)).join('\n'),
        });
      }
    }

    if (!records.length) warnings.push('NO_TRIM_RECORDS_PARSED');

    return {
      parserId: this.parserId,
      parserVersion: this.parserVersion,
      sourceDocumentId: input.sourceDocumentId,
      records: uniqueParsedTrims(records),
      warnings,
    };
  }
}

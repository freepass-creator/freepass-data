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
  parseKrw,
  splitOptionPrice,
  splitTopLevelComma,
  uniqueParsedTrims,
  vehicleTextLines,
  VEHICLE_BASE_ITEM_CATEGORIES,
} from './vehicle-master-parser-utils.js';

function modelName(text: string) {
  const title = text.match(/기아자동차\s+(.+?)\s+(?:가격표|견적|리스\/렌트)/);
  if (title?.[1]) return title[1].trim();
  const generic = text.match(/(?:현대자동차|제네시스|쉐보레|르노코리아|KG모빌리티|BMW|벤츠|아우디)\s+(.+?)\s+(?:가격표|견적)/);
  return generic?.[1]?.trim() ?? 'UNKNOWN';
}

function makerName(text: string) {
  if (text.includes('기아자동차')) return '기아';
  if (text.includes('현대자동차')) return '현대';
  if (text.includes('제네시스')) return '제네시스';
  if (text.includes('쉐보레')) return '쉐보레';
  if (text.includes('르노코리아')) return '르노코리아';
  if (text.includes('KG모빌리티')) return 'KG모빌리티';
  if (text.includes('BMW')) return 'BMW';
  if (text.includes('벤츠')) return '메르세데스-벤츠';
  if (text.includes('아우디')) return '아우디';
  return 'UNKNOWN';
}

function parseContext(line: string) {
  const match = line.match(
    /^(20\d{2})년형\s+(.+?)\s+(\d+)인승(?:\s*\([^)]*\))?$/
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    modelYear: Number(match[1]),
    powertrainName: match[2].trim(),
    seats: Number(match[3]),
  };
}

function parseTrimLine(line: string) {
  const match = line.match(
    /^(.+?)\s+(2WD|4WD|AWD|FWD|RWD)\s+(.+?)\s+(?:[\d.]+\s*㎞\/ℓ\s+)?([\d,]+)\s*원$/
  );
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
  const price = parseKrw(match[4]);
  if (price === null) return null;
  return {
    trimName: match[1].trim(),
    drivetrain: match[2],
    fuelLabel: match[3].trim(),
    basePrice: price,
  };
}

function normalizeFuel(label: string, powertrainName: string) {
  if (powertrainName.includes('하이브리드')) return 'HYBRID';
  if (powertrainName.includes('전기') || powertrainName.includes('EV')) return 'ELECTRIC';
  if (label.includes('경유') || powertrainName.includes('디젤')) return 'DIESEL';
  if (label.includes('휘발유') || powertrainName.includes('가솔린')) return 'GASOLINE';
  if (label.includes('LPG') || powertrainName.includes('LPG')) return 'LPG';
  return null;
}

export class CarnoonVehicleParser implements VehicleMasterSourceParser {
  readonly parserId = 'CARNOON_VEHICLE';
  readonly parserVersion = '1.0.0';

  canParse(input: VehicleMasterParseInput) {
    if (!input.sourceUrl) return false;
    try {
      const url = new URL(input.sourceUrl);
      return (
        (url.hostname === 'carnoon.co.kr' || url.hostname.endsWith('.carnoon.co.kr')) &&
        /\/newcar\/(?:vehicle|estimate)\/\d+/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  parse(input: VehicleMasterParseInput): VehicleMasterParseResult {
    const text = htmlToVehicleText(input.bytes);
    const lines = vehicleTextLines(text);
    const maker = makerName(text);
    const model = modelName(text);
    const warnings: string[] = [];
    const records: VehicleMasterParsedTrim[] = [];
    let context: ReturnType<typeof parseContext> = null;
    let current: VehicleMasterParsedTrim | null = null;
    let currentCategory: string | null = null;
    let lastOptionIndex: number | null = null;

    if (maker === 'UNKNOWN') warnings.push('MAKER_NOT_FOUND');
    if (model === 'UNKNOWN') warnings.push('MODEL_NOT_FOUND');

    for (const line of lines) {
      const nextContext = parseContext(line);
      if (nextContext) {
        context = nextContext;
        current = null;
        currentCategory = null;
        lastOptionIndex = null;
        continue;
      }
      if (!context) continue;

      const trim = parseTrimLine(line);
      if (trim) {
        currentCategory = null;
        lastOptionIndex = null;
        current = {
          maker,
          model,
          modelYear: context.modelYear,
          powertrainName: context.powertrainName,
          seats: context.seats,
          drivetrain: trim.drivetrain,
          trimName: trim.trimName,
          fuelType: normalizeFuel(trim.fuelLabel, context.powertrainName),
          basePrice: trim.basePrice,
          currency: 'KRW',
          effectiveFrom: null,
          baseItems: [],
          baseItemDetails: [],
          options: [],
          sourceText: line,
        };
        records.push(current);
        continue;
      }

      if (!current) continue;

      if (VEHICLE_BASE_ITEM_CATEGORIES.has(line)) {
        currentCategory = line;
        lastOptionIndex = null;
        continue;
      }

      const option = splitOptionPrice(line);
      if (
        option &&
        !/^[\d.]+\s*㎞\/ℓ/.test(option.name) &&
        !option.name.includes('판매 가격')
      ) {
        const normalizedOption = option.kind === 'ACCESSORY'
          ? { ...option, name: option.name.replace(/^\[(?:악세사리|액세서리)\]\s*/, '') }
          : option;
        current.options.push(normalizedOption);
        lastOptionIndex = current.options.length - 1;
        currentCategory = null;
        continue;
      }

      if (line.startsWith('■ ')) {
        const description = line.slice(2).trim();
        const last = lastOptionIndex === null ? null : current.options[lastOptionIndex];
        if (last && !last.note) {
          last.note = description;
          const packageText = description.split('※')[0]?.trim() ?? '';
          const packageItems = splitTopLevelComma(packageText);
          if (packageItems.length > 1 || /패키지/.test(last.name)) {
            last.packageItems = packageItems;
          }
          lastOptionIndex = null;
        } else {
          const items = splitTopLevelComma(description);
          current.baseItems.push(...items);
          current.baseItemDetails?.push(
            ...items.map((name) => ({
              category: currentCategory,
              name,
              sourceText: line,
            }))
          );
        }
        continue;
      }

      if (
        currentCategory &&
        line.length >= 2 &&
        line.length <= 1000 &&
        !line.includes('가격표 보기')
      ) {
        const items = splitTopLevelComma(line);
        current.baseItems.push(...items);
        current.baseItemDetails?.push(
          ...items.map((name) => ({
            category: currentCategory,
            name,
            sourceText: line,
          }))
        );
        lastOptionIndex = null;
      }
    }

    if (!records.length) warnings.push('NO_TRIM_RECORDS_PARSED');

    return {
      parserId: this.parserId,
      parserVersion: this.parserVersion,
      sourceDocumentId: input.sourceDocumentId,
      records: uniqueParsedTrims(records).map((record) => ({
        ...record,
        baseItems: [...new Set(record.baseItems)],
        options: record.options.filter(
          (option, index, values) =>
            values.findIndex(
              (candidate) =>
                candidate.name === option.name &&
                candidate.price === option.price
            ) === index
        ),
      })),
      warnings,
    };
  }
}

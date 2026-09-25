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
  uniqueParsedTrims,
  vehicleTextLines,
} from './vehicle-master-parser-utils.js';

function nextValue(lines: string[], label: string) {
  const index = lines.findIndex((line) => line === label);
  return index >= 0 ? lines[index + 1]?.trim() || null : null;
}

function parseModelYear(lines: string[]) {
  const labelIndex = lines.findIndex((line) => line === '연형+차종');
  const candidate = labelIndex >= 0 ? lines[labelIndex + 1] : null;
  const match = candidate?.match(/^(20\d{2})\s+(.+)$/);
  return match?.[1] && match[2]
    ? { modelYear: Number(match[1]), model: match[2].trim() }
    : null;
}

function fuelType(label: string) {
  if (label.includes('하이브리드')) return 'HYBRID';
  if (label.includes('전기')) return 'ELECTRIC';
  if (label.includes('디젤')) return 'DIESEL';
  if (label.includes('LPG')) return 'LPG';
  if (label.includes('가솔린')) return 'GASOLINE';
  return null;
}

function parseManwon(value: string) {
  const match = value.match(/([\d,]+)\s*만원/);
  if (!match?.[1]) return null;
  const units = Number(match[1].replaceAll(',', ''));
  const amount = units * 10_000;
  return Number.isSafeInteger(amount) ? amount : null;
}

function parseGrade(line: string) {
  const normalized = line.replace(/^단종\s+/, '').trim();
  const inlinePrice = parseManwon(normalized);
  const withoutPrice = normalized
    .replace(/\s+[\d,]+\s*만원.*$/, '')
    .trim();

  const withDrive = withoutPrice.match(
    /^(.+?)\s+(2WD|4WD|AWD|FWD|RWD)(?:\s|$)/
  );
  if (withDrive?.[1] && withDrive[2]) {
    const detail = withDrive[1].trim().match(
      /^([0-9.]+)\s+(가솔린|디젤|LPG|하이브리드|전기)(?:\s+(터보))?\s+(.+)$/
    );
    if (detail?.[1] && detail[2] && detail[4]) {
      return {
        powertrainName: [detail[1], detail[2], detail[3]].filter(Boolean).join(' '),
        fuelLabel: detail[2],
        trimName: detail[4].trim(),
        drivetrain: withDrive[2],
        inlinePrice,
      };
    }
  }

  const generic = withoutPrice.match(
    /^([0-9.]+)\s+(가솔린|디젤|LPG|하이브리드|전기)(?:\s+(터보))?\s+(.+?)\s+(?:A\/T|M\/T|CVT|DCT)$/
  );
  if (!generic?.[1] || !generic[2] || !generic[4]) return null;

  return {
    powertrainName: [generic[1], generic[2], generic[3]].filter(Boolean).join(' '),
    fuelLabel: generic[2],
    trimName: generic[4].trim(),
    drivetrain: null,
    inlinePrice,
  };
}

function nextPrice(lines: string[], start: number) {
  for (let index = start + 1; index < Math.min(lines.length, start + 9); index += 1) {
    const amount = parseManwon(lines[index] ?? '');
    if (amount !== null) return { amount, index };
  }
  return null;
}

export class CarisyouHistoricalParser implements VehicleMasterSourceParser {
  readonly parserId = 'CARISYOU_HISTORICAL';
  readonly parserVersion = '1.0.0';

  canParse(input: VehicleMasterParseInput) {
    if (!input.sourceUrl) return false;
    try {
      const url = new URL(input.sourceUrl);
      return (
        (url.hostname === 'carisyou.com' || url.hostname.endsWith('.carisyou.com')) &&
        /^\/car\/\d+(?:\/(?:Price|Spec))?\/?$/i.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  parse(input: VehicleMasterParseInput): VehicleMasterParseResult {
    const text = htmlToVehicleText(input.bytes);
    const lines = vehicleTextLines(text);
    const maker = nextValue(lines, '브랜드') ?? 'UNKNOWN';
    const modelInfo = parseModelYear(lines);
    const model = modelInfo?.model ?? nextValue(lines, '대표차종') ?? 'UNKNOWN';
    const year = modelInfo?.modelYear ?? null;
    const warnings: string[] = [];
    const records: VehicleMasterParsedTrim[] = [];

    if (maker === 'UNKNOWN') warnings.push('MAKER_NOT_FOUND');
    if (model === 'UNKNOWN') warnings.push('MODEL_NOT_FOUND');
    if (!year) warnings.push('MODEL_YEAR_NOT_FOUND');

    if (year) {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const grade = parseGrade(line);
        if (!grade) continue;

        const priced = grade.inlinePrice !== null
          ? { amount: grade.inlinePrice, index }
          : nextPrice(lines, index);
        if (!priced) continue;

        records.push({
          maker,
          model,
          modelYear: year,
          powertrainName: grade.powertrainName,
          seats: null,
          drivetrain: grade.drivetrain,
          trimName: grade.trimName,
          fuelType: fuelType(grade.fuelLabel),
          basePrice: priced.amount,
          currency: 'KRW',
          effectiveFrom: null,
          baseItems: [],
          baseItemDetails: [],
          options: [],
          sourceText: lines.slice(index, priced.index + 1).join('\n'),
        });
      }
    }

    if (!records.length) warnings.push('NO_TRIM_RECORDS_PARSED');
    warnings.push('HISTORICAL_STRUCTURED_SOURCE');
    warnings.push('SEATS_REQUIRE_CORROBORATION');

    return {
      parserId: this.parserId,
      parserVersion: this.parserVersion,
      sourceDocumentId: input.sourceDocumentId,
      records: uniqueParsedTrims(records),
      warnings: [...new Set(warnings)].sort(),
    };
  }
}

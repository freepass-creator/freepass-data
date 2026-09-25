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

const MAKERS = [
  '현대', '기아', '제네시스', '르노코리아', 'KGM', '쉐보레',
  'BMW', '벤츠', '메르세데스-벤츠', '아우디', '폭스바겐', '볼보',
  '토요타', '렉서스', '혼다', '포드', '링컨', '지프', '테슬라',
  'BYD', '포르쉐', '미니', '랜드로버', '폴스타',
] as const;

function parseMakerModel(lines: string[]) {
  for (const line of lines) {
    for (const maker of MAKERS) {
      if (line.startsWith(`${maker} `) && line.length > maker.length + 1) {
        return { maker, model: line.slice(maker.length + 1).trim() };
      }
    }
  }
  return { maker: 'UNKNOWN', model: 'UNKNOWN' };
}

function parseContext(line: string) {
  const match = line.match(/^(20\d{2})년형\s+(.+?)(?:\s*\([^)]*\))?$/);
  if (!match?.[1] || !match[2]) return null;
  return {
    modelYear: Number(match[1]),
    powertrainName: match[2].trim(),
  };
}

function parseTrim(line: string) {
  const match = line.match(/^(.+?)\s+(2WD|4WD|AWD|FWD|RWD)\s+(?:A\/T|M\/T|CVT|DCT)$/i);
  if (!match?.[1] || !match[2]) return null;
  return {
    trimName: match[1].trim(),
    drivetrain: match[2].toUpperCase(),
  };
}

function parseManwon(line: string) {
  const match = line.match(/^([\d,]+)\s*만\s*원$/);
  if (!match?.[1]) return null;
  const amount = Number(match[1].replaceAll(',', '')) * 10_000;
  return Number.isSafeInteger(amount) ? amount : null;
}

function nextPrice(lines: string[], start: number) {
  for (let index = start + 1; index < Math.min(lines.length, start + 6); index += 1) {
    const amount = parseManwon(lines[index] ?? '');
    if (amount !== null) return { amount, index };
  }
  return null;
}

function normalizeFuel(powertrain: string) {
  if (powertrain.includes('하이브리드')) return 'HYBRID';
  if (powertrain.includes('전기')) return 'ELECTRIC';
  if (powertrain.includes('디젤')) return 'DIESEL';
  if (powertrain.includes('LPG')) return 'LPG';
  if (powertrain.includes('가솔린')) return 'GASOLINE';
  return null;
}

export class DanawaVehicleParser implements VehicleMasterSourceParser {
  readonly parserId = 'DANAWA_VEHICLE';
  readonly parserVersion = '1.0.0';

  canParse(input: VehicleMasterParseInput) {
    if (!input.sourceUrl) return false;
    try {
      const url = new URL(input.sourceUrl);
      const host = url.hostname.toLowerCase();
      return (
        (host === 'auto.danawa.com' || host === 'mauto.danawa.com') &&
        url.pathname.startsWith('/newcar/')
      );
    } catch {
      return false;
    }
  }

  parse(input: VehicleMasterParseInput): VehicleMasterParseResult {
    const text = htmlToVehicleText(input.bytes);
    const lines = vehicleTextLines(text);
    const { maker, model } = parseMakerModel(lines);
    const warnings: string[] = [];
    const records: VehicleMasterParsedTrim[] = [];
    let context: ReturnType<typeof parseContext> = null;

    if (maker === 'UNKNOWN') warnings.push('MAKER_NOT_FOUND');
    if (model === 'UNKNOWN') warnings.push('MODEL_NOT_FOUND');

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const nextContext = parseContext(line);
      if (nextContext) {
        context = nextContext;
        continue;
      }
      if (!context) continue;

      const trim = parseTrim(line);
      if (!trim) continue;
      const priced = nextPrice(lines, index);
      if (!priced) continue;

      records.push({
        maker,
        model,
        modelYear: context.modelYear,
        powertrainName: context.powertrainName,
        seats: null,
        drivetrain: trim.drivetrain,
        trimName: trim.trimName,
        fuelType: normalizeFuel(context.powertrainName),
        basePrice: priced.amount,
        currency: 'KRW',
        effectiveFrom: null,
        baseItems: [],
        baseItemDetails: [],
        options: [],
        sourceText: lines.slice(index, priced.index + 1).join('\n'),
      });
    }

    if (!records.length) warnings.push('NO_TRIM_RECORDS_PARSED');
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

import type { CommercialType, DepositState, Money, PriceTerm } from '../domain/catalog.js';
import type { LegacyProductRaw } from './legacy-freepasserp3.js';

export type LegacyCatalogCandidate = {
  sourceRecordId: string;
  sourceFingerprint: string;
  productCode?: string;
  carNumber?: string;
  maker?: string;
  model?: string;
  subModel?: string;
  trimName?: string;
  commercialType?: CommercialType;
  providerCompanyCode?: string;
  policyCode?: string;
  vehicleStatusRaw?: string;
  year?: string;
  fuelType?: string;
  mileageKm?: number;
  driveType?: string;
  seats?: number;
  origin?: string;
  priceTerms: PriceTerm[];
  issues: string[];
};

const COMMERCIAL_TYPE: Record<string, CommercialType> = {
  '신차렌트': 'NEW_RENT',
  '중고렌트': 'USED_RENT',
  '재렌트': 'USED_RENT',
  '신차구독': 'NEW_SUBSCRIPTION',
  '중고구독': 'USED_SUBSCRIPTION',
  '재구독': 'USED_SUBSCRIPTION',
  '픽업구독': 'PICKUP_SUBSCRIPTION'
};

const text = (value: unknown) => {
  const v = String(value ?? '').trim();
  return v || undefined;
};

const int = (value: unknown) => {
  if (value === '' || value == null) return undefined;
  const n = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

function money(value: unknown): Money | null | undefined {
  if (value === '' || value == null) return undefined;
  const amount = int(value);
  if (amount == null || amount < 0) return null;
  return { amount, currency: 'KRW' };
}

function parsePriceKey(sourceKey: string) {
  const match = sourceKey.trim().match(/^(\d+)(?:_(\d+)만)?$/);
  if (!match?.[1]) return null;
  return {
    termMonths: Number(match[1]),
    ...(match[2] ? { mileageLimitKmPerYear: Number(match[2]) * 10000 } : {})
  };
}

function parseDeposit(raw: unknown): { deposit: Money | null; depositState: DepositState } {
  if (raw === '' || raw == null) return { deposit: null, depositState: 'UNKNOWN' };
  const parsed = money(raw);
  if (!parsed) return { deposit: null, depositState: 'UNKNOWN' };
  if (parsed.amount === 0) return { deposit: parsed, depositState: 'ZERO' };
  return { deposit: parsed, depositState: 'KNOWN' };
}

function parsePriceTerms(price: unknown, issues: string[]): PriceTerm[] {
  if (!price || typeof price !== 'object' || Array.isArray(price)) return [];
  const out: PriceTerm[] = [];

  for (const [sourceKey, rawTerms] of Object.entries(price as Record<string, unknown>)) {
    const key = parsePriceKey(sourceKey);
    if (!key) {
      issues.push(`UNSUPPORTED_PRICE_KEY:${sourceKey}`);
      continue;
    }
    if (!rawTerms || typeof rawTerms !== 'object' || Array.isArray(rawTerms)) {
      issues.push(`INVALID_PRICE_TERMS:${sourceKey}`);
      continue;
    }

    const terms = rawTerms as Record<string, unknown>;
    const monthlyRent = money(terms.rent);
    if (!monthlyRent) {
      issues.push(`MISSING_OR_INVALID_RENT:${sourceKey}`);
      continue;
    }

    const deposit = parseDeposit(terms.deposit);
    out.push({
      termKey: `source:${sourceKey}`,
      termMonths: key.termMonths,
      monthlyRent,
      ...deposit,
      ...('mileageLimitKmPerYear' in key
        ? { mileageLimitKmPerYear: key.mileageLimitKmPerYear }
        : {})
    });
  }

  return out.sort((a, b) =>
    a.termMonths - b.termMonths ||
    (a.mileageLimitKmPerYear ?? 0) - (b.mileageLimitKmPerYear ?? 0)
  );
}

export function normalizeLegacyProduct(raw: LegacyProductRaw): LegacyCatalogCandidate {
  const d = raw.data;
  const issues: string[] = [];
  const productTypeRaw = text(d.product_type);
  const commercialType = productTypeRaw ? COMMERCIAL_TYPE[productTypeRaw] : undefined;
  if (productTypeRaw && !commercialType) issues.push(`UNKNOWN_PRODUCT_TYPE:${productTypeRaw}`);

  const model = text(d.model);
  if (!model) issues.push('MISSING_MODEL');

  const productCode = text(d.product_code);
  const carNumber = text(d.car_number);
  const maker = text(d.maker);
  const subModel = text(d.sub_model);
  const trimName = text(d.trim_name);
  const providerCompanyCode = text(d.provider_company_code);
  const policyCode = text(d.policy_code);
  const vehicleStatusRaw = text(d.vehicle_status);
  const year = text(d.year);
  const fuelType = text(d.fuel_type);
  const mileageKm = int(d.mileage);
  const driveType = text(d.drive_type);
  const seats = int(d.seats);
  const origin = text(d.origin);

  return {
    sourceRecordId: raw.sourceRecordId,
    sourceFingerprint: raw.fingerprint,
    ...(productCode ? { productCode } : {}),
    ...(carNumber ? { carNumber } : {}),
    ...(maker ? { maker } : {}),
    ...(model ? { model } : {}),
    ...(subModel ? { subModel } : {}),
    ...(trimName ? { trimName } : {}),
    ...(commercialType ? { commercialType } : {}),
    ...(providerCompanyCode ? { providerCompanyCode } : {}),
    ...(policyCode ? { policyCode } : {}),
    ...(vehicleStatusRaw ? { vehicleStatusRaw } : {}),
    ...(year ? { year } : {}),
    ...(fuelType ? { fuelType } : {}),
    ...(mileageKm !== undefined ? { mileageKm } : {}),
    ...(driveType ? { driveType } : {}),
    ...(seats !== undefined ? { seats } : {}),
    ...(origin ? { origin } : {}),
    priceTerms: parsePriceTerms(d.price, issues),
    issues
  };
}

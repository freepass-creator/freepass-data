import type { CommissionEvidenceByTerm, CommissionInput } from './kakao-catalog-reference.js';

type Rec = Record<string, unknown>;

export type VehicleValueEvidence = {
  grade: 'CONFIRMED' | 'APPROX';
  source: 'SUPPLIER_RAW' | 'CONSUMER_PRICE' | 'NEW_CAR_TRIM';
  amount: number;
  differenceAmount?: number;
};

export type VehicleValueEvidencePublic = Pick<VehicleValueEvidence, 'grade' | 'source'>;

export type NewCarTrimEvidenceInput = Record<string, Rec> | Rec[] | undefined;

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

function positiveIntegerAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^(?:[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(trimmed)) return null;
  const normalized = trimmed.replace(/,/g, '');
  const amount = Number(normalized);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function rawVehicleValue(product: Rec): number | null {
  const raw = product['원문'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return positiveIntegerAmount((raw as Rec)['차량가격']);
}

function consumerVehicleValue(product: Rec): number | null {
  return positiveIntegerAmount(product.consumer_price);
}

function trimKeyOf(record: Rec): string | null {
  return text(record.trimKey) ?? text(record.trim_key) ?? text(record.new_car_trim_key);
}

function newCarTrimVehicleValue(product: Rec, newCarTrim: NewCarTrimEvidenceInput): number | null {
  if (!newCarTrim) return null;
  const key = trimKeyOf(product);
  if (!key) return null;
  const records = Array.isArray(newCarTrim) ? newCarTrim : Object.values(newCarTrim);
  const matches = records.filter((record): record is Rec => !!record && typeof record === 'object' && !Array.isArray(record) && trimKeyOf(record as Rec) === key);
  if (matches.length !== 1) return null;
  return positiveIntegerAmount(matches[0]!.consumer_price) ?? positiveIntegerAmount(matches[0]!.vehicleValue) ?? positiveIntegerAmount(matches[0]!['차량가격']);
}

export function resolveVehicleValueEvidence(product: Rec, newCarTrim: NewCarTrimEvidenceInput): VehicleValueEvidence | null {
  if (text(product.provider_company_code) !== 'RP012') return null;
  const productType = text(product.product_type)?.replace(/\s+/g, '') ?? '';
  if (productType.includes('픽업구독') || productType.includes('오공구독')) return null;
  const raw = rawVehicleValue(product);
  const consumer = consumerVehicleValue(product);
  if (raw !== null) {
    return {
      grade: 'CONFIRMED',
      source: 'SUPPLIER_RAW',
      amount: raw,
      ...(consumer !== null && consumer !== raw ? { differenceAmount: Math.abs(raw - consumer) } : {}),
    };
  }
  if (consumer !== null) return { grade: 'APPROX', source: 'CONSUMER_PRICE', amount: consumer };
  const trim = newCarTrimVehicleValue(product, newCarTrim);
  return trim !== null ? { grade: 'APPROX', source: 'NEW_CAR_TRIM', amount: trim } : null;
}

export function evidenceByTermForProduct(product: Rec, newCarTrim: NewCarTrimEvidenceInput): {
  evidenceByTerm: CommissionEvidenceByTerm;
  vehicleValueEvidence: VehicleValueEvidence | null;
} {
  const vehicleValueEvidence = resolveVehicleValueEvidence(product, newCarTrim);
  if (!vehicleValueEvidence) return { evidenceByTerm: {}, vehicleValueEvidence: null };
  const price = product.price && typeof product.price === 'object' && !Array.isArray(product.price) ? product.price as Rec : {};
  const evidenceByTerm = Object.fromEntries(Object.keys(price).map(key => [
    key,
    { vehicleValue: vehicleValueEvidence.amount } satisfies Partial<Pick<CommissionInput, 'vehicleValue'>>,
  ])) as CommissionEvidenceByTerm;
  return { evidenceByTerm, vehicleValueEvidence };
}

export function publicVehicleValueEvidence(evidence: VehicleValueEvidence | null): VehicleValueEvidencePublic | null {
  return evidence ? { grade: evidence.grade, source: evidence.source } : null;
}

import type { CatalogCompatibilitySnapshot } from '../infra/erp5-compat-catalog-reader.js';

type Rec = Record<string, unknown>;

export type PublicDepositState = 'AMOUNT' | 'VERIFIED_NO_DEPOSIT' | 'UNKNOWN' | 'NOT_APPLICABLE';

export type PublicProductFeedQuery = {
  p?: string | undefined;
  wl?: string | undefined;
};

export type PublicProductFeed = {
  contractVersion: '1.0';
  count: number;
  products: PublicProduct[];
  brand: string;
};

export type PublicProductQuote = {
  product: PublicProduct;
};

export type PublicProduct = {
  publicProductKey: string;
  _key: string;
  product_code: string;
  car_number: string | null;
  maker: string | null;
  model: string | null;
  sub_model: string | null;
  trim_name: string | null;
  trim_extra: string | null;
  variant: string | null;
  vehicle_class: string | null;
  fuel_type: string | null;
  engine_type: string | null;
  drive_type: string | null;
  transmission: string | null;
  usage: string | null;
  ext_color: string | null;
  int_color: string | null;
  accident_history: string | null;
  cert_car_name: string | null;
  location: string | null;
  provider_name: string | null;
  year: number | null;
  engine_cc: number | null;
  seats: number | null;
  mileage: number | null;
  battery_capacity: number | null;
  annual_mileage: number | null;
  first_registration_date: string | null;
  note: string | null;
  options: string | null;
  deposit_note: string | null;
  product_type: 'NEW_SUBSCRIPTION' | 'USED_SUBSCRIPTION' | 'RENTAL' | 'LEASE' | 'UNKNOWN_PUBLIC_TYPE' | null;
  vehicle_status: 'AVAILABLE' | 'CONSULT_REQUIRED' | 'CONTRACTING' | 'UNAVAILABLE' | 'UNKNOWN' | null;
  insurance_included: boolean | null;
  price: Record<string, { rent: number | null; deposit: number | null; depositState: PublicDepositState }>;
  image_url: string | null;
  image_urls: string[];
  photo_link: string | null;
  _policy: PublicPolicy | null;
};

type PublicPolicy = Record<string, string | number | boolean | null>;

const PUBLIC_TEXT_FIELDS = [
  'car_number', 'maker', 'model', 'sub_model', 'trim_name', 'trim_extra', 'variant',
  'vehicle_class', 'fuel_type', 'engine_type', 'drive_type', 'transmission', 'usage',
  'ext_color', 'int_color', 'accident_history', 'cert_car_name', 'location', 'provider_name',
] as const;

const PUBLIC_LONG_TEXT_FIELDS = ['note', 'options', 'deposit_note'] as const;
const PUBLIC_NUMBER_FIELDS = ['year', 'engine_cc', 'seats', 'mileage', 'battery_capacity', 'annual_mileage'] as const;
const PUBLIC_POLICY_ENUM_FIELDS = [
  'policy_name', 'policy_type', 'payment_method', 'payment_timing', 'penalty_condition',
  'rental_region', 'screening_criteria', 'basic_driver_age', 'driver_age_lowering',
  'driver_age_upper_limit', 'license_period', 'personal_driver_scope', 'business_driver_scope',
  'maintenance_service', 'credit_grade', 'uninsured_damage', 'own_damage_repair_ratio',
  'own_damage_compensation_rate',
] as const;
const PUBLIC_POLICY_BOOLEAN_FIELDS = [
  'insurance_included', 'deposit_installment', 'deposit_card_payment', 'rental_card_payment',
  'roadside_assistance',
] as const;
const PUBLIC_POLICY_NUMBER_FIELDS = [
  'injury_compensation_limit', 'injury_deductible', 'property_compensation_limit',
  'property_deductible', 'self_body_accident', 'self_body_deductible',
  'personal_injury_compensation_limit', 'personal_injury_deductible',
  'uninsured_compensation_limit', 'uninsured_deductible', 'own_damage_compensation',
  'own_damage_min_deductible', 'own_damage_max_deductible', 'annual_roadside_assistance',
  'annual_mileage', 'max_annual_mileage', 'mileage_upcharge_per_10000km', 'age_lowering_cost',
  'additional_driver_allowance_count', 'additional_driver_cost', 'deposit_return_days',
  'buyout_notice_days',
] as const;

const BLOCKED_TEXT = /(수수료|청구|지급|마진|commission|payout|\d[\d,]*(원|만원|%|KRW)|%)/i;
const BLOCKED_PUBLIC_VALUE = /(?:^|[^A-HJ-NPR-Z0-9])[A-HJ-NPR-Z0-9]{17}(?=$|[^A-HJ-NPR-Z0-9])|va_[A-Za-z0-9]{8,}/i;
const CONTROL_OR_PRIVATE = /[\u0000-\u001f\u007f]|<[^>]*>|https?:\/\/|(?:^|\/)(?:products|policy|partner|user)\/|@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|AIza[0-9A-Za-z_-]|ya29\./i;
const PUBLIC_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const PRICE_KEY = /^[0-9]{1,3}(_[A-Za-z0-9가-힣.-]{1,20})?$/;
const DATE = /^\d{4}-\d{2}(?:-\d{2})?$/;

const cleanText = (value: unknown, maxLength: number, field: string): string | null => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error(`PUBLIC_FIELD_INVALID:${field}`);
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > maxLength || BLOCKED_TEXT.test(text) || BLOCKED_PUBLIC_VALUE.test(text) || CONTROL_OR_PRIVATE.test(text)) {
    throw new Error(`PUBLIC_FIELD_FORBIDDEN:${field}`);
  }
  return text;
};

const cleanKey = (value: unknown): string => {
  const key = cleanText(value, 80, 'publicProductKey');
  if (!key || !PUBLIC_KEY.test(key) || key.startsWith('va_')) throw new Error('PUBLIC_KEY_INVALID');
  return key;
};

const cleanNumber = (value: unknown, field: string): number | null => {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`PUBLIC_NUMBER_INVALID:${field}`);
  return Math.round(value * 10) / 10;
};

const cleanBoolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;

const cleanUrl = (value: unknown): string | null => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('PUBLIC_URL_INVALID');
  const text = value.trim();
  if (!/^https:\/\/[^\s]{1,492}$/.test(text)) throw new Error('PUBLIC_URL_INVALID');
  if (BLOCKED_PUBLIC_VALUE.test(text)) throw new Error('PUBLIC_URL_FORBIDDEN');
  return text;
};

const normalizeProductType = (value: unknown): PublicProduct['product_type'] => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (['NEW_SUBSCRIPTION', 'USED_SUBSCRIPTION', 'RENTAL', 'LEASE'].includes(text)) return text as PublicProduct['product_type'];
  if (text.includes('신차') || text.includes('픽업')) return 'NEW_SUBSCRIPTION';
  if (text.includes('중고')) return 'USED_SUBSCRIPTION';
  if (text.includes('렌트')) return 'RENTAL';
  if (text.includes('리스')) return 'LEASE';
  return text ? 'UNKNOWN_PUBLIC_TYPE' : null;
};

const normalizeVehicleStatus = (value: unknown): PublicProduct['vehicle_status'] => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (['AVAILABLE', 'CONSULT_REQUIRED', 'CONTRACTING', 'UNAVAILABLE', 'UNKNOWN'].includes(text)) return text as PublicProduct['vehicle_status'];
  if (['가용', '출고가능', '가능'].includes(text)) return 'AVAILABLE';
  if (['선점', '계약중'].includes(text)) return 'CONTRACTING';
  if (['출고협의', '협의'].includes(text)) return 'CONSULT_REQUIRED';
  if (['출고불가', '불가'].includes(text)) return 'UNAVAILABLE';
  return text ? 'UNKNOWN' : null;
};

const normalizeDepositState = (value: unknown): PublicDepositState => {
  if (value === 'AMOUNT' || value === 'KNOWN') return 'AMOUNT';
  if (value === 'VERIFIED_NO_DEPOSIT' || value === 'ZERO') return 'VERIFIED_NO_DEPOSIT';
  if (value === 'NOT_APPLICABLE') return 'NOT_APPLICABLE';
  return 'UNKNOWN';
};

const cleanImages = (product: Rec): string[] => {
  const raw = [
    ...(Array.isArray(product.image_urls) ? product.image_urls : []),
    ...(Array.isArray(product.images) ? product.images : []),
    ...(Array.isArray(product.photos) ? product.photos : []),
    ...(Array.isArray(product.photo_cache) ? product.photo_cache : []),
    product.image_url,
    product.photo_link,
  ];
  const urls: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!/^https:\/\/[^\s]{1,492}$/.test(text)) continue;
    if (BLOCKED_PUBLIC_VALUE.test(text)) throw new Error('PUBLIC_URL_FORBIDDEN');
    if (!urls.includes(text)) urls.push(text);
    if (urls.length >= 20) break;
  }
  return urls;
};

const publicPrice = (product: Rec): PublicProduct['price'] => {
  if (!product.price || typeof product.price !== 'object' || Array.isArray(product.price)) return {};
  const result: PublicProduct['price'] = {};
  for (const [key, value] of Object.entries(product.price as Rec)) {
    if (!PRICE_KEY.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Rec;
    const rent = cleanNumber(row.rent, `price.${key}.rent`);
    const depositState = normalizeDepositState(row.depositState);
    const deposit = cleanNumber(row.deposit, `price.${key}.deposit`);
    result[key] = {
      rent,
      deposit: depositState === 'UNKNOWN' || depositState === 'NOT_APPLICABLE' ? null : deposit,
      depositState,
    };
  }
  return result;
};

const publicPolicy = (policy: Rec | undefined): PublicPolicy | null => {
  if (!policy) return null;
  const result: PublicPolicy = {};
  for (const field of PUBLIC_POLICY_ENUM_FIELDS) {
    result[field] = cleanText(policy[field], 80, `_policy.${field}`);
  }
  for (const field of PUBLIC_POLICY_BOOLEAN_FIELDS) {
    result[field] = cleanBoolean(policy[field]);
  }
  for (const field of PUBLIC_POLICY_NUMBER_FIELDS) {
    result[field] = cleanNumber(policy[field], `_policy.${field}`);
  }
  return result;
};

const channelMatches = (product: Rec, wl: string | undefined): boolean => {
  if (!wl) return true;
  const normalized = wl.toLowerCase();
  const candidates = [product.wl, product.whitelabel, product.channel, product.public_channel];
  const arrays = [product.wls, product.whitelabels, product.channels, product.public_channels];
  if (candidates.some((value) => typeof value === 'string' && value.toLowerCase() === normalized)) return true;
  if (arrays.some((value) => Array.isArray(value) && value.some((item) => typeof item === 'string' && item.toLowerCase() === normalized))) return true;
  return !candidates.some(Boolean) && !arrays.some((value) => Array.isArray(value) && value.length);
};

const providerMatches = (product: Rec, provider: string | undefined): boolean => {
  if (!provider) return true;
  return [product.provider_company_code, product.partner_code].some((value) => typeof value === 'string' && value === provider);
};

const buildPublicProduct = (product: Rec, policies: Record<string, Rec>, listMode: boolean): PublicProduct => {
  const key = cleanKey(product.publicProductKey ?? product.product_code ?? product._key);
  const policyId = typeof product.policy_id === 'string' ? product.policy_id : typeof product.policy_code === 'string' ? product.policy_code : undefined;
  const images = cleanImages(product);
  const result: PublicProduct = {
    publicProductKey: key,
    _key: cleanKey(product._key ?? key),
    product_code: cleanKey(product.product_code ?? key),
    car_number: null,
    maker: null,
    model: null,
    sub_model: null,
    trim_name: null,
    trim_extra: null,
    variant: null,
    vehicle_class: null,
    fuel_type: null,
    engine_type: null,
    drive_type: null,
    transmission: null,
    usage: null,
    ext_color: null,
    int_color: null,
    accident_history: null,
    cert_car_name: null,
    location: null,
    provider_name: null,
    year: null,
    engine_cc: null,
    seats: null,
    mileage: null,
    battery_capacity: null,
    annual_mileage: null,
    first_registration_date: null,
    note: null,
    options: null,
    deposit_note: null,
    product_type: normalizeProductType(product.product_type),
    vehicle_status: normalizeVehicleStatus(product.vehicle_status ?? product.status_kind),
    insurance_included: cleanBoolean(product.insurance_included),
    price: publicPrice(product),
    image_url: images[0] ?? null,
    image_urls: listMode ? [] : images,
    photo_link: cleanUrl(product.photo_link),
    _policy: publicPolicy(policyId ? policies[policyId] : undefined),
  };
  for (const field of PUBLIC_TEXT_FIELDS) {
    result[field] = cleanText(product[field], 80, field);
  }
  for (const field of PUBLIC_LONG_TEXT_FIELDS) {
    result[field] = cleanText(product[field], 300, field);
  }
  for (const field of PUBLIC_NUMBER_FIELDS) {
    result[field] = cleanNumber(product[field], field);
  }
  const registration = cleanText(product.first_registration_date, 10, 'first_registration_date');
  result.first_registration_date = registration && DATE.test(registration) ? registration : null;
  assertNoForbiddenValue(result);
  return result;
};

const assertNoForbiddenValue = (value: unknown): void => {
  if (typeof value === 'string') {
    if (BLOCKED_TEXT.test(value) || BLOCKED_PUBLIC_VALUE.test(value)) throw new Error('PUBLIC_FORBIDDEN_TEXT');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenValue(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Rec)) {
      if (/vin|fee|commission|payout|billing|margin|source|sheet|raw|provenance|audit|collection/i.test(key)) {
        throw new Error(`PUBLIC_FORBIDDEN_FIELD:${key}`);
      }
      assertNoForbiddenValue(item);
    }
  }
};

const productsFromSnapshot = (snapshot: CatalogCompatibilitySnapshot, query: PublicProductFeedQuery, listMode: boolean): PublicProduct[] =>
  Object.values(snapshot.data.products)
    .filter((product) => product.listable !== false && providerMatches(product, query.p) && channelMatches(product, query.wl))
    .map((product) => buildPublicProduct(product, snapshot.data.policies, listMode));

export const publicConsumerIdFromWhitelabel = (wl: unknown): string => {
  if (typeof wl !== 'string' || !wl.trim()) return 'erp-com';
  const key = wl.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) throw new Error('PUBLIC_WL_INVALID');
  return `whitelabel-${key}`;
};

export const buildPublicProductFeed = (snapshot: CatalogCompatibilitySnapshot, query: PublicProductFeedQuery): PublicProductFeed => {
  const products = productsFromSnapshot(snapshot, query, true);
  const brand = cleanText(query.p, 80, 'brand') ?? '';
  return { contractVersion: '1.0', count: products.length, products, brand };
};

export const buildPublicProductQuote = (snapshot: CatalogCompatibilitySnapshot, code: unknown, query: PublicProductFeedQuery): PublicProductQuote | null => {
  const target = cleanText(code, 120, 'code');
  if (!target) throw new Error('PUBLIC_QUOTE_CODE_REQUIRED');
  const product = productsFromSnapshot(snapshot, query, false).find((item) =>
    item.publicProductKey === target || item.product_code === target || item._key === target || target.startsWith(`${item.product_code}-`)
  );
  return product ? { product } : null;
};

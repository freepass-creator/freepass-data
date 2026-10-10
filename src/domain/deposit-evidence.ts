/** Deposit evidence, not a pricing engine. A numeric placeholder is never proof of waiver. */
export function assessDepositEvidence(input: {
  supplierId?: unknown;
  productType?: unknown;
  note?: unknown;
  depositFree?: unknown;
  depositFreeConfirmation?: unknown;
  depositSourceWaiverBasis?: unknown;
  depositSourceWaiverText?: unknown;
  sourceAmount: unknown;
  hasPositivePaidDeposit?: boolean;
}) {
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  const raw = input.sourceAmount;
  const amount = typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(raw)
      ? Number(raw.replaceAll(',', '')) : NaN;
  const valid = Number.isSafeInteger(amount) && amount >= 0;
  const supplierId = typeof input.supplierId === 'string' ? input.supplierId.trim() : '';
  const productType = typeof input.productType === 'string' ? input.productType.replace(/\s+/g, '') : '';
  const forbidden = productType === '픽업구독' || supplierId === 'RP012';
  const depositFreeFlag = input.depositFree === true || input.depositFree === '예';
  const depositFreeNegativeFlag = input.depositFree === false || input.depositFree === '아니오' || input.depositFree === '아님' || input.depositFree === '불가';
  const sourceWaiverBasis = isValidDepositSourceWaiverBasis(input.depositSourceWaiverBasis) ? input.depositSourceWaiverBasis : null;
  const sourceWaiverText = depositText(input.depositSourceWaiverText);
  const confirmationWaiverBasis = depositFreeConfirmationBasis(input.depositFreeConfirmation);
  const noteWaiverBasis = note === '무보증' ? { field: 'deposit_note' as const, text: '무보증' as const } : null;
  const zeroBasis = sourceWaiverBasis ?? noteWaiverBasis ?? confirmationWaiverBasis;
  const explicitZero = !!zeroBasis;
  const unknown = (reason: string) => ({ state: 'UNKNOWN' as const, amount: null, reason });
  const missing = raw === undefined || raw === null || raw === '';
  if (explicitZero && depositFreeNegativeFlag) {
    return unknown('CONFLICTING_ZERO_DEPOSIT_EVIDENCE');
  }
  if (noteWaiverBasis && sourceWaiverText && sourceWaiverText !== '무보증') {
    return unknown('CONFLICTING_ZERO_DEPOSIT_EVIDENCE');
  }
  if (explicitZero && (!supplierId || !productType || (!missing && !valid))) {
    return unknown('INVALID_OR_INCOMPLETE_ZERO_DEPOSIT_EVIDENCE');
  }
  if (explicitZero && (forbidden || (valid && amount > 0) || input.hasPositivePaidDeposit || (note && note !== '무보증'))) {
    return unknown('CONFLICTING_ZERO_DEPOSIT_EVIDENCE');
  }
  if ((depositFreeFlag || note === '무보증' || input.depositFreeConfirmation !== undefined) && !explicitZero && (missing || (valid && amount === 0))) {
    return unknown('DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE');
  }
  if (!missing && !valid) return unknown('INVALID_DEPOSIT_AMOUNT');
  if (valid && amount > 0) {
    // RP012 used rentals carry authoritative per-term ERP amounts, not the subscription formula.
    const sourceAmountAuthoritative = supplierId === 'RP012' && ['중고렌트', '재렌트'].includes(productType);
    if (note && !sourceAmountAuthoritative) return unknown('POSITIVE_AMOUNT_WITH_RULE_REQUIRES_REVIEW');
    return { state: 'KNOWN' as const, amount, reason: 'SOURCE_AMOUNT' };
  }
  if (forbidden) return unknown('ZERO_DEPOSIT_FORBIDDEN_BY_PRODUCT_POLICY');
  if (missing) return unknown('MISSING_DEPOSIT_AMOUNT');
  if (explicitZero) return { state: 'ZERO' as const, amount: 0, reason: 'EXPLICIT_ZERO_DEPOSIT', basis: zeroBasis };
  return unknown('DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE');
}

export type DepositEvidenceBasis = { field: 'deposit_note' | '원문.전체.장기보증' | '원문.전체.단기보증' | 'deposit_free_confirmation'; text: '무보증'; source?: string; at?: string };
export const DEPOSIT_SOURCE_WAIVER_FIELDS = ['원문.전체.장기보증', '원문.전체.단기보증'] as const;
export type DepositFreeConfirmation = { source?: unknown; at?: unknown; text?: unknown };

export function depositSourceWaiverFieldForTermMonths(termMonths: unknown): typeof DEPOSIT_SOURCE_WAIVER_FIELDS[number] | undefined {
  return Number.isSafeInteger(termMonths) && (termMonths as number) > 0
    ? (termMonths as number) <= 12 ? DEPOSIT_SOURCE_WAIVER_FIELDS[1] : DEPOSIT_SOURCE_WAIVER_FIELDS[0]
    : undefined;
}

function isValidDepositSourceWaiverBasis(value: unknown): value is DepositEvidenceBasis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as DepositEvidenceBasis;
  return (record.field === '원문.전체.장기보증' || record.field === '원문.전체.단기보증') && record.text === '무보증';
}

function depositFreeConfirmationBasis(value: unknown): DepositEvidenceBasis | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as DepositFreeConfirmation;
  return typeof record.source === 'string' && record.source.trim().length > 0
    && record.text === '무보증'
    && depositInstant(record.at)
    ? { field: 'deposit_free_confirmation', text: '무보증', source: record.source.trim(), at: record.at }
    : null;
}

function readProductPath(product: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, product);
}

function sourceWaiverTextFromProduct(product: Record<string, unknown>, termMonths: unknown): { field?: typeof DEPOSIT_SOURCE_WAIVER_FIELDS[number]; text: string } {
  const field = depositSourceWaiverFieldForTermMonths(termMonths);
  return field ? { field, text: depositText(readProductPath(product, field)) } : { text: '' };
}

function sourceWaiverBasisFromProduct(product: Record<string, unknown>, termMonths: unknown): DepositEvidenceBasis | undefined {
  const source = sourceWaiverTextFromProduct(product, termMonths);
  return source.field && source.text === '무보증' ? { field: source.field, text: '무보증' } : undefined;
}

export function depositEvidenceInputFromProduct(
  product: Record<string, unknown>,
  sourceAmount: unknown,
  extra: {
    termMonths?: unknown;
    monthlyRent?: unknown;
    hasPositivePaidDeposit?: boolean;
    ruleScope?: 'ANY' | 'RP012_SUBSCRIPTION_EXACT_ZERO_YEARS_RULE';
  } = {},
) {
  return {
    supplierId: product.provider_company_code,
    productType: product.product_type,
    note: product.deposit_note,
    depositFree: product.deposit_free,
    depositFreeConfirmation: product.deposit_free_confirmation,
    depositSourceWaiverBasis: sourceWaiverBasisFromProduct(product, extra.termMonths),
    depositSourceWaiverText: sourceWaiverTextFromProduct(product, extra.termMonths).text,
    sourceAmount,
    ...extra,
  };
}

/**
 * Supplier note rule «월 대여료 × 약정연수 (최대 3개월)» (RP012 subscriptions: 12개월 = 1개월분, 24개월 = 2개월분, 36개월 이상 = 3개월분).
 * The stored placeholder deposit (0) is not a waiver; the amount is derived from the supplier's own rule note at read time —
 * nothing is written back (source stays untouched). Returns null unless the note is exactly that rule and the term is whole years.
 */
export type Erp5CompatibilityPriceKey = {
  months: number;
  mileageKm?: number;
  contractedMileage?: { km: number; period: 'month' | 'year' };
  settlement: 'RETURN' | 'BUYOUT';
};

export function normalizeErp5CompatibilityInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) return undefined;
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * 가격 키를 읽는다. `36` · `36_2만` · `36_인수형` · `12_월30000km` 꼴을 지원한다.
 * Domain pure helper so infra/application/adapters can share the same months parsing without layer inversion.
 */
export function parseErp5CompatibilityPriceKey(key: string): Erp5CompatibilityPriceKey | undefined {
  const explicit = /^([1-9]\d*)_(월|연)([1-9]\d*)km$/.exec(key);
  if (explicit) {
    const months = Number(explicit[1]), km = Number(explicit[3]);
    if (!Number.isSafeInteger(months) || months > 60 || !Number.isSafeInteger(km)) return undefined;
    const period = explicit[2] === '월' ? 'month' as const : 'year' as const;
    return { months, settlement: 'RETURN', contractedMileage: { km, period }, ...(period === 'year' ? { mileageKm: km } : {}) };
  }
  const buyout = /^([1-9]\d*)_인수형$/.exec(key);
  if (buyout) return { months: Number(buyout[1]), settlement: 'BUYOUT' };
  const parsed = /^([1-9]\d*)(?:_([1-9]\d*)만)?$/.exec(key);
  if (!parsed) return undefined;
  const months = Number(parsed[1]);
  if (!Number.isSafeInteger(months) || months <= 0) return undefined;
  if (!parsed[2]) return { months, settlement: 'RETURN' };
  const km = Number(parsed[2]) * 10000;
  return Number.isSafeInteger(km) ? { months, mileageKm: km, settlement: 'RETURN' } : undefined;
}

export type DepositRuleResolution =
  | { state: 'KNOWN'; amount: number; code: string; multiplier: number; label: string }
  | { state: 'UNKNOWN'; reason: 'NO_RULE' | 'MISSING' | 'CONFLICT' | 'TERM_NOT_COVERED_BY_RULE' };

export type DepositRuleCode =
  | 'RENT_X_CONTRACT_YEARS_MAX3'
  | 'RENT_X_2'
  | 'IMPORT_12_X3_18_PLUS_X6';

export const normalizeDepositSupplierId = (value: unknown) =>
  typeof value === 'string' ? value.trim() : '';

export const normalizeDepositProductType = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\s+/g, '') : '';

export function resolveDepositByRuleNote(input: {
  note: unknown;
  termMonths: unknown;
  monthlyRent: unknown;
}): DepositRuleResolution {
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  const known = (code: string, multiplier: number, label = `대여료×${multiplier}`): DepositRuleResolution => {
    if (!Number.isSafeInteger(input.monthlyRent) || (input.monthlyRent as number) <= 0) return { state: 'UNKNOWN', reason: 'MISSING' };
    const amount = (input.monthlyRent as number) * multiplier;
    return Number.isSafeInteger(amount) && amount > 0
      ? { state: 'KNOWN', amount, code, multiplier, label }
      : { state: 'UNKNOWN', reason: 'CONFLICT' };
  };
  if (/^월 대여료 × 약정연수 \(최대 3개월\)$/.test(note)) {
    if (!Number.isSafeInteger(input.termMonths) || (input.termMonths as number) <= 0 || (input.termMonths as number) % 12 !== 0) {
      return { state: 'UNKNOWN', reason: 'MISSING' };
    }
    return known('RENT_X_CONTRACT_YEARS_MAX3', Math.min((input.termMonths as number) / 12, 3));
  }
  if (/^국산:\s*월 대여료×2$/.test(note)) return known('RENT_X_2', 2);
  if (/^수입:\s*12개월 대여료×3 · 18개월↑ ×6$/.test(note)) {
    if (!Number.isSafeInteger(input.termMonths) || (input.termMonths as number) <= 0) return { state: 'UNKNOWN', reason: 'MISSING' };
    if (input.termMonths === 12) return known('IMPORT_12_X3_18_PLUS_X6', 3);
    if ((input.termMonths as number) >= 18) return known('IMPORT_12_X3_18_PLUS_X6', 6);
    return { state: 'UNKNOWN', reason: 'TERM_NOT_COVERED_BY_RULE' };
  }
  return { state: 'UNKNOWN', reason: 'NO_RULE' };
}

export type DepositWithRuleResolution =
  | { state: 'KNOWN'; amount: number; reason: 'SOURCE_AMOUNT' | `SUPPLIER_RULE_NOTE:${DepositRuleCode}`; rule: null | { code: DepositRuleCode | 'SOURCE_AMOUNT'; multiplier: number | null; label: string } }
  | { state: 'ZERO'; amount: 0; reason: 'EXPLICIT_ZERO_DEPOSIT'; depositEvidenceBasis: DepositEvidenceBasis; rule: { code: 'ZERO_DEPOSIT'; multiplier: 0; label: string; depositEvidenceBasis: DepositEvidenceBasis } }
  | { state: 'UNKNOWN'; amount: null; reason: string; rule: null };

export function resolveDepositWithRuleNote(input: {
  supplierId?: unknown;
  productType?: unknown;
  note?: unknown;
  termMonths?: unknown;
  monthlyRent?: unknown;
  sourceAmount: unknown;
  depositFree?: unknown;
  depositFreeConfirmation?: unknown;
  depositSourceWaiverBasis?: unknown;
  hasPositivePaidDeposit?: boolean;
  /** 규칙을 거는 범위. 기본 ANY(호환 응답·안내). 표준화 매핑은 기존 정책 그대로 «RP012 구독의 원문 정확히 0 + 연수 규칙»만(근거가 약한 확대 금지). */
  ruleScope?: 'ANY' | 'RP012_SUBSCRIPTION_EXACT_ZERO_YEARS_RULE';
}): DepositWithRuleResolution {
  const evidence = assessDepositEvidence(input);
  const sourceAmountRule = { code: 'SOURCE_AMOUNT' as const, multiplier: null, label: '공급사 입력 금액' };
  if (evidence.state === 'KNOWN') return { state: 'KNOWN', amount: evidence.amount, reason: 'SOURCE_AMOUNT', rule: sourceAmountRule };
  if (evidence.state === 'ZERO') return {
    state: 'ZERO',
    amount: 0,
    reason: 'EXPLICIT_ZERO_DEPOSIT',
    depositEvidenceBasis: evidence.basis,
    rule: { code: 'ZERO_DEPOSIT', multiplier: 0, label: '무보증', depositEvidenceBasis: evidence.basis },
  };

  const supplierId = normalizeDepositSupplierId(input.supplierId);
  const productType = normalizeDepositProductType(input.productType);
  const missing = input.sourceAmount === undefined || input.sourceAmount === null || input.sourceAmount === '';
  const ruleCandidateDeposit = input.sourceAmount === 0 || input.sourceAmount === '0' || missing;
  const rp012UsedRent = supplierId === 'RP012' && ['중고렌트', '재렌트'].includes(productType);
  const ruleAllowedReason = ['ZERO_DEPOSIT_FORBIDDEN_BY_PRODUCT_POLICY', 'DEPOSIT_RULE_REQUIRES_RESOLUTION', 'MISSING_DEPOSIT_AMOUNT', 'DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE'].includes(evidence.reason);
  const narrow = input.ruleScope === 'RP012_SUBSCRIPTION_EXACT_ZERO_YEARS_RULE';
  const scopeOk = !narrow || (supplierId === 'RP012' && /구독/.test(productType) && (input.sourceAmount === 0 || input.sourceAmount === '0'));
  if (supplierId !== 'RP031' && !rp012UsedRent && ruleCandidateDeposit && ruleAllowedReason && scopeOk) {
    const found = resolveDepositByRuleNote({ note: input.note, termMonths: input.termMonths, monthlyRent: input.monthlyRent });
    const rule: DepositRuleResolution = narrow && found.state === 'KNOWN' && found.code !== 'RENT_X_CONTRACT_YEARS_MAX3' ? { state: 'UNKNOWN', reason: 'NO_RULE' } : found;
    if (rule.state === 'KNOWN') {
      return {
        state: 'KNOWN',
        amount: rule.amount,
        reason: `SUPPLIER_RULE_NOTE:${rule.code as DepositRuleCode}` as const,
        rule: { code: rule.code as DepositRuleCode, multiplier: rule.multiplier, label: rule.label },
      };
    }
    if (rule.reason !== 'NO_RULE') return { state: 'UNKNOWN', amount: null, reason: rule.reason, rule: null };
  }
  return { state: 'UNKNOWN', amount: null, reason: evidence.reason, rule: null };
}

export function depositFromYearsRuleNote(note: unknown, termMonths: unknown, monthlyRent: unknown): { amount: number; multiplier: number } | null {
  const resolved = resolveDepositByRuleNote({ note, termMonths, monthlyRent });
  return resolved.state === 'KNOWN' && resolved.code === 'RENT_X_CONTRACT_YEARS_MAX3'
    ? { amount: resolved.amount, multiplier: resolved.multiplier }
    : null;
}

export function hasConflictingPaidDeposit(price: unknown) {
  if (!price || typeof price !== 'object' || Array.isArray(price)) return false;
  return Object.values(price as Record<string, unknown>).some(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    // A product-wide waiver cannot erase a positive/invalid sibling just because rent is missing.
    const deposit = row.deposit;
    return deposit !== undefined && deposit !== null && deposit !== '' && deposit !== 0 && deposit !== '0';
  });
}

/** Full input universe including inactive products. Details stay in private evidence, not public API. */
export function depositStatusLabel(state: 'KNOWN' | 'ZERO' | 'UNKNOWN', _sourceAmount: unknown, _note?: unknown) {
  if (state === 'ZERO') return '무보증' as const;
  if (state === 'KNOWN') return '보증금 있음' as const;
  return '미확인' as const;
}

export function auditDepositEvidence(products: Record<string, Record<string, unknown>>) {
  const findings: Array<{ productId: string; listable: boolean; supplierId: string; productType: string; termKey: string; state: 'KNOWN' | 'ZERO' | 'UNKNOWN'; reason: string; sourceAmount: unknown; proposedAmount: number | null; depositStatusLabel: ReturnType<typeof depositStatusLabel> }> = [];
  const positive = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0;
  for (const [productId, product] of Object.entries(products)) {
    const prices = product.price && typeof product.price === 'object' && !Array.isArray(product.price)
      ? Object.entries(product.price as Record<string, unknown>) : [];
    const paid = prices.filter(([, row]) => row && typeof row === 'object' && positive((row as Record<string, unknown>).rent));
    const hasPositivePaidDeposit = hasConflictingPaidDeposit(product.price);
    for (const [termKey, value] of paid) {
      const row = value as Record<string, unknown>;
      const parsed = parseErp5CompatibilityPriceKey(termKey);
      const result = assessDepositEvidence(depositEvidenceInputFromProduct(product, row.deposit, { termMonths: parsed?.months, hasPositivePaidDeposit }));
      findings.push({ productId, listable: product.listable === true, supplierId: String(product.provider_company_code ?? ''),
        productType: String(product.product_type ?? ''), termKey, state: result.state, reason: result.reason,
        sourceAmount: row.deposit ?? null, proposedAmount: result.amount,
        depositStatusLabel: depositStatusLabel(result.state, row.deposit, product.deposit_note) });
    }
  }
  const counts = { KNOWN: 0, ZERO: 0, UNKNOWN: 0 };
  for (const row of findings) counts[row.state]++;
  const unresolvedAllZeroProducts = Object.entries(products).filter(([id]) => {
    const rows = findings.filter(row => row.productId === id);
    return rows.length > 0 && rows.every(row => row.sourceAmount === 0 || row.sourceAmount === '0') && rows.some(row => row.state === 'UNKNOWN');
  }).map(([productId, product]) => ({ productId, listable: product.listable === true }));
  const labelCounts: Record<string, number> = {};
  for (const row of findings) labelCounts[row.depositStatusLabel] = (labelCounts[row.depositStatusLabel] ?? 0) + 1;
  return { productCount: Object.keys(products).length, paidTermCount: findings.length, counts,
    unknownProductCount: new Set(findings.filter(row => row.state === 'UNKNOWN').map(row => row.productId)).size,
    unresolvedAllZeroProductCount: unresolvedAllZeroProducts.length,
    visibleUnresolvedAllZeroProductCount: unresolvedAllZeroProducts.filter(row => row.listable).length,
    labelCounts,
    findings, writeAuthorized: false as const };
}

// Shared with the existing approved supplier adapter; keep its 15-minute policy unchanged.
export const IANCAR_PUBLISHED_DEPOSIT_FRESHNESS_SECONDS = 15 * 60;
const depositRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const depositInteger = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const depositText = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const depositInstant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));

/** Reuses the approved publication's typed provenance; does not re-hash the private RAW envelope. */
export function readIancarPublishedDeposit(product: Record<string, unknown>, priceKey: string, now = new Date().toISOString()) {
  const unknown = () => ({ state: 'UNKNOWN' as const, amount: null, reason: 'IANCAR_PUBLISHED_DEPOSIT_EVIDENCE_UNVERIFIED' });
  const e = product.iancar_phase_one;
  if (product.provider_company_code !== 'RP031' || product.source !== 'EANCAR_ONE_API'
    || product.source_schema !== 'iancar-one-phase-one-product/1' || !depositRecord(e)
    || e.stage !== 'PHASE_ONE' || e.publicationPlane !== 'ERP5_COMPATIBILITY_BRIDGE'
    || !depositText(product.iancar_one_vehicle_id) || e.sourceVehicleId !== product.iancar_one_vehicle_id
    || !/^\d{2,3}[가-힣]\d{4}$/.test(depositText(product.car_number).replace(/\s/g, ''))
    || product._deleted || product.deletedAt || product.publication_withdrawal
    || !/^[a-f0-9]{64}$/.test(String(e.sourceDigest)) || !/^[a-f0-9]{64}$/.test(String(e.ratesDigest))
    || !depositInstant(now) || !depositInstant(e.sourceSyncedAt)
    || product._direct_ingest_at !== Date.parse(e.sourceSyncedAt)
    || Date.parse(now) - Date.parse(e.sourceSyncedAt) > IANCAR_PUBLISHED_DEPOSIT_FRESHNESS_SECONDS * 1000
    || Date.parse(e.sourceSyncedAt) - Date.parse(now) > 60_000
    || !Array.isArray(e.terms) || !e.terms.length || !depositRecord(e.priceAliases) || !depositRecord(product.price)) return unknown();
  const terms = e.terms;
  for (const t of terms) {
    if (!depositRecord(t) || !depositInteger(t.termMonths) || t.termMonths < 1 || t.termMonths > 60
      || !depositRecord(t.contractedMileage) || !depositInteger(t.contractedMileage.km) || t.contractedMileage.km < 1
      || !['month', 'year'].includes(String(t.contractedMileage.period))
      || !depositRecord(t.monthlyRent) || t.monthlyRent.currency !== 'KRW' || !depositInteger(t.monthlyRent.amount)
      || t.monthlyRent.amount < 100_000 || t.monthlyRent.amount > 20_000_000 || t.vatIncluded !== true
      || !depositRecord(t.deposit) || t.deposit.currency !== 'KRW' || !depositInteger(t.deposit.amount) || t.deposit.amount < 0
      || t.depositState !== (t.deposit.amount === 0 ? 'ZERO' : 'KNOWN')
      || t.key !== `${t.termMonths}:${t.contractedMileage.km}:${t.contractedMileage.period}`
      || t.compatibilityPriceKey !== `${t.termMonths}_${t.contractedMileage.period === 'month' ? '월' : '연'}${t.contractedMileage.km}km`) return unknown();
  }
  if (new Set(terms.map(t => (t as Record<string, unknown>).key)).size !== terms.length) return unknown();
  const matching = terms.filter(t => depositRecord(t) && t.compatibilityPriceKey === priceKey);
  let term = matching.length === 1 ? matching[0] as Record<string, unknown> : undefined;
  if (!term && /^\d+$/.test(priceKey)) {
    const scoped = terms.filter(t => depositRecord(t) && t.termMonths === Number(priceKey)) as Record<string, unknown>[];
    if (!scoped.length || new Set(scoped.map(t => (t.contractedMileage as Record<string, unknown>).period)).size !== 1) return unknown();
    const lowest = scoped.reduce((a, b) => Number((a.contractedMileage as Record<string, unknown>).km) < Number((b.contractedMileage as Record<string, unknown>).km) ? a : b);
    if (e.priceAliases[priceKey] !== lowest.key) return unknown();
    term = lowest;
  }
  const row = product.price[priceKey];
  if (!term || !depositRecord(row) || !depositRecord(term.deposit) || !depositRecord(term.monthlyRent)
    || row.deposit !== term.deposit.amount || row.rent !== term.monthlyRent.amount) return unknown();
  const direct = product.price[String(term.compatibilityPriceKey)];
  if (!depositRecord(direct) || direct.rent !== row.rent || direct.deposit !== row.deposit) return unknown();
  if (term.deposit.amount === 0 && (depositText(product.product_type).replace(/\s/g, '') === '픽업구독'
    || [false, '아니오', '아님', '불가'].some(value => product.deposit_free === value)
    || (depositText(product.deposit_note) && !['무보증', '기간·주행거리별 보증금 상이: 상품 요금 조건 확인'].includes(depositText(product.deposit_note))))) return unknown();
  return { state: term.depositState as 'ZERO' | 'KNOWN', amount: term.deposit.amount as number,
    reason: 'IANCAR_PUBLISHED_CONDITION_EVIDENCE' };
}

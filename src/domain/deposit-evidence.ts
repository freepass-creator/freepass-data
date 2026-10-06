/** Deposit evidence, not a pricing engine. A numeric placeholder is never proof of waiver. */
export function assessDepositEvidence(input: {
  supplierId?: unknown;
  productType?: unknown;
  note?: unknown;
  depositFree?: unknown;
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
  const explicitZero = note === '무보증' || input.depositFree === true || input.depositFree === '예';
  const unknown = (reason: string) => ({ state: 'UNKNOWN' as const, amount: null, reason });
  const missing = raw === undefined || raw === null || raw === '';
  if (note === '무보증' && (input.depositFree === false || input.depositFree === '아니오' || input.depositFree === '아님' || input.depositFree === '불가')) {
    return unknown('CONFLICTING_ZERO_DEPOSIT_EVIDENCE');
  }
  if (explicitZero && (!supplierId || !productType || (!missing && !valid))) {
    return unknown('INVALID_OR_INCOMPLETE_ZERO_DEPOSIT_EVIDENCE');
  }
  if (explicitZero && (forbidden || (valid && amount > 0) || input.hasPositivePaidDeposit || (note && note !== '무보증'))) {
    return unknown('CONFLICTING_ZERO_DEPOSIT_EVIDENCE');
  }
  if (!missing && !valid) return unknown('INVALID_DEPOSIT_AMOUNT');
  if (valid && amount > 0) {
    // RP012 used rentals carry authoritative per-term ERP amounts, not the subscription formula.
    const sourceAmountAuthoritative = supplierId === 'RP012' && ['중고렌트', '재렌트'].includes(productType);
    if (note && !sourceAmountAuthoritative) return unknown('POSITIVE_AMOUNT_WITH_RULE_REQUIRES_REVIEW');
    return { state: 'KNOWN' as const, amount, reason: 'SOURCE_AMOUNT' };
  }
  if (forbidden) return unknown('ZERO_DEPOSIT_FORBIDDEN_BY_PRODUCT_POLICY');
  if (explicitZero) return { state: 'ZERO' as const, amount: 0, reason: 'EXPLICIT_ZERO_DEPOSIT' };
  return unknown(note ? 'DEPOSIT_RULE_REQUIRES_RESOLUTION' : 'ZERO_OR_MISSING_WITHOUT_WAIVER_EVIDENCE');
}

/**
 * Supplier note rule «월 대여료 × 약정연수 (최대 3개월)» (RP012 subscriptions: 12개월 = 1개월분, 24개월 = 2개월분, 36개월 이상 = 3개월분).
 * The stored placeholder deposit (0) is not a waiver; the amount is derived from the supplier's own rule note at read time —
 * nothing is written back (source stays untouched). Returns null unless the note is exactly that rule and the term is whole years.
 */
export function depositFromYearsRuleNote(note: unknown, termMonths: unknown, monthlyRent: unknown): { amount: number; multiplier: number } | null {
  if (typeof note !== 'string' || !/^월 대여료 × 약정연수 \(최대 3개월\)$/.test(note.trim())) return null;
  if (!Number.isSafeInteger(termMonths) || (termMonths as number) <= 0 || (termMonths as number) % 12 !== 0) return null;
  if (!Number.isSafeInteger(monthlyRent) || (monthlyRent as number) <= 0) return null;
  const multiplier = Math.min((termMonths as number) / 12, 3);
  const amount = (monthlyRent as number) * multiplier;
  return Number.isSafeInteger(amount) ? { amount, multiplier } : null;
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
export function depositStatusLabel(state: 'KNOWN' | 'ZERO' | 'UNKNOWN', sourceAmount: unknown, note?: unknown) {
  if (state === 'ZERO') return '무보증' as const;
  if (state === 'KNOWN') return '보증금 있음' as const;
  const missing = sourceAmount === undefined || sourceAmount === null || (typeof sourceAmount === 'string' && !sourceAmount.trim());
  return missing && (note === undefined || note === null || (typeof note === 'string' && !note.trim()))
    ? '미입력' as const : '확인중' as const;
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
      const result = assessDepositEvidence({ supplierId: product.provider_company_code, productType: product.product_type,
        note: product.deposit_note, depositFree: product.deposit_free, sourceAmount: row.deposit, hasPositivePaidDeposit });
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

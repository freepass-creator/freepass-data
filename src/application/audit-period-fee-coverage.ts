import { createHash } from 'node:crypto';
import { buildKakaoCatalogReferenceProduct } from './kakao-catalog-reference.js';
import { planPeriodFeeLedger, type PeriodFeeLedgerRow } from './period-fee-ledger-plan.js';

type Rec = Record<string, unknown>;

export type FeeCoverageInputs = {
  products: Record<string, Rec>;
  policies: Record<string, Rec>;
  newCarTrim: Record<string, Rec>;
  observedAt: string;
};

type FeeKind = 'supplierBillingFee' | 'channelPayoutFee';
type Bucket = { confirmed: number; approx: number; unconfirmed: number; reasons: Record<string, number> };

const productPathKey = (row: PeriodFeeLedgerRow) => row.inputRefs.productPath.replace(/^products\//, '');
const rowKey = (row: PeriodFeeLedgerRow) => `${productPathKey(row)}|${row.termKey}`;
const feeSig = (fee: PeriodFeeLedgerRow['supplierBillingFee']) => `${fee.state}:${fee.amount?.amount ?? ''}:${fee.reasonCode ?? ''}`;
const rowSig = (row: PeriodFeeLedgerRow) => [
  row.monthlyRent.amount, row.deposit.state, row.deposit.amount?.amount ?? '', feeSig(row.supplierBillingFee), feeSig(row.channelPayoutFee),
].join('|');

function bucket(rows: PeriodFeeLedgerRow[], kind: FeeKind): Bucket {
  const out: Bucket = { confirmed: 0, approx: 0, unconfirmed: 0, reasons: {} };
  for (const row of rows) {
    const fee = row[kind];
    if (fee.state === 'CALCULATED') out.confirmed += 1;
    else if (fee.state === 'CALCULATED_APPROX') out.approx += 1;
    else {
      out.unconfirmed += 1;
      const reason = `${fee.state}:${fee.reasonCode ?? 'NO_REASON'}`;
      out.reasons[reason] = (out.reasons[reason] ?? 0) + 1;
    }
  }
  return out;
}

const isSonokong = (row: PeriodFeeLedgerRow) =>
  [...row.ruleIds, row.supplierBillingFee.ruleId ?? '', row.channelPayoutFee.ruleId ?? ''].some(id => id.includes('SONOKONG'));

function listableTerms(inputs: FeeCoverageInputs) {
  const keys = new Set<string>();
  const terms: string[] = [];
  for (const [docKey, product] of Object.entries(inputs.products)) {
    const projected = buildKakaoCatalogReferenceProduct(docKey, product, {}, inputs.policies, inputs.observedAt);
    const found = projected?.offers.flatMap(offer => offer.priceTerms.map(term => `${docKey}|${term.termKey}`)) ?? [];
    if (found.length) { keys.add(docKey); terms.push(...found); }
  }
  return { keys, terms };
}

export function buildFeeCoverageAudit(inputs: FeeCoverageInputs, ledgerRows: PeriodFeeLedgerRow[]) {
  const listable = listableTerms(inputs);
  const scoped = ledgerRows.filter(row => listable.keys.has(productPathKey(row)));
  const scopedKeys = new Set(scoped.map(rowKey));

  const plan = planPeriodFeeLedger({ ...inputs, previousSnapshot: null }, { clock: () => new Date(inputs.observedAt) });
  const planByKey = new Map(plan.rows.map(row => [rowKey(row), row]));
  const sonokongProducts = new Set(plan.rows.filter(isSonokong).map(productPathKey));
  const inSonokong = (row: PeriodFeeLedgerRow) => isSonokong(row) || sonokongProducts.has(productPathKey(row));
  const sonokong = scoped.filter(inSonokong);
  const other = scoped.filter(row => !inSonokong(row));
  const after = plan.rows.filter(row => listable.keys.has(productPathKey(row)));
  const afterSonokong = after.filter(inSonokong);
  const afterOther = after.filter(row => !inSonokong(row));
  const mismatches: string[] = [];
  let compared = 0;
  for (const row of scoped) {
    const fresh = planByKey.get(rowKey(row));
    if (!fresh) { mismatches.push(`${rowKey(row)}|MISSING_IN_ENGINE`); continue; }
    compared += 1;
    if (rowSig(fresh) !== rowSig(row)) {
      const parts = [
        fresh.monthlyRent.amount !== row.monthlyRent.amount ? 'RENT' : '',
        `${fresh.deposit.state}:${fresh.deposit.amount?.amount ?? ''}` !== `${row.deposit.state}:${row.deposit.amount?.amount ?? ''}` ? 'DEPOSIT' : '',
        feeSig(fresh.supplierBillingFee) !== feeSig(row.supplierBillingFee) ? 'BILLING' : '',
        feeSig(fresh.channelPayoutFee) !== feeSig(row.channelPayoutFee) ? 'PAYOUT' : '',
      ].filter(Boolean).join('+');
      mismatches.push(`${rowKey(row)}|${inSonokong(row) ? 'SONOKONG' : 'OTHER'}:${parts}`);
    }
  }
  const missingInLedger = listable.terms.filter(key => !scopedKeys.has(key));
  const missingByProduct = new Map<string, number>();
  for (const key of missingInLedger) missingByProduct.set(key.split('|')[0]!, (missingByProduct.get(key.split('|')[0]!) ?? 0) + 1);
  const ledgerProducts = new Set(ledgerRows.map(productPathKey));
  const mismatchKinds: Record<string, number> = {};
  for (const key of mismatches) { const kind = key.split('|').at(-1)!; mismatchKinds[kind] = (mismatchKinds[kind] ?? 0) + 1; }

  return {
    listableProducts: listable.keys.size,
    listablePriceRows: listable.terms.length,
    ledgerRowsActive: ledgerRows.length,
    ledgerRowsForListable: scoped.length,
    missingInLedger: missingInLedger.length,
    missingProducts: missingByProduct.size,
    missingProductsAbsentFromLedger: [...missingByProduct.keys()].filter(key => !ledgerProducts.has(key)).length,
    mismatchKinds,
    all: { billing: bucket(scoped, 'supplierBillingFee'), payout: bucket(scoped, 'channelPayoutFee') },
    sonokong: { rows: sonokong.length, billing: bucket(sonokong, 'supplierBillingFee'), payout: bucket(sonokong, 'channelPayoutFee') },
    nonSonokong: { rows: other.length, billing: bucket(other, 'supplierBillingFee'), payout: bucket(other, 'channelPayoutFee') },
    afterCurrentRules: {
      rows: after.length,
      all: { billing: bucket(after, 'supplierBillingFee'), payout: bucket(after, 'channelPayoutFee') },
      sonokong: { rows: afterSonokong.length, billing: bucket(afterSonokong, 'supplierBillingFee'), payout: bucket(afterSonokong, 'channelPayoutFee') },
      nonSonokong: { rows: afterOther.length, billing: bucket(afterOther, 'supplierBillingFee'), payout: bucket(afterOther, 'channelPayoutFee') },
    },
    engineCompare: { compared, mismatches: mismatches.length },
    _mismatchKeys: mismatches,
    _scopedRows: scoped,
  };
}

export function sampleFeeAuditPlates(scoped: PeriodFeeLedgerRow[], mismatchKeys: string[], count: number, seed = 20261012) {
  const plates = [...new Set(scoped.map(productPathKey))].sort();
  let state = seed;
  const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  const picked: string[] = [];
  const pool = [...plates];
  while (picked.length < count && pool.length) picked.push(pool.splice(Math.floor(next() * pool.length), 1)[0]!);
  const bad = new Set(mismatchKeys.map(key => key.split('|')[0]!));
  return {
    sampled: picked.length,
    matched: picked.filter(plate => !bad.has(plate)).length,
    mismatchLast4: picked.filter(plate => bad.has(plate)).map(plate => plate.slice(-4)),
  };
}

export function lookupFeeTable(ledgerRows: PeriodFeeLedgerRow[], plateOrLast4: string) {
  return ledgerRows
    .filter(row => {
      const key = productPathKey(row);
      return key === plateOrLast4 || (plateOrLast4.length === 4 && key.endsWith(plateOrLast4));
    })
    .sort((a, b) => a.termMonths - b.termMonths)
    .map(row => ({
      plateLast4: productPathKey(row).slice(-4),
      termKey: row.termKey,
      termMonths: row.termMonths,
      monthlyRent: row.monthlyRent.state === 'KNOWN' ? row.monthlyRent.amount : null,
      depositState: row.deposit.state,
      deposit: row.deposit.amount?.amount ?? null,
      billing: row.supplierBillingFee.amount?.amount ?? null,
      billingState: row.supplierBillingFee.state,
      billingReason: row.supplierBillingFee.reasonCode,
      payout: row.channelPayoutFee.amount?.amount ?? null,
      payoutState: row.channelPayoutFee.state,
      payoutReason: row.channelPayoutFee.reasonCode,
      sonokongRulePending: isSonokong(row),
    }));
}

/** 파일에 남기는 불일치 키는 차량번호 대신 실행마다 다른 salt 의 해시 앞 12자(복원 불가)만 쓴다. */
export function redactMismatchKeys(mismatchKeys: string[], salt: string) {
  return mismatchKeys.map((key) => {
    const [plate, ...rest] = key.split('|');
    return [createHash('sha256').update(`${salt}:${plate}`).digest('hex').slice(0, 12), ...rest].join('|');
  });
}

export const MAX_LOOKUP_CANDIDATES = 20;

type LookupStatus = 'TOO_MANY_CANDIDATES' | 'OK' | 'OK_ENGINE_ONLY_NOT_IN_LEDGER' | 'NOT_LISTABLE' | 'NO_PRICE_ROWS' | 'PRODUCT_NOT_FOUND';

const label = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** 차량번호(또는 끝 4자리) 하나로 «왜 이 표가 나오는지»까지 돌려준다 — 빈 배열만 주지 않는다. */
export function lookupFeeWithReason(inputs: FeeCoverageInputs, ledgerRows: PeriodFeeLedgerRow[], plateOrLast4: string) {
  const keys = Object.keys(inputs.products).filter(key => key === plateOrLast4 || (plateOrLast4.length === 4 && key.endsWith(plateOrLast4)));
  if (!keys.length) return [{ plateLast4: plateOrLast4.slice(-4), status: 'PRODUCT_NOT_FOUND' as LookupStatus, reason: '프리패스 데이터 상품에 없는 번호', rows: [] }];
  if (keys.length > MAX_LOOKUP_CANDIDATES) {
    return [{ plateLast4: plateOrLast4.slice(-4), status: 'TOO_MANY_CANDIDATES' as LookupStatus, reason: `후보가 너무 많음(${keys.length}대), 더 긴 번호로 재조회`, rows: [] }];
  }
  return keys.sort().map((key) => {
    const product = inputs.products[key]!;
    const base = {
      plateLast4: key.slice(-4),
      supplierId: label(product.provider_company_code),
      carName: [label(product.maker), label(product.model), label(product.sub_model)].filter(Boolean).join(' ') || null,
    };
    if (product.listable !== true) return { ...base, status: 'NOT_LISTABLE' as LookupStatus, reason: '판매 중 상품이 아님(listable 아님)', rows: [] };
    const projected = buildKakaoCatalogReferenceProduct(key, product, {}, inputs.policies, inputs.observedAt);
    if (!projected || !projected.offers.some(offer => offer.priceTerms.length)) {
      return { ...base, status: 'NO_PRICE_ROWS' as LookupStatus, reason: '판매 중이나 가격 행 없음(공급사 코드·가격 칸 확인 필요)', rows: [] };
    }
    const ledger = lookupFeeTable(ledgerRows, key);
    if (ledger.length) return { ...base, status: 'OK' as LookupStatus, reason: '장부(박제 시점) 기준', rows: ledger };
    const plan = planPeriodFeeLedger({ products: { [key]: product }, policies: inputs.policies, newCarTrim: inputs.newCarTrim, previousSnapshot: null }, { clock: () => new Date(inputs.observedAt) });
    return {
      ...base,
      status: 'OK_ENGINE_ONLY_NOT_IN_LEDGER' as LookupStatus,
      reason: '장부에 없음(첫 박제 뒤 들어온 상품) — 지금 엔진 계산값',
      rows: lookupFeeTable(plan.rows, key),
    };
  });
}

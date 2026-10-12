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

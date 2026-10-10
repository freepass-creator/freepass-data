import type { SourceIntakeBatch } from './source-intake.js';
import { classifySonokongRecord, SONOKONG_DEPOSIT_RULE_TEXT } from './consumer-output-contract.js';
import { normalizeErp5CompatibilityInteger, resolveDepositWithRuleNote } from './deposit-evidence.js';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const table = () => ({
  POSITIVE: { POSITIVE: 0, ZERO: 0, UNKNOWN: 0 },
  ZERO: { POSITIVE: 0, ZERO: 0, UNKNOWN: 0 },
  MISSING: { POSITIVE: 0, ZERO: 0, UNKNOWN: 0 },
});
const group = () => ({ crossTable: table(), terms: 0, mismatches: 0, incomparable: 0,
  sourceBands: { ZERO: 0, BELOW_1M: 0, FROM_1M_TO_5M: 0, AT_LEAST_5M: 0, UNKNOWN: 0 } });

/** Same RAW vehicle/estimate/term, current Data rule evaluation, NOT a live consumer readback.
 * No individual identifiers, amounts, source strings or source-derived object keys escape.
 */
export function compareSonogongDeposits(batch: SourceIntakeBatch) {
  const groups = { SUBSCRIBE_RETURN: group(), SUBSCRIBE_BUYOUT: group(), USED_RENT: group() };
  let excludedEstimates = 0;
  let invalidSourceAmounts = 0;
  for (const { payload } of batch.records) {
    if (!object(payload.list) || !object(payload.detail) || !Array.isArray(payload.detail.estimates)) continue;
    const classification = classifySonokongRecord({ bucket: payload.list.carSource, plateNumber: payload.list.carNumber });
    for (const estimate of payload.detail.estimates) {
      if (!object(estimate)) { excludedEstimates++; continue; }
      const type = estimate.estimateType;
      const rent = type === 'RENT_RETURN' || type === 'RENT_BUYOUT';
      const subscribe = type === 'SUBSCRIBE_RETURN' || type === 'SUBSCRIBE_BUYOUT';
      // Credit scope follows the ERP4 LOW lane. Unknown/colliding product meaning is excluded.
      if (estimate.creditType !== 'LOW' || classification.status !== 'CLASSIFIED'
        || (!rent && !subscribe) || (rent !== (classification.commercialType === 'USED_RENT'))) {
        excludedEstimates++; continue;
      }
      const target = rent ? groups.USED_RENT : groups[type as 'SUBSCRIBE_RETURN' | 'SUBSCRIBE_BUYOUT'];
      const raw = estimate.securityDepositAmount;
      const amount = normalizeErp5CompatibilityInteger(raw);
      if (amount === undefined && raw !== undefined && raw !== null && raw !== '') invalidSourceAmounts++;
      const sourceState = amount === undefined ? 'MISSING' : amount === 0 ? 'ZERO' : 'POSITIVE';
      for (const termMonths of [12, 24, 36, 48, 60]) {
        const monthly = estimate[`monthly${termMonths}`];
        if (monthly === undefined || monthly === null || monthly === '') continue;
        const result = resolveDepositWithRuleNote({ supplierId: 'RP012',
          productType: rent ? '중고렌트' : '오공구독',
          note: rent ? undefined : SONOKONG_DEPOSIT_RULE_TEXT,
          sourceAmount: rent ? raw : 0, termMonths, monthlyRent: normalizeErp5CompatibilityInteger(monthly) });
        const ruleState = result.state === 'UNKNOWN' ? 'UNKNOWN' : result.amount === 0 ? 'ZERO' : 'POSITIVE';
        target.crossTable[sourceState][ruleState]++;
        target.terms++;
        if (amount === undefined || result.state === 'UNKNOWN') target.incomparable++;
        else if (amount !== result.amount) target.mismatches++;
        const band = amount === undefined ? 'UNKNOWN' : amount === 0 ? 'ZERO'
          : amount < 1_000_000 ? 'BELOW_1M' : amount < 5_000_000 ? 'FROM_1M_TO_5M' : 'AT_LEAST_5M';
        target.sourceBands[band]++;
      }
    }
  }
  return { basis: 'CURRENT_DATA_RULE_EVALUATION' as const, liveConsumerReadback: 'NOT_VERIFIED' as const,
    unit: 'BUCKET_VEHICLE_ESTIMATE_TERM' as const, groups, excludedEstimates, invalidSourceAmounts };
}

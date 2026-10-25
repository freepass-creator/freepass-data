/** Commission names are from FreePass's perspective, never the caller's perspective. */
export const COMMISSION_CONSUMER_POLICY = {
    SALES_CHANNEL: {
        field: 'channelPayoutFee', label: '프리패스 수수료',
        payer: 'FREEPASS', payee: 'SALES_CHANNEL',
    },
    SUPPLIER: {
        field: 'supplierBillingFee', label: '공급사 청구수수료',
        payer: 'SUPPLIER', payee: 'FREEPASS',
    },
};
export const DEFAULT_COMMISSION_AUDIENCE = 'SALES_CHANNEL';
/**
 * Prepared counterparty projection, not an authorization gate or an API route.
 * The caller must bind audience and counterparty scope from server-owned grants.
 * Rates/source refs and the opposite fee stay internal; no margin is returned.
 */
export function projectCounterpartyCommission(term, audience = DEFAULT_COMMISSION_AUDIENCE) {
    if (audience !== 'SALES_CHANNEL' && audience !== 'SUPPLIER') {
        throw new Error('Unsupported commission audience');
    }
    const policy = COMMISSION_CONSUMER_POLICY[audience];
    const fee = term[policy.field];
    const validAmount = fee.amount?.currency === 'KRW' &&
        Number.isSafeInteger(fee.amount.amount) && fee.amount.amount >= 0;
    const resolved = validAmount && ((fee.state === 'KNOWN' && fee.amount.amount > 0) ||
        (fee.state === 'ZERO' && fee.amount.amount === 0));
    return {
        termKey: term.termKey,
        audience,
        feeType: policy.field,
        label: policy.label,
        payer: policy.payer,
        payee: policy.payee,
        state: fee.state === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE'
            : resolved ? fee.state : 'UNKNOWN',
        amount: resolved ? { ...fee.amount } : null,
    };
}

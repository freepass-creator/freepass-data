const RELEASED_LOCK_VALUE = 'LEDGER';
/**
 * 해제 갱신 칸을 만든다. 이미 해제 이력 칸(_ledger_unlocked_at·_ledger_unlock_reason·_ledger_unlock_previous)에 값이 있으면
 * 덮어쓰기 전에 _ledger_unlock_history 배열에 옮겨 보존한다(이전 값을 잃지 않는다).
 */
export function buildContractLockReleaseUpdate(data, input, nowMs) {
    const hadPrevious = data._ledger_unlocked_at !== undefined || data._ledger_unlock_reason !== undefined || data._ledger_unlock_previous !== undefined;
    const history = Array.isArray(data._ledger_unlock_history) ? [...data._ledger_unlock_history] : [];
    if (hadPrevious) {
        history.push({
            at: data._ledger_unlocked_at ?? null,
            reason: data._ledger_unlock_reason ?? null,
            previous: data._ledger_unlock_previous ?? null,
        });
    }
    return {
        locked_by_contract: null,
        _ledger_unlocked_at: nowMs,
        _ledger_unlock_reason: input.reason,
        _ledger_unlock_previous: { locked_by_contract: RELEASED_LOCK_VALUE, _ledger_lock_at: input.expectedLockAt },
        ...(history.length ? { _ledger_unlock_history: history } : {}),
    };
}

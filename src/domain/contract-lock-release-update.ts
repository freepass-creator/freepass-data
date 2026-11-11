type Rec = Record<string, unknown>;

export const LEDGER_LOCK_VALUE = 'LEDGER';
export const LEGACY_LEDGER_LOCK_VALUE = '정산원장';

/** 해제 가능한 잠금 유형과 일치 확인 토큰 필드. LEDGER=_ledger_lock_at, 정산원장(한글)=_ledger_status_at. 그 외 값은 null. */
export function releasableLockToken(data: Rec): { lockValue: string; field: '_ledger_lock_at' | '_ledger_status_at'; value: unknown } | null {
  if (data.locked_by_contract === LEDGER_LOCK_VALUE) return { lockValue: LEDGER_LOCK_VALUE, field: '_ledger_lock_at', value: data._ledger_lock_at };
  if (data.locked_by_contract === LEGACY_LEDGER_LOCK_VALUE) return { lockValue: LEGACY_LEDGER_LOCK_VALUE, field: '_ledger_status_at', value: data._ledger_status_at };
  return null;
}

/**
 * 해제 갱신 칸을 만든다. 이미 해제 이력 칸(_ledger_unlocked_at·_ledger_unlock_reason·_ledger_unlock_previous)에 값이 있으면
 * 덮어쓰기 전에 _ledger_unlock_history 배열에 옮겨 보존한다(이전 값을 잃지 않는다).
 */
export function buildContractLockReleaseUpdate(data: Rec, input: { expectedLockAt: number; reason: string }, nowMs: number): Rec {
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
    _ledger_unlock_previous: data.locked_by_contract === LEGACY_LEDGER_LOCK_VALUE
      ? { locked_by_contract: LEGACY_LEDGER_LOCK_VALUE, token_field: '_ledger_status_at', token_value: input.expectedLockAt, _ledger_status_at: input.expectedLockAt }
      : { locked_by_contract: LEDGER_LOCK_VALUE, _ledger_lock_at: input.expectedLockAt },
    ...(history.length ? { _ledger_unlock_history: history } : {}),
  };
}

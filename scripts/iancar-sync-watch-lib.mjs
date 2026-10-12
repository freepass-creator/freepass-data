// 이안카 «감지 후 자동 동기화» 판단 로직 — 부수 효과 없는 순수 함수(시험 가능).
// 원칙: ① ONE 갱신(synced_at 변화)마다 한 번 전량 읽기→계획→건수 관문→적용 ② 같은 갱신에서 일시 실패는 신선 창 안에서만 한 번 더
//       ③ 건수 관문 중단·반복 실패·429 는 사람이 보게 멈추거나 물러난다 ④ 신선도 기준(15분)은 완화하지 않는다.

export const FRESH_WINDOW_MS = 15 * 60 * 1000;     // 이안카 공개 신선 기준(코드 상수 900초와 같다)
export const MAX_ATTEMPTS_PER_SYNC = 2;            // 같은 synced_at 에서 최대 시도
export const RETRY_ONLY_IF_YOUNGER_THAN_MS = 5 * 60 * 1000; // 갱신 후 5분 이내일 때만 재시도(전량 읽기가 10분 걸리므로 그 이후는 의미 없음)
export const BACKOFF_429_MS = 10 * 60 * 1000;
export const MAX_CONSECUTIVE_FAILURES = 3;

export const initialState = () => ({
  lastHandledSyncedAt: null, attemptsForSyncedAt: 0, lastAttemptSyncedAt: null,
  consecutiveFailures: 0, backoffUntil: 0, halted: false, haltReason: null,
});

/** 실행 결과(종료 코드·출력 문자열)를 분류한다. 비밀 값은 다루지 않는다. */
export function classifyRun({ exitCode, stdout = '', stderr = '' }) {
  const text = `${stdout}\n${stderr}`;
  if (exitCode === 0 && /PHASE_ONE_ATOM_READBACK_VERIFIED|IANCAR_ATOM_SYNC_VERIFIED_CONSUMERS_PENDING/.test(text)) return { kind: 'APPLIED' };
  if (exitCode === 3 || /HOLD_PLAN_OUT_OF_APPROVED_RANGE/.test(text)) return { kind: 'GATE_HOLD' };   // 건수 승인 범위 밖: 사람이 판단
  if (/IANCAR_ONE_API_HTTP_429|VEHICLE_PHOTO_RATE_LIMITED|RATE_LIMIT/.test(text)) return { kind: 'RATE_LIMITED' };
  if (/FRESHNESS_EXCEEDED|SOURCE_STALE|PUBLICATION_SOURCE_STALE_OR_INVALID|SOURCE_REQUIRES_REVIEW/.test(text)) return { kind: 'STALE' };
  if (/TimeoutError|IANCAR_ONE_API_HTTP_(502|503|504)|fetch failed|ECONNRESET/.test(text)) return { kind: 'TRANSIENT' };
  if (/IANCAR_PUBLICATION_(PLAN_CHANGED|REVISION_CHANGED)/.test(text)) return { kind: 'TRANSIENT' };     // 쓰기 직전 문서가 바뀜: 다음 시도에서 다시 계획
  return { kind: 'FAILED' };
}

/** 지금 무엇을 할지 결정한다. observed = 방금 읽은 ONE synced_at(ISO) 또는 null(읽기 실패). */
export function decide(state, observed, now) {
  if (state.halted) return { action: 'HALTED', reason: state.haltReason };
  if (now < state.backoffUntil) return { action: 'WAIT', reason: 'BACKOFF' };
  if (!observed) return { action: 'WAIT', reason: 'OBSERVE_FAILED' };
  const age = now - Date.parse(observed);
  if (!Number.isFinite(age)) return { action: 'WAIT', reason: 'OBSERVED_INVALID' };
  if (observed === state.lastHandledSyncedAt) return { action: 'WAIT', reason: 'ALREADY_HANDLED' };
  if (age > FRESH_WINDOW_MS) return { action: 'WAIT', reason: 'SOURCE_ALREADY_STALE' };           // 이미 15분 지난 갱신은 읽어도 신선도 중단
  if (observed === state.lastAttemptSyncedAt) {
    if (state.attemptsForSyncedAt >= MAX_ATTEMPTS_PER_SYNC) return { action: 'WAIT', reason: 'MAX_ATTEMPTS' };
    if (age > RETRY_ONLY_IF_YOUNGER_THAN_MS) return { action: 'WAIT', reason: 'RETRY_WINDOW_PASSED' };
  }
  return { action: 'RUN', syncedAt: observed };
}

/** 실행 결과를 상태에 반영한다(새 객체를 돌려준다). */
export function applyOutcome(state, syncedAt, outcome, now) {
  const next = { ...state };
  next.attemptsForSyncedAt = syncedAt === state.lastAttemptSyncedAt ? state.attemptsForSyncedAt + 1 : 1;
  next.lastAttemptSyncedAt = syncedAt;
  switch (outcome.kind) {
    case 'APPLIED': next.lastHandledSyncedAt = syncedAt; next.consecutiveFailures = 0; break;
    case 'GATE_HOLD': next.halted = true; next.haltReason = 'GATE_HOLD_NEEDS_HUMAN'; break;
    case 'RATE_LIMITED': next.backoffUntil = now + BACKOFF_429_MS; break;
    case 'STALE': next.lastHandledSyncedAt = syncedAt; break;                                  // 이 갱신은 놓쳤다 — 다음 갱신을 기다린다(실패로 세지 않음)
    case 'TRANSIENT':
      if (next.attemptsForSyncedAt >= MAX_ATTEMPTS_PER_SYNC) { next.lastHandledSyncedAt = syncedAt; next.consecutiveFailures += 1; }
      break;
    default: next.lastHandledSyncedAt = syncedAt; next.consecutiveFailures += 1;
  }
  if (!next.halted && next.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { next.halted = true; next.haltReason = 'CONSECUTIVE_FAILURES'; }
  return next;
}

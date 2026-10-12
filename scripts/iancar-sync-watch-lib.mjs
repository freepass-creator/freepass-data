// 이안카 «감지 후 자동 동기화» 판단 로직 — 부수 효과 없는 순수 함수(시험 가능).
// 원칙: ① ONE 갱신(synced_at 변화)마다 «새 갱신 한 번당 한 번만» 전량 읽기→계획→건수 관문→적용 ② 어떤 실패든 자동 재시도 없이
//       정지하고 사람이 확인한 뒤에만 다시 시작한다 ③ 신선도 기준(15분)은 완화하지 않는다.

export const FRESH_WINDOW_MS = 15 * 60 * 1000;     // 이안카 공개 신선 기준(코드 상수 900초와 같다)

export const initialState = () => ({ lastHandledSyncedAt: null, halted: false, haltReason: null });

/** 실행 결과(종료 코드·출력 문자열)를 분류한다. 비밀 값은 다루지 않는다. */
export function classifyRun({ exitCode, stdout = '', stderr = '', dry = false }) {
  const text = `${stdout}\n${stderr}`;
  if (exitCode === 3 || /HOLD_PLAN_OUT_OF_APPROVED_RANGE/.test(text)) return { kind: 'GATE_HOLD' };   // 건수 승인 범위 밖: 사람이 판단
  if (!dry && exitCode === 0 && /PHASE_ONE_ATOM_READBACK_VERIFIED|IANCAR_ATOM_SYNC_VERIFIED_CONSUMERS_PENDING/.test(text)) return { kind: 'APPLIED' };
  if (dry && exitCode === 0 && /OBSERVED_NOT_PUBLISHED/.test(text) && /"publicationPlan"/.test(text)) return { kind: 'DRY_OK' };
  if (/IANCAR_ONE_API_HTTP_429|VEHICLE_PHOTO_RATE_LIMITED|RATE_LIMIT/.test(text)) return { kind: 'RATE_LIMITED' };
  if (/FRESHNESS_EXCEEDED|SOURCE_STALE|PUBLICATION_SOURCE_STALE_OR_INVALID|SOURCE_REQUIRES_REVIEW/.test(text)) return { kind: 'STALE' };
  return { kind: 'FAILED' };   // 적용 증거 없는 정상 종료도 여기(성공으로 세지 않는다)
}

/** 지금 무엇을 할지 결정한다. observed = 방금 읽은 ONE synced_at(ISO) 또는 null(읽기 실패). */
export function decide(state, observed, now) {
  if (state.halted) return { action: 'HALTED', reason: state.haltReason };
  if (!observed) return { action: 'WAIT', reason: 'OBSERVE_FAILED' };
  const age = now - Date.parse(observed);
  if (!Number.isFinite(age)) return { action: 'WAIT', reason: 'OBSERVED_INVALID' };
  if (observed === state.lastHandledSyncedAt) return { action: 'WAIT', reason: 'ALREADY_HANDLED' };
  if (age > FRESH_WINDOW_MS) return { action: 'WAIT', reason: 'SOURCE_ALREADY_STALE' };           // 이미 15분 지난 갱신은 읽어도 신선도 중단
  return { action: 'RUN', syncedAt: observed };
}

/** 실행 결과를 상태에 반영한다(새 객체). 성공(APPLIED·DRY_OK)만 이어가고, 그 밖의 모든 결과는 정지한다 — 자동 재시도 없음. */
export function applyOutcome(state, syncedAt, outcome) {
  const next = { ...state, lastHandledSyncedAt: syncedAt };
  if (outcome.kind !== 'APPLIED' && outcome.kind !== 'DRY_OK') { next.halted = true; next.haltReason = outcome.kind; }
  return next;
}

/** 종료 코드: 정상(적용 증거 또는 시험 계획 확인) 0, 건수 관문 중단 3, 그 밖의 모든 실패 1. */
export function exitCodeFor(outcome) {
  if (outcome.kind === 'APPLIED' || outcome.kind === 'DRY_OK') return 0;
  return outcome.kind === 'GATE_HOLD' ? 3 : 1;
}

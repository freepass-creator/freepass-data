// 이안카 «감지 후 자동 동기화» 판단 로직 — 부수 효과 없는 순수 함수(시험 가능).
// 원칙: ① ONE 갱신(synced_at 변화)마다 «새 갱신 한 번당 한 번만» 전량 읽기→계획→건수 관문→적용 ② 어떤 실패든 자동 재시도 없이
//       정지하고 사람이 확인한 뒤에만 다시 시작한다 ③ 신선도 기준(15분)은 완화하지 않는다 ④ 성공은 «구조화된 영수증»으로만 인정한다.

export const FRESH_WINDOW_MS = 15 * 60 * 1000;     // 이안카 공개 신선 기준(코드 상수 900초와 같다)
export const MAX_OBSERVE_FAILURES = 3;             // 감지 조회가 연속으로 이만큼 실패하면 정지(사람 확인)

export const initialState = () => ({ lastHandledSyncedAt: null, halted: false, haltReason: null, observeFailures: 0 });

/** 수집기 출력에서 최종 보고 JSON 을 꺼낸다(진행 줄은 한 줄 JSON, 보고는 «{» 다음 줄바꿈으로 시작). 없거나 깨지면 null. */
export function parseReport(stdout = '') {
  const start = stdout.indexOf('{\n');
  if (start < 0) return null;
  try { const value = JSON.parse(stdout.slice(start)); return value && typeof value === 'object' ? value : null; } catch { return null; }
}

/** 실행 결과를 분류한다. 성공은 종료 코드 0 + 구조화된 보고의 «상태 값» 일치로만 인정한다(문자열 포함 여부로 판단하지 않는다). */
export function classifyRun({ exitCode, stdout = '', stderr = '', dry = false }) {
  const report = parseReport(stdout);
  const text = `${stdout}\n${stderr}`;
  if (exitCode === 3 || report?.status === 'HOLD_PLAN_OUT_OF_APPROVED_RANGE') return { kind: 'GATE_HOLD' };   // 건수 승인 범위 밖: 사람이 판단
  if (exitCode === 0 && report) {
    if (!dry && report.status === 'IANCAR_ATOM_SYNC_VERIFIED_CONSUMERS_PENDING'
      && report.publication?.status === 'PHASE_ONE_ATOM_READBACK_VERIFIED') return { kind: 'APPLIED' };
    if (dry && report.status === 'OBSERVED_NOT_PUBLISHED' && report.publicationPlan && !report.publication) return { kind: 'DRY_OK' };
    return { kind: 'FAILED' };                      // 정상 종료여도 영수증이 기대 값이 아니면 성공이 아니다
  }
  if (/IANCAR_ONE_API_HTTP_429|VEHICLE_PHOTO_RATE_LIMITED|RATE_LIMIT/.test(text)) return { kind: 'RATE_LIMITED' };
  if (/FRESHNESS_EXCEEDED|SOURCE_STALE|PUBLICATION_SOURCE_STALE_OR_INVALID|SOURCE_REQUIRES_REVIEW/.test(text)) return { kind: 'STALE' };
  return { kind: 'FAILED' };
}

/** 감지 조회 결과를 상태에 반영한다. 연속 실패가 한도에 닿으면 정지한다(조용한 무한 재시도 금지). */
export function noteObservation(state, observed) {
  // 값이 없거나 날짜로 해석되지 않으면(잘못된 응답) 조회 실패로 센다.
  if (observed && Number.isFinite(Date.parse(observed)) && Date.parse(observed) - Date.now() < 60_000) return state.observeFailures ? { ...state, observeFailures: 0 } : state;
  const failures = state.observeFailures + 1;
  const next = { ...state, observeFailures: failures };
  if (failures >= MAX_OBSERVE_FAILURES && !next.halted) { next.halted = true; next.haltReason = 'OBSERVE_FAILED'; }
  return next;
}

/** 지금 무엇을 할지 결정한다. observed = 방금 읽은 ONE synced_at(ISO) 또는 null(읽기 실패). */
export function decide(state, observed, now) {
  if (state.halted) return { action: 'HALTED', reason: state.haltReason };
  if (!observed) return { action: 'WAIT', reason: 'OBSERVE_FAILED' };
  const age = now - Date.parse(observed);
  if (!Number.isFinite(age) || age < -60_000) return { action: 'WAIT', reason: 'OBSERVED_INVALID' };   // 날짜가 아니거나 1분 넘게 미래면 잘못된 값
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

/** 종료 코드: 정상(적용 영수증 또는 시험 계획 확인) 0, 건수 관문 중단 3, 그 밖의 모든 실패 1. */
export function exitCodeFor(outcome) {
  if (outcome.kind === 'APPLIED' || outcome.kind === 'DRY_OK') return 0;
  return outcome.kind === 'GATE_HOLD' ? 3 : 1;
}

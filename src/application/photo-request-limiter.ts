/**
 * 공급사(ONE) 호출 공통 제한기: 동시 실행 수 + 최소 간격 + 429 물러남(Retry-After·지터).
 * 복제 작업과 서빙의 원천 대체 경로가 같은 방식의 제한기를 써서 429 폭주를 막는다.
 * 여유가 있으면 호출은 «즉시(같은 틱에서)» 시작한다 — 제한기가 평소 지연을 더하지 않는다.
 */
export type PhotoRequestLimiterOptions = {
  maxConcurrent?: number;
  minIntervalMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

type MaybeRateLimited = { status?: unknown; retryAfterSeconds?: unknown };

export function createPhotoRequestLimiter(options: PhotoRequestLimiterOptions = {}) {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
  const minInterval = Math.max(0, options.minIntervalMs ?? 250);
  const maxRetries = Math.max(0, options.maxRetries ?? 4);
  const maxBackoff = options.maxBackoffMs ?? 60_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  let active = 0;
  let nextStart = 0;
  const waiting: Array<() => void> = [];

  const tryStartNow = () => {
    if (active >= maxConcurrent || now() < nextStart) return false;
    active += 1;
    nextStart = now() + minInterval;
    return true;
  };
  const startSlow = async () => {
    for (;;) {
      if (tryStartNow()) return;
      if (active >= maxConcurrent) await new Promise<void>(resolve => waiting.push(resolve));
      else await sleep(Math.max(1, nextStart - now()));
    }
  };
  const release = () => { active -= 1; waiting.shift()?.(); };

  /** 429 만 물러나서 다시 시도한다(상한 횟수). 다른 오류는 그대로 던진다. */
  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      if (!tryStartNow()) await startSlow();
      try {
        const value = await task();
        release();
        return value;
      } catch (error) {
        release();
        const info = error as MaybeRateLimited;
        if (info?.status !== 429 || attempt >= maxRetries) throw error;
        const retryAfter = typeof info.retryAfterSeconds === 'number' && info.retryAfterSeconds > 0 ? info.retryAfterSeconds * 1000 : 1000 * 2 ** attempt;
        const delay = Math.min(maxBackoff, retryAfter + Math.floor(random() * 500));
        nextStart = Math.max(nextStart, now() + delay);
        await sleep(delay);
      }
    }
  };
  return { run };
}

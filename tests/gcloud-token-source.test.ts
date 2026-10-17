import { describe, expect, it, vi } from 'vitest';
import { createGcloudTokenSource, firestoreCycleCommands } from '../src/infra/source-cycle-firestore.js';
import { unattendedPreflight } from '../src/runtime/source-cycle-runtime.js';

// 2026-10-17 장애: 요청마다 gcloud 프로세스를 새로 띄우다 호스트가 느려지자 일부가 시간 초과·stdout 오류로 죽어 CYCLE_ERROR 로 전 공급사가 보류됐다.
// Codex 상의 P1: ① 출력 시각 ≠ 발급 시각이라 긴 TTL 금지 + 401 무효화 ② 계정 고정 ③ 콜론 없는 코드 / P2: 동시 발급 공유·최종 실패 뒤 냉각.
function clock(start = 1_000_000) { let t = start; return { now: () => t, tick: (ms: number) => { t += ms; } }; }

describe('createGcloudTokenSource — 캐시·재시도·코드', () => {
  it('첫 호출만 발급하고 TTL 안에서는 재사용, TTL 이 지나면 다시 발급한다', async () => {
    const c = clock(); const exec = vi.fn(async () => 'tok-1\n');
    const src = createGcloudTokenSource({ exec, now: c.now, ttlMs: 15 * 60_000 });
    expect(await src()).toBe('tok-1'); expect(await src()).toBe('tok-1'); expect(exec).toHaveBeenCalledTimes(1);
    c.tick(14 * 60_000); expect(await src()).toBe('tok-1'); expect(exec).toHaveBeenCalledTimes(1);
    c.tick(2 * 60_000); exec.mockResolvedValueOnce('tok-2'); expect(await src()).toBe('tok-2'); expect(exec).toHaveBeenCalledTimes(2);
  });
  it('동시 호출은 발급 Promise 를 공유한다(프로세스 1개)', async () => {
    let resolveExec!: (v: string) => void; const exec = vi.fn(() => new Promise<string>(r => { resolveExec = r; }));
    const src = createGcloudTokenSource({ exec, now: clock().now });
    const a = src(), b = src(), d = src(); resolveExec('tok');
    expect(await Promise.all([a, b, d])).toEqual(['tok', 'tok', 'tok']); expect(exec).toHaveBeenCalledTimes(1);
  });
  it('첫 시도가 시간 초과면 더 긴 제한으로 1회 재시도하고 성공하면 캐시한다', async () => {
    const exec = vi.fn(async (ms: number) => { if (ms === 30_000) throw new Error('GCLOUD_TOKEN_FAILED_TIMEOUT'); return 'tok-retry'; });
    const src = createGcloudTokenSource({ exec, now: clock().now, timeoutMs: 30_000, retryTimeoutMs: 60_000 });
    expect(await src()).toBe('tok-retry'); expect(exec).toHaveBeenCalledTimes(2); expect(exec.mock.calls.map(c => c[0])).toEqual([30_000, 60_000]);
    expect(await src()).toBe('tok-retry'); expect(exec).toHaveBeenCalledTimes(2);
  });
  it('두 번 다 실패하면 콜론 없는 코드로 거절하고, 냉각 시간 동안은 프로세스를 띄우지 않고 같은 코드로 바로 거절한다', async () => {
    const c = clock(); const exec = vi.fn(async (): Promise<string> => { throw new Error('Command failed: gcloud crashed (OSError): [Errno 22] Invalid argument'); });
    const src = createGcloudTokenSource({ exec, now: c.now, cooldownMs: 60_000 });
    await expect(src()).rejects.toThrow(/^GCLOUD_TOKEN_FAILED_CRASH$/); expect(exec).toHaveBeenCalledTimes(2);
    await expect(src()).rejects.toThrow(/^GCLOUD_TOKEN_FAILED_CRASH$/); expect(exec).toHaveBeenCalledTimes(2);   // 냉각 중: 재호출 없음
    c.tick(61_000); exec.mockResolvedValueOnce('tok-ok'); expect(await src()).toBe('tok-ok');
  });
  it('시간 초과 메시지는 TIMEOUT, 빈 출력은 EMPTY 로 분류되고 모든 코드가 회차 기록 필터를 통과한다', async () => {
    const timeout = createGcloudTokenSource({ exec: async () => { throw new Error('spawn ETIMEDOUT'); }, now: clock().now });
    await expect(timeout()).rejects.toThrow(/^GCLOUD_TOKEN_FAILED_TIMEOUT$/);
    const empty = createGcloudTokenSource({ exec: async () => '  \n', now: clock().now });
    await expect(empty()).rejects.toThrow(/^GCLOUD_TOKEN_FAILED_EMPTY$/);
    for (const code of ['GCLOUD_TOKEN_FAILED_TIMEOUT', 'GCLOUD_TOKEN_FAILED_CRASH', 'GCLOUD_TOKEN_FAILED_EMPTY']) expect(/^[A-Z_]+$/.test(code)).toBe(true);
  });
  it('invalidate() 뒤에는 캐시·냉각을 버리고 다시 발급한다', async () => {
    const exec = vi.fn(async () => 'tok-a'); const src = createGcloudTokenSource({ exec, now: clock().now });
    expect(await src()).toBe('tok-a'); src.invalidate(); exec.mockResolvedValueOnce('tok-b'); expect(await src()).toBe('tok-b'); expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('401 안전망 — Firestore 명령은 토큰을 무효화하고 한 번만 다시 발급해 재요청한다', () => {
  it('첫 응답 401 → invalidate → 새 토큰으로 재요청 성공; 두 번째도 401 이면 실패로 끝난다(무한 반복 없음)', async () => {
    const exec = vi.fn(async () => `tok-${exec.mock.calls.length}`); const src = createGcloudTokenSource({ exec, now: clock().now });
    const seen: string[] = []; let calls = 0;
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => { seen.push(String((init?.headers as Record<string, string>).authorization)); calls++;
      return new Response('', { status: calls === 1 ? 401 : 404 }); });   // 재요청은 404(문서 없음 = null) 로 끝내 되읽기 검증과 무관하게 재발급만 본다
    const commands = firestoreCycleCommands({ directory: 'C:/tmp/none', env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, fetcher: fetcher as unknown as typeof fetch, token: src });
    expect(await commands.read('S', 'u1')).toBeNull();
    expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-2']); expect(exec).toHaveBeenCalledTimes(2);
    const always401 = vi.fn(async () => new Response('', { status: 401 }));
    const c2 = firestoreCycleCommands({ directory: 'C:/tmp/none', env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, fetcher: always401 as unknown as typeof fetch, token: src });
    await expect(c2.read('S', 'u1')).rejects.toThrow('FIRESTORE_REQUEST_FAILED'); expect(always401).toHaveBeenCalledTimes(2);
  });
});

describe('사전점검 — 토큰 실패 사유 코드를 함께 남긴다', () => {
  it('MISSING 뒤에 GCLOUD_TOKEN_FAILED_TIMEOUT 이 따라온다', async () => {
    const missing = await unattendedPreflight({ SOURCE_CYCLE_SOURCES: 'IANCAR' } as NodeJS.ProcessEnv, ['IANCAR'],
      { gwsBin: () => 'gws', gcloudToken: async () => { throw new Error('GCLOUD_TOKEN_FAILED_TIMEOUT'); } });
    expect(missing).toContain('PREFLIGHT_GCLOUD_TOKEN_MISSING'); expect(missing).toContain('GCLOUD_TOKEN_FAILED_TIMEOUT');
  });
});

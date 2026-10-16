import { describe, expect, it } from 'vitest';
import { unattendedExitCode } from '../src/runtime/source-cycle-runtime.js';

// 2026-10-16 RP031 :05 단독 회차: 정시 회차가 쓰는 도중 LOCKED 로 건너뛰었는데 신선도 판정이 확정 전 상태 파일을 읽어 STALE → exit 1(오경보).
describe('무인 회차 종료 코드', () => {
  const code = (statuses: string[], freshnessStatus: string, requestRun = false) => unattendedExitCode({ statuses, freshnessStatus, requestRun });

  it('모든 원천이 LOCKED 이면 신선도 판정을 종료 코드에 쓰지 않는다(다른 회차가 판정한다)', () => {
    expect(code(['LOCKED'], 'UNHEALTHY')).toEqual({ exit: 0, freshnessSkipped: true });
    expect(code(['LOCKED', 'LOCKED'], 'UNHEALTHY')).toEqual({ exit: 0, freshnessSkipped: true });
    expect(code(['LOCKED'], 'HEALTHY')).toEqual({ exit: 0, freshnessSkipped: false });
  });

  it('LOCKED 와 다른 상태가 섞이면 종전과 같다(신선도 이상은 실패)', () => {
    expect(code(['LOCKED', 'APPLIED'], 'UNHEALTHY')).toEqual({ exit: 1, freshnessSkipped: false });
    expect(code(['APPLIED'], 'UNHEALTHY').exit).toBe(1);
    expect(code(['APPLIED'], 'HEALTHY').exit).toBe(0);
    expect(code([], 'UNHEALTHY').exit).toBe(1);   // 보고가 없으면 «모두 LOCKED» 가 아니다
  });

  it('HOLD·STOPPED·APPLY_UNCERTAIN 은 항상 1 — LOCKED 와 함께 있어도', () => {
    for (const status of ['HOLD', 'STOPPED', 'APPLY_UNCERTAIN']) {
      expect(code([status], 'HEALTHY').exit).toBe(1);
      expect(code(['LOCKED', status], 'HEALTHY').exit).toBe(1);
    }
  });

  it('즉시 실행 요청에서 LOCKED·UNCHANGED_SYNC 는 미실행이라 3, 신선도 이상이 있어도 LOCKED 전용이면 3', () => {
    expect(code(['LOCKED'], 'HEALTHY', true).exit).toBe(3);
    expect(code(['UNCHANGED_SYNC'], 'HEALTHY', true).exit).toBe(3);
    expect(code(['LOCKED'], 'UNHEALTHY', true)).toEqual({ exit: 3, freshnessSkipped: true });
    expect(code(['APPLIED', 'LOCKED'], 'HEALTHY', true).exit).toBe(3);
    expect(code(['APPLIED'], 'HEALTHY', true).exit).toBe(0);
    expect(code(['HOLD', 'LOCKED'], 'HEALTHY', true).exit).toBe(1);
  });
});

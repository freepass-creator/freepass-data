import { describe, expect, it, vi } from 'vitest';
import { ensureWriterLease } from '../src/runtime/ensure-writer-lease.js';

describe('ensureWriterLease', () => {
  it('기본 꺼짐이면 저장소를 읽지 않는다', async () => {
    const check = vi.fn();
    await expect(ensureWriterLease({}, 'photo', { check } as any)).resolves.toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('지정 레인을 보유하면 쓰기를 허용한다', async () => {
    const check = vi.fn(async () => ({ held: true, status: 'HELD', holder: 'PC1', epoch: 2, expiresAt: 'x' }));
    await expect(ensureWriterLease({ WRITER_LEASE_ENFORCE: '1', WRITER_LEASE_PC: 'PC1' }, 'photo', { check } as any)).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledWith('photo', 'PC1');
  });

  it.each([
    ['미보유', async () => ({ held: false, status: 'NOT_HELD', holder: 'PC3', expired: false })],
    ['읽기 실패', async () => { throw new Error('WRITER_LEASE_REQUEST_FAILED'); }],
  ])('%s이면 닫힌다', async (_label, check) => {
    await expect(ensureWriterLease({ WRITER_LEASE_ENFORCE: '1', WRITER_LEASE_PC: 'PC1' }, 'photo', { check } as any))
      .rejects.toThrow('WRITER_LEASE_NOT_HELD');
  });

  it('설정 오류도 닫힌다', async () => {
    await expect(ensureWriterLease({ WRITER_LEASE_ENFORCE: 'true' }, 'photo')).rejects.toThrow('WRITER_LEASE_NOT_HELD');
  });
});

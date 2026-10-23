import { leaseConfigFromEnv } from '../domain/writer-lease.js';
import { writerLeaseStore } from '../infra/writer-lease-firestore.js';

type LeaseChecker = Pick<ReturnType<typeof writerLeaseStore>, 'check'>;

/** runtimeCli 밖 쓰기 경로의 공용 관문. 기본은 꺼짐이며, 켜진 상태의 오류·미보유는 모두 닫힌다. */
export async function ensureWriterLease(
  env: NodeJS.ProcessEnv,
  laneOverride?: string,
  store?: LeaseChecker,
): Promise<void> {
  try {
    const config = leaseConfigFromEnv(laneOverride ? { ...env, WRITER_LEASE_LANE: laneOverride } : env);
    if (!config) return;
    const result = await (store ?? writerLeaseStore({ env })).check(config.lane, config.pc);
    if (!result.held) throw new Error('WRITER_LEASE_NOT_HELD');
  } catch (error) {
    if (error instanceof Error && error.message === 'WRITER_LEASE_NOT_HELD') throw error;
    throw new Error('WRITER_LEASE_NOT_HELD', { cause: error });
  }
}

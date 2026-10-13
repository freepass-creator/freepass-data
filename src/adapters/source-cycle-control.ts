import { mkdir, open, readFile, rename, unlink, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stableDigest } from '../shared/stable-digest.js';
import { emptyCycleState, type CycleControl, type CycleState } from '../ports/source-cycle.js';
import type { SourceIngestionStore } from '../ports/source-store.js';

const processAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }   // ESRCH(없음)만 죽은 프로세스
};
/** 소유 프로세스가 죽어 남은 잠금만 인계한다: 같은 PC 의 잠금 파일에 기록된 pid 가 없고(ESRCH) 잠금이 STALE_LOCK_MS 보다 오래됐을 때.
 * 강제 종료된 회차의 잠금이 남아 원천이 매 회차 «중복 회차 생략» 으로만 지나가던 사고(2026-10-13 RP030)를 막는다. 살아 있거나 판단할 수 없으면
 * (pid 재사용·읽기 실패·최근 잠금) 인계하지 않는다. 남의 잠금을 지우지 않고 증거를 남기며 한 이름으로 옮긴다. */
export const STALE_LOCK_MS = 10 * 60_000;
async function takeOverDeadLock(path: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
    const age = Date.now() - (await stat(path)).mtimeMs;
    if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || processAlive(owner.pid) || age < STALE_LOCK_MS) return false;
    await rename(path, `${path}.dead-pid-${owner.pid}-${Date.now()}`);
    return true;
  } catch { return false; }
}

/** Crash-safe local runner state. Lock is exclusive-create. A lock whose owner process is gone and old enough is taken over
 * (evidence file kept); every other existing lock leaves HOLD until an operator confirms. Never unlink a live owner's lock. */
export function fileCycleControl(directory: string, heartbeat: CycleControl['heartbeat']): CycleControl {
  const file = (source: string, suffix: string) => join(directory, `${stableDigest(source)}.${suffix}`);
  return {
    async acquire(source) {
      await mkdir(directory, { recursive: true });
      const path = file(source, 'lock'), token = randomUUID();
      let handle;
      try { handle = await open(path, 'wx', 0o600); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // 죽은 잠금 인계는 «전체 정시 예약» 하나만 한다: 단독 원천 예약(-Source)은 run-source-cycle.ps1 이 SOURCE_CYCLE_TAKEOVER=0 으로 호출해 인계하지 않는다.
        if (process.env.SOURCE_CYCLE_TAKEOVER === '0' || !(await takeOverDeadLock(path))) return null;
        try { handle = await open(path, 'wx', 0o600); }
        catch (e2) { if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return null; throw e2; }
      }
      try { await handle.writeFile(JSON.stringify({ token, pid: process.pid })); await handle.sync(); }
      finally { await handle.close(); }
      return async () => {
        const current = JSON.parse(await readFile(path, 'utf8')) as { token: string };
        if (current.token !== token) throw new Error('CYCLE_LOCK_OWNER_CHANGED');
        await unlink(path);
      };
    },
    async load(source) {
      try {
        const value = JSON.parse(await readFile(file(source, 'state.json'), 'utf8')) as CycleState;
        const nullableTime = (v: unknown) => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));
        if (!Number.isSafeInteger(value.failures) || value.failures < 0 || typeof value.stopped !== 'boolean' ||
            (value.failures >= 3 && !value.stopped) || !nullableTime(value.lastSyncedAt) || !nullableTime(value.lastAttemptAt) ||
            !nullableTime(value.lastCompleteAt) || !Number.isSafeInteger(value.readCount) || value.readCount < 0 ||
            !Number.isSafeInteger(value.heldCount) || value.heldCount < 0 ||
            !(value.error === null || typeof value.error === 'string')) throw new Error('CYCLE_STATE_INVALID');
        return value;
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyCycleState(); throw e; }
    },
    async save(source, state) {
      const target = file(source, 'state.json'), temp = `${target}.${randomUUID()}.tmp`;
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, target);
    },
    heartbeat,
    async alert(source, reason) {
      await appendFile(join(directory, 'alerts.jsonl'), JSON.stringify({ source, reason, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    },
  };
}

/** Append through the existing source-run lifecycle. A separate heartbeat scope cannot promote
 * the authoritative full-inventory head; decideSourceHead remains owned by SourceIngestionStore.
 * RAW records preserve the evidence used by the cycle. No new Firestore collection/client. */
export function sourceRunCycleHeartbeat(store: SourceIngestionStore): CycleControl['heartbeat'] {
  return async (sourceId, state, plan) => {
    const runSource = `${sourceId}:cycle-heartbeat`, runId = `cycle-${randomUUID()}`;
    const startedAt = state.lastAttemptAt!;
    const coverage = { mode: 'PARTIAL' as const, completeness: 'INCOMPLETE' as const, scope: 'cycle-heartbeat' };
    await store.upsertSource({ sourceId: runSource, kind: 'FILE', displayName: 'Source cycle heartbeat',
      authorityScope: ['cycle-heartbeat'], health: state.error ? 'ERROR' : 'HEALTHY', enabled: true });
    await store.beginRun({ runId, sourceId: runSource, status: 'RUNNING', startedAt, coverage,
      headStatus: 'PENDING', rawCount: 0, candidateCount: 0, warningCount: state.heldCount });
    let count = 0;
    for (const record of plan?.evidence.records ?? []) {
      await store.appendRaw({ rawRecordId: `${runId}:${count++}`, runId, sourceId: runSource,
        sourceRecordId: record.uid, sourceFingerprint: stableDigest(record), observedAt: record.observedAt,
        payload: { record } });
    }
    // Heartbeat state contains lastCompleteAt and errors even on unsuccessful cycles.
    await store.appendRaw({ rawRecordId: `${runId}:heartbeat`, runId, sourceId: runSource,
      sourceRecordId: 'heartbeat', sourceFingerprint: stableDigest(state), observedAt: startedAt,
      payload: { ...state } });
    if (state.error) await store.failRun({ runId, completedAt: startedAt, error: state.error });
    else await store.completeRun({ runId, completedAt: startedAt, observedAt: startedAt,
      checkpoint: { sourceId: runSource, observedAt: startedAt }, coverage,
      rawCount: count + 1, candidateCount: 0, lineageCount: 0, warningCount: state.heldCount });
  };
}

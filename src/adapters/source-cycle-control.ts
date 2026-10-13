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
  // 인계 자체를 한 번에 한 회차만 하도록 배타 생성되는 인계 표식 파일을 둔다. 표식을 쥔 동안에만 잠금을 읽고 옮기므로, 여러 회차가
  // 같은 죽은 잠금을 두고 경쟁해도 «다른 회차의 살아 있는 새 잠금»을 옮기거나 지우는 일이 없다(검사와 이동 사이의 경쟁 제거).
  // 표식을 못 얻으면 이번 회차는 인계하지 않는다(HOLD). 크래시로 남은 낡은 표식은 한 번 치우고 다음 회차에 다시 시도한다.
  // 표식에는 소유 pid·토큰을 쓰고, 지우기·이동 직전에 «내 표식인지» 내용을 다시 확인한다(비교 후 삭제). 낡은 표식은 나이만 보지 않고
  // 소유 프로세스가 죽었을 때만 치운다(멈췄다 재개하는 살아 있는 소유자의 표식을 지우지 않는다).
  const guard = `${path}.takeover`, token = randomUUID(), mine = JSON.stringify({ token, pid: process.pid });
  const readGuard = () => readFile(guard, 'utf8').catch(() => null);
  const lockAgeMs = async (file: string) => stat(file).then(s => Date.now() - s.mtimeMs, () => 0);
  let handle;
  try { handle = await open(guard, 'wx', 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      const raw = await readGuard();
      let ownerPid: number | null = null;
      try { const p = (JSON.parse(raw ?? '') as { pid?: unknown }).pid; ownerPid = typeof p === 'number' && Number.isSafeInteger(p) && p > 0 ? p : null; } catch { ownerPid = null; }
      // 소유자가 죽었거나(pid 없음 = 쓰기 전 종료한 빈 표식) 오래된 경우에만, 같은 내용일 때 한 번 치운다.
      if ((ownerPid === null || !processAlive(ownerPid)) && (await lockAgeMs(guard)) > STALE_LOCK_MS && (await readGuard()) === raw) await unlink(guard).catch(() => undefined);
    }
    return false;
  }
  try {
    await handle.writeFile(mine); await handle.close();
    const raw = await readFile(path, 'utf8');
    const age = await lockAgeMs(path);
    // 소유 정보를 쓰기 전에 종료해 비어 있는 잠금은 오래되면 죽은 잠금이다(쓰기는 생성 직후 수 ms 안에 끝난다).
    let tag: string;
    if (raw === '') { if (age < STALE_LOCK_MS) return false; tag = 'dead-empty'; }
    else {
      const owner = JSON.parse(raw) as { pid?: unknown };
      if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || processAlive(owner.pid) || age < STALE_LOCK_MS) return false;
      tag = `dead-pid-${owner.pid}`;
    }
    if ((await readGuard()) !== mine || (await readFile(path, 'utf8')) !== raw) return false;   // 이동 직전 재확인
    await rename(path, `${path}.${tag}-${Date.now()}`);
    return true;
  } catch { return false; }
  finally { if ((await readGuard()) === mine) await unlink(guard).catch(() => undefined); }
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
        if (!(await takeOverDeadLock(path))) return null;
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

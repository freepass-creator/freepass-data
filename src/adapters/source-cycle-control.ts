import { mkdir, open, readdir, readFile, rename, unlink, appendFile, stat, link } from 'node:fs/promises';
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
async function takeOverDeadLock(path: string, note?: (reason: string) => Promise<void>): Promise<boolean> {
  // 파일 시스템만으로 «검사 후 이동» 을 원자적으로 만들 수 없다(Codex 독립 검토가 비원자 구간을 계속 지적). 그래서 경쟁 자체를 없앤다:
  // 인계는 무인 예약 회차(SOURCE_CYCLE_UNATTENDED=1, 작업 스케줄러가 한 번에 한 인스턴스만 실행) 하나만 하고, 수동 실행은 죽은 잠금을 만나면
  // 인계하지 않고 보류+알림만 한다. 인계자가 하나뿐이면 두 인계자의 경쟁(검사~이동 사이 끼어들기)이 성립하지 않는다.
  // 죽은 잠금: 소유 pid 가 없고(ESRCH) STALE_LOCK_MS 이상 오래됐거나, 소유 정보가 비어 있거나 읽을 수 없고 STALE_LOCK_MS 이상 오래된 잠금.
  // 새 잠금은 소유 정보가 이미 든 파일로만 생긴다(임시 파일에 쓰고 link). «빈 잠금»은 예전 엔진이 남긴 것뿐이다.
  // pid 재사용으로 무관한 프로세스가 살아 있어도 STALE_LOCK_MS 의 36배(6시간)가 지나면 죽은 잠금으로 본다(회차가 6시간 도는 일은 없다).
  try {
    const before = await stat(path), raw = await readFile(path, 'utf8');
    const age = Date.now() - before.mtimeMs;
    if (age < STALE_LOCK_MS) return false;
    let tag = 'dead-unreadable';
    try {
      const owner = JSON.parse(raw) as { pid?: unknown };
      if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        if (processAlive(owner.pid) && age < STALE_LOCK_MS * 36) return false;
        tag = processAlive(owner.pid) ? `dead-stale-pid-${owner.pid}` : `dead-pid-${owner.pid}`;
      }
    } catch { /* 레거시 빈 잠금·손상 잠금은 오래되면 죽은 잠금으로 본다 */ }
    // 이동 직전 같은 파일인지(mtime·크기·내용) 한 번 더 확인한다.
    const again = await stat(path);
    if (again.mtimeMs !== before.mtimeMs || again.size !== before.size || (await readFile(path, 'utf8')) !== raw) return false;
    await rename(path, `${path}.${tag}-${Date.now()}`);
    // 6시간 넘게 정지한 «살아 있어 보이는» 소유자(pid 재사용이거나 멈춘 수동 실행)를 인계한 경우 소유권 재확인이 없으므로 알림으로 남긴다.
    if (tag.startsWith('dead-stale-pid-')) await note?.(`DEAD_LOCK_STALE_PID:${tag.slice('dead-stale-pid-'.length)}`).catch(() => undefined);
    return true;
  } catch (e) {
    // 잠금이 그 사이 사라졌으면 정상(인계할 것이 없다). 그 밖의 파일 오류는 «죽은 잠금 보류» 와 구분되는 알림을 남긴다.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') await note?.(`LOCK_IO_ERROR:${(e as NodeJS.ErrnoException).code ?? 'UNKNOWN'}`).catch(() => undefined);
    return false;
  }
}
/** 인계 가능한 죽은 잠금인지(수동 실행이 보류+알림만 하기 위한 판정). */
async function deadLockPresent(path: string, onIoError?: (code: string) => Promise<void>): Promise<boolean> {
  try {
    const raw = await readFile(path, 'utf8');
    const age = Date.now() - (await stat(path)).mtimeMs;
    if (age < STALE_LOCK_MS) return false;
    try {
      const p = (JSON.parse(raw) as { pid?: unknown }).pid;
      return !(typeof p === 'number' && p > 0 && processAlive(p)) || age >= STALE_LOCK_MS * 36;
    } catch { return true; }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') await onIoError?.((e as NodeJS.ErrnoException).code ?? 'UNKNOWN').catch(() => undefined);
    return false;
  }
}
/** 소유 정보가 이미 든 잠금을 한 번에 만든다: 임시 파일에 쓰고 fsync 한 뒤 link(이미 있으면 EEXIST). 빈 잠금 구간이 없다. */
async function createLock(path: string, token: string): Promise<boolean> {
  const temp = `${path}.${randomUUID()}.tmp`;
  // 임시 파일은 어떤 실패 경로에서도 지운다(강제 종료로 남는 것은 acquire 진입 때 오래된 .tmp 를 치운다).
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() })); await handle.sync(); }
    finally { await handle.close(); }
    await link(temp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally { await unlink(temp).catch(() => undefined); }
}
/** 강제 종료로 남은 오래된 임시 파일(.tmp)을 치운다(best-effort, 교착은 아니고 누수 방지). */
async function sweepStaleTemps(directory: string, base: string): Promise<void> {
  try {
    for (const name of await readdir(directory)) {
      if (!name.startsWith(`${base}.`) || !name.endsWith('.tmp')) continue;
      const age = await stat(join(directory, name)).then(s => Date.now() - s.mtimeMs, () => 0);
      if (age >= STALE_LOCK_MS) await unlink(join(directory, name)).catch(() => undefined);
    }
  } catch { /* best-effort */ }
}

/** Crash-safe local runner state. Lock is exclusive-create. A lock whose owner process is gone and old enough is taken over
 * (evidence file kept); every other existing lock leaves HOLD until an operator confirms. Never unlink a live owner's lock. */
export function fileCycleControl(directory: string, heartbeat: CycleControl['heartbeat'],
  options: { takeOverDeadLocks?: boolean } = {}): CycleControl {
  const file = (source: string, suffix: string) => join(directory, `${stableDigest(source)}.${suffix}`);
  return {
    async acquire(source) {
      await mkdir(directory, { recursive: true });
      const path = file(source, 'lock'), token = randomUUID();
      const note = (reason: string) => appendFile(join(directory, 'alerts.jsonl'), JSON.stringify({ source, reason, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
      // 잠금 파일 입출력 오류는 «죽은 잠금 보류» 와 구분되는 알림을 남긴 뒤 그대로 전파한다(잠금 없이 실행하는 경로는 없다).
      const tryCreate = async () => {
        try { return await createLock(path, token); }
        catch (e) { await note(`LOCK_IO_ERROR:${(e as NodeJS.ErrnoException).code ?? 'UNKNOWN'}`).catch(() => undefined); throw e; }
      };
      await sweepStaleTemps(directory, path.split(/[\\/]/).at(-1)!);
      if (!(await tryCreate())) {
        if (!options.takeOverDeadLocks) {
          // 수동 실행: 죽은 잠금은 인계하지 않는다. 사람이 볼 수 있게 알림만 남기고 보류한다.
          if (await deadLockPresent(path, code => note(`LOCK_IO_ERROR:${code}`))) await note('DEAD_LOCK_HELD');
          return null;
        }
        if (!(await takeOverDeadLock(path, reason => note(reason)))) return null;
        if (!(await tryCreate())) return null;
      }
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

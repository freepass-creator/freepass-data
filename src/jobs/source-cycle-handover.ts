/**
 * 원천 쓰기 소유권 넘김(B3Q ↔ ACTIONS) — Codex P1-①③(2026-10-14).
 * 이 도구만 소유권 문서를 바꾼다. 반드시 B3Q(파일 상태가 있는 PC)에서 돌린다.
 *   SOURCE=RP031 TO=ACTIONS npm run source-cycle:handover            # 계획(DRY_RUN): 확인 결과와 계획 digest 출력, 쓰기 0
 *   SOURCE=RP031 TO=ACTIONS AUTHORIZE_SOURCE_CYCLE_HANDOVER=<digest> npm run source-cycle:handover -- --apply
 * 넘기기 전 «이전 실행 완료» 확인: 파일 잠금 없음 · Firestore 잠금 없음/해제 · 넘겨주는 쪽 상태가 APPLY_UNCERTAIN 아님.
 * 함께 옮기는 것: 회차 상태(정지·실패 횟수 포함) · 원천별 기준 건수 · 한 회차 한정 표식. 받는 쪽에 다른 값이 있으면 멈춘다(덮어쓰지 않음).
 * 소유권은 읽은 버전일 때만(updateTime 조건부) 바꾼다. 삭제 없음.
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileCycleControl } from '../adapters/source-cycle-control.js';
import { controlStore, firestoreCycleControl, readCycleWriter, setCycleWriter, CYCLE_WRITERS, type ControlStoreOptions, type CycleWriter } from '../infra/source-cycle-control-firestore.js';
import { fileRunnerFiles, firestoreRunnerFiles, type RunnerFiles } from '../infra/runner-files.js';
import { emptyCycleState, type CycleState } from '../ports/source-cycle.js';
import { stableDigest } from '../shared/stable-digest.js';

/** 원천별로 실행기가 남기는 상태 파일(기준 건수·한 회차 표식). 새 파일을 추가하면 여기에도 추가한다(넘김 시 이관 대상). */
export const RUNNER_FILES_BY_SOURCE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  RP012: ['sonogong-api-count.json', 'sonogong-api-pass.json', 'sonogong-enroll-cap-once.done', 'sonogong-replace-once.done'],
  RP006: ['iron-homepage-count.json'],
  RP023: ['autoplus-sheet-count.json', 'autoplus-sitemap-count.json'],
});

type StateStore = { load(source: string): Promise<CycleState>; save(source: string, state: CycleState): Promise<void> };
type Side = { state: StateStore; files: RunnerFiles };

export async function runHandover(input: {
  source: string; to: CycleWriter; apply: boolean; approval?: string; directory: string; store: ControlStoreOptions;
}) {
  if (!/^(RP\d{3}|PT-\d{4})$/.test(input.source)) throw new Error('SOURCE_CODE_INVALID');
  if (!CYCLE_WRITERS.includes(input.to)) throw new Error('HANDOVER_TARGET_INVALID');
  const store = controlStore(input.store);
  const noop = async () => undefined;
  const file: Side = { state: fileCycleControl(input.directory, noop), files: fileRunnerFiles(input.directory) };
  const online: Side = { state: firestoreCycleControl({ ...input.store, heartbeat: noop }), files: firestoreRunnerFiles(input.store) };
  const current = await readCycleWriter(store, input.source);
  if (current.writer === 'UNKNOWN') throw new Error('HANDOVER_OWNER_UNKNOWN');
  if (current.writer === input.to) return { status: 'NO_CHANGE' as const, source: input.source, writer: current.writer };
  const [from, to] = current.writer === 'B3Q' ? [file, online] : [online, file];

  // 이전 실행 완료 확인
  const blockers: string[] = [];
  const fileLock = join(input.directory, `${stableDigest(input.source)}.lock`);
  if (await stat(fileLock).then(() => true, e => (e as NodeJS.ErrnoException).code !== 'ENOENT')) blockers.push('FILE_LOCK_PRESENT');
  const lock = await store.get(store.id('lock', input.source));
  if (lock && store.fields(lock).status !== 'RELEASED') blockers.push('ONLINE_LOCK_PRESENT');
  const state = await from.state.load(input.source);
  if (state.error === 'APPLY_UNCERTAIN') blockers.push('PRIOR_APPLY_UNCERTAIN');

  // 이관 계획(받는 쪽에 다른 값이 있으면 멈춘다)
  const targetState = await to.state.load(input.source);
  const emptyDigest = stableDigest(emptyCycleState());
  if (stableDigest(targetState) !== emptyDigest && stableDigest(targetState) !== stableDigest(state)) blockers.push('TARGET_STATE_CONFLICT');
  const files: Array<{ name: string; text: string }> = [];
  for (const name of RUNNER_FILES_BY_SOURCE[input.source] ?? []) {
    const text = await from.files.read(name);
    if (text === null) continue;
    const existing = await to.files.read(name);
    if (existing !== null && existing !== text) blockers.push(`TARGET_FILE_CONFLICT:${name}`);
    else if (existing === null) files.push({ name, text });
  }
  const plan = { source: input.source, from: current.writer, to: input.to, stateDigest: stableDigest(state),
    stateStopped: state.stopped, stateFailures: state.failures, files: files.map(f => ({ name: f.name, digest: stableDigest(f.text) })), blockers };
  const planDigest = stableDigest(plan);
  if (!input.apply || blockers.length) return { status: blockers.length ? 'HOLD' as const : 'DRY_RUN' as const, planDigest, ...plan };
  if (input.approval !== planDigest) throw new Error('HANDOVER_APPROVAL_REQUIRED');

  // 적용: 상태·파일을 먼저 옮기고(되읽기 확인) 마지막에 소유권을 바꾼다 — 중간 실패면 소유권은 그대로라 이중 쓰기가 생기지 않는다.
  if (stableDigest(targetState) === emptyDigest && stableDigest(state) !== emptyDigest) await to.state.save(input.source, state);
  if (stableDigest(await to.state.load(input.source)) !== stableDigest(state) && stableDigest(state) !== emptyDigest) throw new Error('HANDOVER_STATE_READBACK_MISMATCH');
  for (const f of files) {
    if (!(await to.files.write(f.name, f.text)) || (await to.files.read(f.name)) !== f.text) throw new Error(`HANDOVER_FILE_READBACK_MISMATCH:${f.name}`);
  }
  if (!(await setCycleWriter(store, input.source, current, input.to, { handedOverFrom: current.writer, stateDigest: plan.stateDigest, planDigest }))) {
    throw new Error('HANDOVER_OWNER_CHANGED');
  }
  if ((await readCycleWriter(store, input.source)).writer !== input.to) throw new Error('HANDOVER_OWNER_READBACK_MISMATCH');
  return { status: 'HANDED_OVER' as const, planDigest, ...plan };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  runHandover({ source: env.SOURCE?.trim() ?? '', to: (env.TO?.trim() ?? '') as CycleWriter, apply: process.argv.includes('--apply'),
    ...(env.AUTHORIZE_SOURCE_CYCLE_HANDOVER ? { approval: env.AUTHORIZE_SOURCE_CYCLE_HANDOVER } : {}),
    directory: env.SOURCE_CYCLE_PRIVATE_DIR || join(homedir(), '.codex', 'private', 'source-cycle'), store: { env } })
    .then(r => { console.log(JSON.stringify(r, null, 2)); if (r.status === 'HOLD') process.exitCode = 1; })
    .catch(e => { console.error(e instanceof Error && /^[A-Z][A-Z0-9_:.-]+$/.test(e.message) ? e.message : 'HANDOVER_FAILED'); process.exitCode = 1; });
}

import { pathToFileURL } from 'node:url';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { planSourceCycle, applySourceCycle, deepEqual, type CycleCommands, type CyclePlan, type CycleControl, type CycleProduct } from '../application/source-cycle.js';
import { sourceCyclePlugin, type CyclePlugin, type CycleCapture, type CycleSourceDefinition } from '../adapters/source-cycle-plugins.js';
import { fileCycleControl } from '../adapters/source-cycle-control.js';

export async function runSourceCycle<T>(plugin: CyclePlugin<T>, commands: CycleCommands, control: CycleControl,
  options: { apply?: boolean; digest?: string; approval?: string; approvedPlan?: CyclePlan; onlyWhenSynced?: boolean; now?: () => number } = {}) {
  const release = await control.acquire(plugin.sourceId);
  if (!release) return { status: 'LOCKED', writes: 0, summary: '원천 잠금: 중복 회차 생략' };
  const clock = options.now ?? Date.now;
  try {
    const state = await control.load(plugin.sourceId);
    if (state.stopped) return { status: 'STOPPED', writes: 0, summary: '연속 실패 3회: 수동 원인 확인 필요' };
    const previousFailures = state.failures;
    let plan: CyclePlan | null = null;
    let outcome: Awaited<ReturnType<typeof applySourceCycle>> | null = null;
    let summary = '';
    state.lastAttemptAt = new Date(clock()).toISOString();
    state.readCount = 0; state.heldCount = 0;
    try {
      let synced: string | null = null;
      if (options.onlyWhenSynced) {
        if (plugin.family !== 'IANCAR' || !plugin.syncedAt) throw new Error('SYNC_PROBE_UNAVAILABLE');
        synced = await plugin.syncedAt();
        if (!synced || !Number.isFinite(Date.parse(synced)) || Date.parse(synced) > clock()) throw new Error('SYNC_PROBE_INVALID');
        if (synced === state.lastSyncedAt) {
          state.error = null;
          await control.save(plugin.sourceId, state);
          await control.heartbeat(plugin.sourceId, state, null);
          return { status: 'UNCHANGED_SYNC', writes: 0, summary: 'synced_at 동일: 원천 수집 생략' };
        }
        if (state.lastSyncedAt && Date.parse(synced) < Date.parse(state.lastSyncedAt)) throw new Error('SYNC_REGRESSED');
      }
      const read = await plugin.read();
      if (read.raw === null && read.error) throw new Error(read.error);
      if (synced && plugin.syncedAtOfRead?.(read) !== synced) throw new Error('SYNC_CHANGED_DURING_READ');
      const converted = plugin.toRecords(read);
      state.readCount = converted.records.length; state.heldCount = converted.held.length;
      const built = planSourceCycle(plugin, { records: converted.records, complete: read.complete && !read.error,
        observedAt: read.observedAt, heldCount: converted.held.length }, await commands.list(plugin.sourceId), options.approvedPlan?.plannedAt ?? clock());
      plan = built.plan;
      state.heldCount = plan.held;
      if (options.approvedPlan && !deepEqual(plan, options.approvedPlan)) throw new Error('CYCLE_REPLAN_REQUIRED');
      if (plan.blockers.length) throw new Error(plan.blockers.join(','));
      const applied = await applySourceCycle(commands, plan, { ...options, now: clock() });
      outcome = applied;
      const counts = (kind: string) => plan!.entries.filter(e => e.kind === kind).length;
      summary = `원천 ${plan.sourceCount} → 노출 ${plan.exposedBefore - counts('DOWNGRADE') + counts('ENROLL') + counts('REEXPOSE')} (계획), 하향 ${counts('DOWNGRADE')}·편입 ${counts('ENROLL')}·재노출 ${counts('REEXPOSE')}·갱신 ${counts('UPDATE')}, 되읽기 ${options.apply ? `${applied.verified}/${plan.entries.length}` : '미실행'} (${applied.status})`;
      if (applied.status === 'APPLY_UNCERTAIN') throw new Error('APPLY_UNCERTAIN');
      if (!read.complete || read.error) throw new Error('SOURCE_INCOMPLETE');
      state.failures = 0; state.error = null; state.lastCompleteAt = read.observedAt;
      // A dry-run must never consume the change token for a later authorized apply.
      if (options.apply && !plan.held) state.lastSyncedAt = synced;
      await control.save(plugin.sourceId, state);
      await control.heartbeat(plugin.sourceId, state, plan);
      return { ...applied, planDigest: built.digest, summary, plan };
    } catch (e) {
      // Only internal safe codes reach logs; no provider response bodies or customer raw data.
      const candidate = e instanceof Error ? e.message : '';
      const reason = /^[A-Z_,]+$/.test(candidate) ? candidate : 'CYCLE_ERROR';
      state.failures = previousFailures + 1; state.stopped = state.failures >= 3; state.error = reason;
      await control.save(plugin.sourceId, state);
      try { await control.heartbeat(plugin.sourceId, state, plan); }
      catch { await control.alert(plugin.sourceId, 'HEARTBEAT_UNAVAILABLE'); }
      await control.alert(plugin.sourceId, state.stopped ? `STOPPED:${reason}` : reason);
      return { status: state.stopped ? 'STOPPED' : reason === 'APPLY_UNCERTAIN' ? 'APPLY_UNCERTAIN' : 'HOLD',
        writes: outcome?.writes ?? (options.apply ? null : 0), verified: outcome?.verified ?? 0,
        summary: `${summary ? summary + ' · ' : ''}회차 보류 ${reason} (연속 ${state.failures})`, plan };
    }
  } finally { await release(); }
}

/** The scheduler loads a reviewed local runtime composition. No default credentials, target,
 * production adapter or automatic approval. The runtime uses existing read collectors and CatalogStore. */
export async function sourceCycleCli(argv: string[]) {
  if (argv.includes('--apply')) throw new Error('SCHEDULED_APPLY_NOT_AUTHORIZED');
  const index = argv.indexOf('--runtime');
  const snapshotIndex = argv.indexOf('--snapshot'), stateIndex = argv.indexOf('--state-dir');
  let runtime: { plugins: CyclePlugin[]; commands: CycleCommands; control: CycleControl };
  if (snapshotIndex >= 0 && index < 0 && argv[snapshotIndex + 1] && stateIndex >= 0 && argv[stateIndex + 1]) {
    const snapshot = JSON.parse(await readFile(resolve(argv[snapshotIndex + 1]!), 'utf8')) as {
      sources: Array<{ definition: CycleSourceDefinition; capture: CycleCapture }>; products: CycleProduct[]; catalogComplete: boolean;
    };
    const directory = resolve(argv[stateIndex + 1]!);
    const noWrite = async (): Promise<never> => { throw new Error('OFFLINE_PRODUCT_WRITE_FORBIDDEN'); };
    runtime = { plugins: snapshot.sources.map(s => sourceCyclePlugin(s.definition, async () => s.capture)),
      commands: { async list(source) { return { complete: snapshot.catalogComplete === true,
        products: snapshot.products.filter(p => p.record.sourceId === source) }; },
      async read(source, uid) { return snapshot.products.find(p => p.record.sourceId === source && p.record.uid === uid) ?? null; },
      backup: noWrite, readBackup: noWrite, compareAndApply: noWrite },
      control: fileCycleControl(directory, async (source, state) => {
        await appendFile(join(directory, 'offline-heartbeats.jsonl'), JSON.stringify({ source, ...state }) + '\n', { mode: 0o600 });
      }) };
  } else {
    if (index < 0 || !argv[index + 1] || snapshotIndex >= 0) throw new Error('CYCLE_RUNTIME_REQUIRED');
    const runtimePath = resolve(argv[index + 1]!);
    // Runtime is trusted local composition code, never an untrusted provider data file.
    await readFile(runtimePath);
    runtime = await import(pathToFileURL(runtimePath).href) as typeof runtime;
  }
  const sourceIndex = argv.indexOf('--source');
  const selected = sourceIndex >= 0 ? runtime.plugins.filter(p => p.sourceId === argv[sourceIndex + 1]) : runtime.plugins;
  if (!selected.length || new Set(selected.map(p => p.sourceId)).size !== selected.length) throw new Error('CYCLE_SOURCE_CONFIG_INVALID');
  let failed = false;
  for (const plugin of selected) {
    const result = await runSourceCycle(plugin, runtime.commands, runtime.control,
      { onlyWhenSynced: argv.includes('--only-when-synced') && plugin.family === 'IANCAR' });
    console.log(JSON.stringify({ source: plugin.sourceId, status: result.status, summary: result.summary,
      digest: 'planDigest' in result ? result.planDigest : null }));
    if (['HOLD', 'STOPPED', 'APPLY_UNCERTAIN'].includes(result.status)) failed = true;
  }
  return failed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sourceCycleCli(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    console.error('SOURCE_CYCLE_CLI_HOLD'); process.exitCode = 1;
  });
}

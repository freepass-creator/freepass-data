import { pathToFileURL } from 'node:url';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { planSourceCycle, applySourceCycle, deepEqual, type CycleCommands, type CyclePlan, type CycleControl, type CycleProduct } from '../application/source-cycle.js';
import { sourceCyclePlugin, type CyclePlugin, type CycleCapture, type CycleSourceDefinition } from '../adapters/source-cycle-plugins.js';
import { fileCycleControl } from '../adapters/source-cycle-control.js';

export async function runSourceCycle<T>(plugin: CyclePlugin<T>, commands: CycleCommands, control: CycleControl,
  options: { apply?: boolean; digest?: string; approval?: string; approvedPlan?: CyclePlan; onlyWhenSynced?: boolean; now?: () => number;
    /** 같은 회차에서 방금 읽어 세운 계획을 바로 적용한다(무인 회차 전용). 사람이 검토한 계획 파일 승인 경로(approvedPlan)와 섞지 않는다. */
    autoApprove?: boolean } = {}) {
  const release = await control.acquire(plugin.sourceId);
  if (!release) return { status: 'LOCKED', writes: 0, summary: '원천 잠금: 중복 회차 생략' };
  const clock = options.now ?? Date.now;
  try {
    const state = await control.load(plugin.sourceId);
    if (state.stopped) return { status: 'STOPPED', writes: 0, summary: '연속 실패 3회: 수동 원인 확인 필요' };
    const previousFailures = state.failures;
    let plan: CyclePlan | null = null;
    let outcome: Awaited<ReturnType<typeof applySourceCycle>> | null = null;
    let inlineStarted = false;
    let readDetail: string | null = null;   // 읽기가 불완전했을 때의 안전한 세부 코드(알림·요약에 남긴다)
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
      // 읽기 자체가 던진 실패는 detail 이 사유 코드에 이미 합쳐진다. 읽기는 됐지만 불완전한 경우에만 별도로 남긴다.
      readDetail = read.raw !== null && !read.complete && read.detail ? read.detail : null;
      if (read.raw === null && read.error) throw new Error(read.detail ? `${read.error}_${read.detail}` : read.error);
      if (!read.complete && read.detail === 'UPSTREAM_STALE') {
        // 상류 원천(공급사)이 갱신되지 않은 것이다 — 우리 쪽 실패가 아니므로 연속 실패로 세거나 정지하지 않는다(정지하면 공급사가 다시
        // 갱신해도 사람이 풀어야 한다). 쓰기 0, 신선도는 ERROR 로 남아 보이고, 같은 사유의 알림은 한 번만 남긴다.
        const alreadyKnown = state.error === 'UPSTREAM_STALE';
        state.error = 'UPSTREAM_STALE';
        await control.save(plugin.sourceId, state);
        await control.heartbeat(plugin.sourceId, state, null);
        if (!alreadyKnown) await control.alert(plugin.sourceId, 'UPSTREAM_STALE');
        return { status: 'HOLD', writes: 0, verified: 0, plan: null,
          summary: '상류 원천 갱신 정지(UPSTREAM_STALE): 쓰기 0, 연속 실패로 세지 않음' };
      }
      if (synced && plugin.syncedAtOfRead?.(read) !== synced) throw new Error('SYNC_CHANGED_DURING_READ');
      const converted = plugin.toRecords(read);
      state.readCount = converted.records.length; state.heldCount = converted.held.length;
      state.observationOnlyCount = plugin.observationCountOfRead?.(read) ?? 0;
      const unassigned = converted.held.filter(h => h.reasons.some(r => r.includes('UID_REQUIRED'))).length;
      state.unassignedPlateCount = unassigned;
      state.observedSellableCount = converted.records.filter(r => r.status.saleAvailable === true).length;
      if (plugin.observationOnly) {
        if (!read.complete || read.error) throw new Error('SOURCE_INCOMPLETE');
        state.failures = 0; state.error = null; state.lastCompleteAt = read.observedAt;
        await control.save(plugin.sourceId, state);
        await control.heartbeat(plugin.sourceId, state, null);
        return { status: 'OBSERVED', writes: 0, summary: `관측 전용 원천 ${converted.records.filter(r => r.status.saleAvailable === true).length} · 번호미배정 ${unassigned} · 상품 쓰기 0` };
      }
      if (options.approvedPlan) {
        // A fresh transport read naturally has a new observation clock. Pin approved facts,
        // not a stale transport snapshot: only clocks may differ, source synced_at is retained.
        const prior = options.approvedPlan.evidence;
        const withoutReadClock = (v: unknown): unknown => Array.isArray(v) ? v.map(withoutReadClock) :
          v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'observedAt' && k !== 'captured_at')
            .map(([k, child]) => [k, withoutReadClock(child)])) : v;
        if (!read.observedAt || Date.parse(read.observedAt) < Date.parse(prior.observedAt ?? '') || Date.parse(read.observedAt) > clock() ||
          !deepEqual(withoutReadClock(converted.records), withoutReadClock(prior.records)) || converted.held.length !== prior.heldCount ||
          unassigned !== (prior.unassignedPlateCount ?? 0) ||
          (read.complete && !read.error) !== prior.complete) throw new Error('CYCLE_REPLAN_REQUIRED');
        converted.records = structuredClone(prior.records);
        read.observedAt = prior.observedAt;
      }
      const built = planSourceCycle(plugin, { records: converted.records, complete: read.complete && !read.error,
        observedAt: read.observedAt, heldCount: converted.held.length,
        ...(unassigned ? { unassignedPlateCount: unassigned } : {}) }, await commands.list(plugin.sourceId), options.approvedPlan?.plannedAt ?? clock());
      plan = built.plan;
      state.heldCount = plan.held;
      if (options.approvedPlan && !deepEqual(plan, options.approvedPlan)) throw new Error('CYCLE_REPLAN_REQUIRED');
      if (plan.blockers.length) throw new Error(plan.blockers.join(','));
      // 무인 회차(autoApprove): 방금 읽은 계획을 그대로 적용한다. 같은 회차라 사람의 지연이 없고, 문서별 CAS·백업·되읽기가 막아 주므로
      // 승인 계획 재검증용 «두 번째 읽기»가 필요 없다 — 읽기가 긴 원천(이안카 약 5분)은 두 읽기 사이에 원천이 바뀌어 매번 중단되던 문제.
      const inline = options.autoApprove === true && !options.approvedPlan && plan.entries.length > 0;
      const applying = options.apply === true || inline;
      inlineStarted = inline;
      const applied = await applySourceCycle(commands, plan, inline
        ? { apply: true, digest: built.digest, approval: built.digest, now: clock() } : { ...options, now: clock() });
      outcome = applied;
      const counts = (kind: string) => plan!.entries.filter(e => e.kind === kind).length;
      summary = `원천 ${plan.sourceCount} → 노출 ${plan.exposedBefore - counts('DOWNGRADE') + counts('ENROLL') + counts('REEXPOSE')} (계획), 하향 ${counts('DOWNGRADE')}·편입 ${counts('ENROLL')}·재노출 ${counts('REEXPOSE')}·갱신 ${counts('UPDATE')}, 되읽기 ${applying ? `${applied.verified}/${plan.entries.length}` : '미실행'} (${applied.status})`;
      if (applied.status === 'APPLY_UNCERTAIN') throw new Error('APPLY_UNCERTAIN');
      summary += ` · 번호미배정 ${unassigned}`;
      if (plan.warnings.length) summary += ` · ${plan.warnings.join(',')}`;
      if (plugin.family === 'AICA') {
        const monthly = converted.records.filter(r => r.raw.product_group === 'MONTHLY_RENT' && r.status.saleAvailable === true).length;
        summary += ` · 장기 ${state.observedSellableCount - monthly} · 월렌트 ${monthly}`;
      }
      if (!read.complete || read.error) throw new Error('SOURCE_INCOMPLETE');
      state.failures = 0; state.error = null; state.lastCompleteAt = read.observedAt;
      // A dry-run must never consume the change token for a later authorized apply.
      if (applying && !plan.held) state.lastSyncedAt = synced;
      await control.save(plugin.sourceId, state);
      await control.heartbeat(plugin.sourceId, state, plan);
      return { ...applied, planDigest: built.digest, summary, plan };
    } catch (e) {
      // Only internal safe codes reach logs; no provider response bodies or customer raw data.
      const candidate = e instanceof Error ? e.message : '';
      const reason = /^[A-Z0-9_,]+$/.test(candidate) ? candidate : 'CYCLE_ERROR';
      state.failures = previousFailures + 1; state.stopped = state.failures >= 3; state.error = reason;
      await control.save(plugin.sourceId, state);
      try { await control.heartbeat(plugin.sourceId, state, plan); }
      catch { await control.alert(plugin.sourceId, 'HEARTBEAT_UNAVAILABLE'); }
      await control.alert(plugin.sourceId, state.stopped ? `STOPPED:${reason}` : reason);
      if (readDetail) await control.alert(plugin.sourceId, `INCOMPLETE_${readDetail}`);
      return { status: state.stopped ? 'STOPPED' : reason === 'APPLY_UNCERTAIN' ? 'APPLY_UNCERTAIN' : 'HOLD',
        writes: outcome?.writes ?? (options.apply || inlineStarted ? null : 0), verified: outcome?.verified ?? 0,
        summary: `${summary ? summary + ' · ' : ''}회차 보류 ${reason}${readDetail ? ` · 불완전 사유 ${readDetail}` : ''} (연속 ${state.failures})`, plan };
    }
  } finally { await release(); }
}

/** 무인 회차(대표 2026-10-13 「1시간 간격으로 업데이트 되는지 개발피시 돌아갈수 있게끔」): 한 번 읽어 계획을 세우고 변경이 있으면
 * 그 계획을 바로 적용한다. blockers(하향 비율 상한·원천/카탈로그 불완전·STALE)·문서별 CAS·백업·되읽기·3회 실패 정지가 그대로
 * 유지된다. 관측 전용 원천은 OBSERVED 로 끝나고 쓰지 않는다. 변경이 없으면 적용하지 않는다(stage PLAN). */
export async function runUnattendedSourceCycle<T>(plugin: CyclePlugin<T>, commands: CycleCommands, control: CycleControl,
  options: { onlyWhenSynced?: boolean; now?: () => number } = {}) {
  const result = await runSourceCycle(plugin, commands, control, { ...options, autoApprove: true });
  const reachedApply = result.status === 'APPLIED' || result.status === 'APPLY_UNCERTAIN';
  const noChange = result.status === 'DRY_RUN' && 'plan' in result && result.plan && result.plan.entries.length === 0;
  return { ...result, stage: (reachedApply ? 'APPLY' : 'PLAN') as 'APPLY' | 'PLAN',
    ...(noChange ? { summary: `${result.summary} · 변경 0: 적용 생략` } : {}) };
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

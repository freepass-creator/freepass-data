import { pathToFileURL } from 'node:url';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { planSourceCycle, applySourceCycle, deepEqual, type CycleCommands, type CyclePlan, type CycleControl, type CycleProduct } from '../application/source-cycle.js';
import { sourceCyclePlugin, type CyclePlugin, type CycleCapture, type CycleSourceDefinition } from '../adapters/source-cycle-plugins.js';
import { fileCycleControl } from '../adapters/source-cycle-control.js';

/** 연속 실패 정지 뒤 자동 재시도까지의 냉각 시간. */
export const SOURCE_STOP_COOLDOWN_MS = 60 * 60 * 1000;
export async function runSourceCycle<T>(plugin: CyclePlugin<T>, commands: CycleCommands, control: CycleControl,
  options: { apply?: boolean; digest?: string; approval?: string; approvedPlan?: CyclePlan; onlyWhenSynced?: boolean; now?: () => number;
    /** onlyWhenSynced 에서 갱신 후 10분을 넘겼을 때 «다음 갱신»을 기다릴 최대 시간(ms, 기본 0 = 기다리지 않고 종전처럼 건너뜀).
     * 이안카 synced_at 은 15분 주기라 :05 단독 회차는 거의 항상 창 가장자리(갱신 후 10분 03초)에서 시작해 매번 건너뛰었다(2026-10-16). 15분 안쪽이면 다음 갱신을
     * 기다렸다가 읽는다(상류가 안 바뀌면 종전처럼 건너뜀). sleepMs 는 시험용 주입. */
    syncWaitMs?: number; sleepMs?: (ms: number) => Promise<void>;
    /** 같은 회차에서 방금 읽어 세운 계획을 바로 적용한다(무인 회차 전용). 사람이 검토한 계획 파일 승인 경로(approvedPlan)와 섞지 않는다. */
    autoApprove?: boolean;
    /** 사람이 손으로 돌리는 «계획만 만들기»(--plan, 적용 없음). 이 실행의 실패는 무인 회차의 연속 실패 수·정지 상태를 바꾸지 않는다(2026-10-16 수동 plan 이 정지를 오염). */
    manualPlan?: boolean } = {}) {
  const release = await control.acquire(plugin.sourceId);
  if (!release) return { status: 'LOCKED', writes: 0, summary: '원천 잠금: 중복 회차 생략' };
  const clock = options.now ?? Date.now;
  try {
    const state = await control.load(plugin.sourceId);
    // 연속 실패 정지는 «냉각 시간(기본 60분) 뒤 한 번 더 시도»로 자동 복구한다(대표 2026-10-14 «걸림돌 해제»).
    // 적용 불확실(APPLY_UNCERTAIN)은 쓰기 결과를 사람이 확인해야 하므로 자동 복구하지 않는다. 복구 뒤 실패가 이어지면 다시 정지(실패 수를 2 로 되돌려 한 번만 더 시도).
    if (state.stopped) {
      const last = Date.parse(state.lastAttemptAt ?? '');
      // 시각이 없거나 깨졌거나 미래(시계 이상)면 영구 정지가 되지 않게 «냉각 끝»으로 본다. 다음 회차는 어차피 새로 읽고 계획·CAS·되읽기를 거치므로 재시도는 멱등이다.
      const now = clock();
      const cooled = state.error !== 'APPLY_UNCERTAIN' && (!Number.isFinite(last) || last > now + 5 * 60_000 || now - last >= SOURCE_STOP_COOLDOWN_MS);
      if (!cooled) return { status: 'STOPPED', writes: 0, summary: '연속 실패 3회: 수동 원인 확인 필요' };
      state.stopped = false; state.failures = 2;
      await control.alert(plugin.sourceId, 'AUTO_RECOVER_AFTER_COOLDOWN');
    }
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
        // 상세 읽기에 약 5분이 걸리고 상류 신선도 창은 15분이다. 갱신 후 10분이 넘었으면 이번 갱신은 창 안에 끝낼 수 없어 다음 갱신을 기다린다
        // (넘긴 채 읽으면 DETAIL_SOURCE_DRIFT 로 5분마다 되풀이 실패하며 공급사 API 만 소모한다).
        // 다음 갱신 대기(옵트인): 갱신 후 10~14분이면 다음 갱신(15분 주기)이 5분 안쪽이다 — 30초마다 확인해 바뀌면 그 갱신으로 읽는다.
        const ageMs = () => clock() - Date.parse(synced!);
        if (options.syncWaitMs && options.syncWaitMs > 0 && ageMs() > 10 * 60_000 && ageMs() <= 14 * 60_000 && synced !== state.lastSyncedAt) {
          const sleepFn = options.sleepMs ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
          const pollMs = 30_000, attempts = Math.ceil(Math.min(options.syncWaitMs, 10 * 60_000) / pollMs);
          for (let i = 0; i < attempts; i++) {
            await sleepFn(pollMs);
            const next = await plugin.syncedAt!();
            if (next && Number.isFinite(Date.parse(next)) && Date.parse(next) > Date.parse(synced) && Date.parse(next) <= clock()) { synced = next; break; }
          }
        }
        if (clock() - Date.parse(synced) > 10 * 60_000 && synced !== state.lastSyncedAt) {
          state.error = null;
          await control.save(plugin.sourceId, state);
          await control.heartbeat(plugin.sourceId, state, null);
          return { status: 'UNCHANGED_SYNC', writes: 0, summary: `synced_at 갱신 후 10분 초과(synced_at ${synced}, ${Math.round((clock() - Date.parse(synced)) / 60_000)}분 경과): 신선도 창 안에 상세 읽기를 끝낼 수 없어 다음 갱신을 기다림` };
        }
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
      // 상류 원천의 갱신 시각 때문에 읽기를 마치지 못한 경우(정지 UPSTREAM_STALE, 상세를 읽는 사이 신선도 창을 넘긴 DETAIL_SOURCE_DRIFT)는 우리 쪽 실패가 아니다.
      const upstreamTiming = !read.complete && (read.detail === 'UPSTREAM_STALE' || read.detail === 'IANCAR_ONE_DETAIL_SOURCE_DRIFT' ||
        read.detail === 'SONOGONG_API_PASS_INTERVAL');   // 마지막 완전 읽기 후 45분 안: 공급사 API 부하 방어로 읽지 않는다(우리 쪽 실패 아님)
      if (read.raw === null && read.error && !upstreamTiming) throw new Error(read.detail ? `${read.error}_${read.detail}` : read.error);
      if (upstreamTiming) {
        // 상류 원천(공급사)이 갱신되지 않은 것이다 — 우리 쪽 실패가 아니므로 연속 실패로 세거나 정지하지 않는다(정지하면 공급사가 다시
        // 갱신해도 사람이 풀어야 한다). 쓰기 0, 신선도는 ERROR 로 남아 보이고, 같은 사유의 알림은 한 번만 남긴다.
        const reasonCode = read.detail as string;
        const alreadyKnown = state.error === reasonCode;
        state.error = reasonCode;
        await control.save(plugin.sourceId, state);
        await control.heartbeat(plugin.sourceId, state, null);
        if (!alreadyKnown) await control.alert(plugin.sourceId, reasonCode);
        return { status: 'HOLD', writes: 0, verified: 0, plan: null,
          summary: `상류 원천 갱신 시각 문제(${reasonCode}): 쓰기 0, 연속 실패로 세지 않음` };
      }
      if (synced && plugin.syncedAtOfRead?.(read) !== synced) throw new Error('SYNC_CHANGED_DURING_READ');
      const converted = plugin.toRecords(read);
      state.readCount = converted.records.length; state.heldCount = converted.held.length;
      state.observationOnlyCount = plugin.observationCountOfRead?.(read) ?? 0;
      state.heldReasons = {};
      for (const h of converted.held) for (const reason of h.reasons) {
        const code = /^[A-Z][A-Z0-9_]{2,48}/.exec(reason)?.[0] ?? 'OTHER';
        state.heldReasons[code] = (state.heldReasons[code] ?? 0) + 1;
      }
      const unassigned = converted.held.filter(h => h.reasons.some(r => r.includes('UID_REQUIRED'))).length;
      state.unassignedPlateCount = unassigned;
      state.observedSellableCount = converted.records.filter(r => r.status.saleAvailable === true).length;
      // 원천 원문 계층: 게이트 0(관측 전용 원천은 문서에서 만든 레코드라 제외). 실패해도 회차를 막지 않는다.
      if (!plugin.observationOnly && !options.approvedPlan && commands.storeRaw) {
        try {
          const stored = await commands.storeRaw({ sourceId: plugin.sourceId, records: converted.records, held: converted.held.map(h => ({ row: h.row, reasons: h.reasons })),
            observedAt: read.observedAt ?? new Date(clock()).toISOString(), complete: read.complete && !read.error });
          state.rawStored = stored.stored; state.rawAbsentMarked = stored.absentMarked;
        } catch { await control.alert(plugin.sourceId, 'RAW_STORE_FAILED'); }
      }
      if (plugin.observationOnly) {
        if (!read.complete || read.error) throw new Error('SOURCE_INCOMPLETE');
        state.failures = 0; state.error = null; state.lastCompleteAt = read.observedAt;
        await control.save(plugin.sourceId, state);
        await control.heartbeat(plugin.sourceId, state, null);
        return { status: 'OBSERVED', writes: 0, summary: `관측 전용 원천 ${converted.records.filter(r => r.status.saleAvailable === true).length} · 번호미배정 ${unassigned} · 상품 쓰기 0 · 수집기 최종 갱신 ${read.observedAt}` };
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
      // 부재 하향을 막는 보류는 «번호 불명·충돌» 계열뿐이다(독립 검토 2026-10-14). 값·상태 계열(가격·기간 비어 있음, 상태 불명, 동일 복사본)은 그 행의
      // 레코드가 이미 읽기 결과에 있어(계획의 seen 에 포함) 다른 차의 부재 판정을 가리지 않는다. 보류 사유는 «A,B» 로 이어 붙은 문자열일 수 있어 쉼표로 나눈다.
      // 이안카 요금 사실 보류(요금 없음·기준 밖 값·중복 요금 행)도 값 계열이다: 그 차의 행(번호·상태)은 읽기 결과에 그대로 있어 그 차만 보호되고
      // 다른 차의 부재 하향은 막지 않는다. 번호 계열 보류(번호 없음·형식·중복 번호)는 여기에 넣지 않는다 — 어느 문서인지 몰라 부재 하향을 유보한다.
      // RENT_REVIEW_REQUIRED(대여료 해석 불가·타당 범위 밖)도 행 레코드가 TERMS_HOLD 로 읽기 결과에 남아 있어 값 계열이다.
      const VALUE_CLASS_HOLDS = new Set(['TERMS_HOLD', 'STATUS_UNKNOWN', 'DUPLICATE_UID_SUSPECT', 'INFO_INCOMPLETE', 'RENT_REVIEW_REQUIRED',
        'IANCAR_ONE_RATES_EMPTY', 'IANCAR_ONE_RATE_FACT_REQUIRES_REVIEW', 'IANCAR_ONE_DUPLICATE_RATE',
        // 읽는 동안 상태가 바뀐 차(목록·상세 시차): 행(번호·상태)은 읽기 결과에 있고 그 차만 보류한다 — 다른 차의 부재 하향은 막지 않는다.
        'IANCAR_ONE_DETAIL_AVAILABILITY_DRIFT', 'IANCAR_ONE_DETAIL_SOURCE_DRIFT', 'IANCAR_ONE_LIST_CHANGED_DURING_READ']);
      const benign = converted.held.filter(h => h.reasons.length > 0 &&
        h.reasons.every(r => r.split(',').map(s => s.trim()).filter(Boolean).every(s => VALUE_CLASS_HOLDS.has(s)))).length;
      const built = planSourceCycle(plugin, { records: converted.records, complete: read.complete && !read.error,
        observedAt: read.observedAt, heldCount: converted.held.length,
        ...(benign ? { benignHeldCount: benign } : {}),
        ...(unassigned ? { unassignedPlateCount: unassigned } : {}) }, await commands.list(plugin.sourceId), options.approvedPlan?.plannedAt ?? clock());
      plan = built.plan;
      state.reconciliation = built.reconciliation;
      // 읽기 단계 보류 사유에 계획 단계 보류 사유를 합친다(같은 코드는 더한다).
      for (const [code, n] of Object.entries(built.heldReasons)) state.heldReasons![code] = (state.heldReasons![code] ?? 0) + n;
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
      const counts = (kind: string, exposedOnly = false) => plan!.entries.filter(e => e.kind === kind && (!exposedOnly || e.after.listable)).length;
      summary = `원천 ${plan.sourceCount} → 노출 ${plan.exposedBefore - counts('DOWNGRADE') + counts('ENROLL', true) + counts('REEXPOSE')} (계획), 하향 ${counts('DOWNGRADE')}·편입 ${counts('ENROLL')}(노출 ${counts('ENROLL', true)})·재노출 ${counts('REEXPOSE')}·갱신 ${counts('UPDATE')}, 되읽기 ${applying ? `${applied.verified}/${plan.entries.length}` : '미실행'} (${applied.status})`;
      if (applied.status === 'APPLY_UNCERTAIN') {
        const detail = 'uncertainDetail' in applied ? applied.uncertainDetail : '';
        if (detail) summary += ` · 불확실 ${detail} · 쓰기 ${applied.writes}`;
        throw new Error('APPLY_UNCERTAIN');
      }
      summary += ` · 번호미배정 ${unassigned}`;
      if (plan.warnings.length) summary += ` · ${plan.warnings.join(',')}`;
      const readNotes = (read.raw as { notes?: unknown } | null)?.notes;
      if (Array.isArray(readNotes) && readNotes.length) summary += ` · ${readNotes.filter((n): n is string => typeof n === 'string' && /^[A-Z0-9_:가-힣]{3,60}$/.test(n)).join(',')}`;
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
      if (options.manualPlan === true && options.apply !== true) {
        // 수동 plan 의 실패는 무인 회차의 실패 수·정지·마지막 시도 시각을 건드리지 않는다(저장하지 않음). 사유만 알린다.
        return { status: 'HOLD', writes: 0, verified: 0,
          summary: `${summary ? summary + ' · ' : ''}수동 plan 보류 ${reason}${readDetail ? ` · 불완전 사유 ${readDetail}` : ''} (연속 실패 수 변경 없음)`, plan };
      }
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
  options: { onlyWhenSynced?: boolean; now?: () => number; syncWaitMs?: number; sleepMs?: (ms: number) => Promise<void> } = {}) {
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
        products: snapshot.products.filter(p => p.record.sourceId === source),
        foreignUids: snapshot.products.filter(p => p.record.sourceId !== source).map(p => p.record.uid).sort() }; },
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

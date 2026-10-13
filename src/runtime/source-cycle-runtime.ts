import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { firestoreCycleCommands, decodeFields, productRecord, gcloudUserToken } from '../infra/source-cycle-firestore.js';
import { resolveGwsBin } from '../infra/gws-bin.js';
import { assessFreshness } from '../application/source-freshness.js';
import { captureSharedSheetReadOnly } from '../jobs/capture-shared-sheet.js';
import { sharedSheetChannels, assertCurrentSharedSheetSource, sharedSheetCaptureDigest } from '../adapters/shared-sheet-source.js';
import { sourceCyclePlugin, iancarCyclePlugin, AICA_SCOPES, type CyclePlugin } from '../adapters/source-cycle-plugins.js';
import { f05NativeCapture, aicaNativeCapture, aicaNativePlugin, ironNativeCapture, plateUidPlugin, type Visibility } from '../adapters/source-cycle-native.js';
import { collectIancarOneFullFacts, iancarOneApiConfigFromEnv, collectIancarOneVehicleList } from '../adapters/iancar-one-api.js';
import { fileCycleControl } from '../adapters/source-cycle-control.js';
import { runSourceCycle, runUnattendedSourceCycle } from '../jobs/source-cycle.js';
import type { CyclePlan } from '../ports/source-cycle.js';
import { stableDigest } from '../shared/stable-digest.js';

export function createSourceCycleRuntime(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch, acceptDrift: string[] = []) {
  const directory = env.SOURCE_CYCLE_PRIVATE_DIR || join(homedir(), '.codex', 'private', 'source-cycle');
  const ratio = Number(env.SOURCE_CYCLE_MAX_DOWNGRADE_RATIO ?? '0.2');
  if (!(ratio > 0 && ratio <= 1)) throw new Error('CYCLE_CONFIG_INVALID');
  const commands = firestoreCycleCommands({ env, directory: join(directory, 'backups'), fetcher,
    observationSources: ['RP012', 'RP023'], acceptDrift });
  const control = fileCycleControl(directory, async (source, state, plan) => {
    await appendFile(join(directory, 'heartbeats.jsonl'), JSON.stringify({ source, ...state,
      sourceCount: plan?.sourceCount ?? null, digest: plan ? stableDigest(plan) : null }) + '\n', { mode: 0o600 });
  });
  // 시트 읽기는 이미 인증된 gws(회사 계정 위임)로 한다 — gcloud 사용자 토큰에는 Sheets 권한이 없다. 비밀은 건드리지 않는다.
  const gwsBin = () => {
    const bin = resolveGwsBin(env);
    if (!bin) throw new Error('SHEETS_TRANSPORT_UNAVAILABLE');
    return bin;
  };
  const sheetsViaGws = (url: URL): Response => {
    const m = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(\/values:batchGet)?$/);
    if (!m) throw new Error('SHEETS_URL_UNSUPPORTED');
    const params: Record<string, unknown> = { spreadsheetId: decodeURIComponent(m[1]!) };
    const ranges: string[] = [];
    for (const [k, v] of url.searchParams) { if (k === 'ranges') ranges.push(v); else if (v === 'true') params[k] = true; else params[k] = v; }
    if (ranges.length) params.ranges = ranges;
    const args = m[2] ? ['sheets', 'spreadsheets', 'values', 'batchGet'] : ['sheets', 'spreadsheets', 'get'];
    const out = execFileSync(gwsBin(), [...args, '--params', JSON.stringify(params)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return new Response(out.slice(out.indexOf('{')), { status: 200 });
  };
  const get = async (url: URL, authenticated: boolean) => {
    if (authenticated && url.hostname === 'sheets.googleapis.com') return sheetsViaGws(url);
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: authenticated ? { authorization: `Bearer ${await gcloudUserToken()}` } : {} });
    if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
    return response;
  };
  const required = (key: string) => { const v = env[key]?.trim(); if (!v) throw new Error('SOURCE_CONFIGURATION_REQUIRED'); return v; };
  const visibility = async (id: string): Promise<Visibility> => {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`);
    url.searchParams.set('includeGridData', 'true');
    url.searchParams.set('fields', 'sheets(properties(title,hidden,gridProperties(rowCount)),data(startRow,rowMetadata(hiddenByUser,hiddenByFilter)))');
    return (await get(url, true)).json();
  };
  const plugins: CyclePlugin<any>[] = [];
  const enabled = required('SOURCE_CYCLE_SOURCES').split(',').map(x => x.trim());
  for (const kind of enabled) {
    if (kind === 'F05') {
      for (const code of new Set(sharedSheetChannels.map(c => c.code))) {
        const scopes = [...new Set(sharedSheetChannels.filter(c => c.code === code).map(c => c.tab))];
        plugins.push(sourceCyclePlugin({ sourceId: code, kind: 'F05', scopes, maxDowngradeRatio: ratio }, async () => {
          const id = required('SOURCE_CYCLE_F05_SHEET_ID'); assertCurrentSharedSheetSource(id);
          const fullUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values:batchGet`);
          for (const title of new Set(sharedSheetChannels.map(c => c.tab))) fullUrl.searchParams.append('ranges', `'${title.replace(/'/g, "''")}'`);
          const before = await visibility(id), rawBefore = await (await get(fullUrl, true)).json();
          const capture = await captureSharedSheetReadOnly(id), rawAfter = await (await get(fullUrl, true)).json(), after = await visibility(id);
          if (stableDigest(before) !== stableDigest(after)) throw new Error('SOURCE_VISIBILITY_CHANGED');
          if (stableDigest(rawBefore) !== stableDigest(rawAfter) || rawAfter.valueRanges?.length !== capture.tabs.length) throw new Error('SOURCE_CAPTURE_CHANGED');
          for (const [i, tab] of capture.tabs.entries()) {
            const values = rawAfter.valueRanges[i].values ?? [], headers: unknown[] = values[0] ?? [];
            const indexes = headers.flatMap((h, n) => h === 'UID' ? [n] : []);
            if (indexes.length > 1) throw new Error('UID_COLUMN_AMBIGUOUS');
            if (indexes.length === 1) {
              if (indexes[0]! < tab.values[0]!.length) throw new Error('UID_COLUMN_SCHEMA_CHANGED');
              tab.values[0]!.push('UID');
              for (let row = 1; row < tab.values.length; row++) tab.values[row]!.push(values[row]?.[indexes[0]!] ?? '');
            }
          }
          capture.digest = sharedSheetCaptureDigest(capture);
          return f05NativeCapture(code, capture, after);
        }));
      }
    } else if (kind === 'AICA') {
      plugins.push(aicaNativePlugin(async () => {
        const id = required('SOURCE_CYCLE_AICA_SHEET_ID');
        const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values:batchGet`);
        for (const title of AICA_SCOPES) url.searchParams.append('ranges', `'${title}'`);
        url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
        const observedAt = new Date().toISOString();
        const visibilityBefore = await visibility(id);
        const before = await (await get(url, true)).json(), after = await (await get(url, true)).json();
        const visibilityAfter = await visibility(id);
        if (stableDigest(visibilityBefore) !== stableDigest(visibilityAfter)) throw new Error('SOURCE_VISIBILITY_CHANGED');
        if (stableDigest(before) !== stableDigest(after) || before.valueRanges?.length !== AICA_SCOPES.length) throw new Error('AICA_CAPTURE_CHANGED');
        return aicaNativeCapture(AICA_SCOPES.map((title, i) => ({ title, values: before.valueRanges[i].values ?? [] })), observedAt, visibilityAfter);
      }, ratio));
    } else if (kind === 'IANCAR') {
      plugins.push(plateUidPlugin(iancarCyclePlugin(ratio, () => collectIancarOneFullFacts(iancarOneApiConfigFromEnv(env), fetcher),
        undefined, async () => (await collectIancarOneVehicleList(iancarOneApiConfigFromEnv(env), fetcher)).syncedAt)));
    } else if (kind === 'IRON') {
      plugins.push(plateUidPlugin(sourceCyclePlugin({ sourceId: 'RP006', kind, scopes: ['homepage'], maxDowngradeRatio: ratio }, async () => {
        const url = new URL(required('SOURCE_CYCLE_IRON_LIST_URL'));
        if (url.origin !== 'https://ironrentcar.com' || url.username || url.password) throw new Error('IRON_TARGET_HOLD');
        return ironNativeCapture(await (await get(url, false)).text(), new Date().toISOString());
      })));
    } else if (kind === 'SONOGONG' || kind === 'AUTOPLUS') {
      const sourceId = kind === 'SONOGONG' ? 'RP012' : 'RP023';
      const source = kind === 'SONOGONG' ? 'sonokong' : 'website';
      const plugin = sourceCyclePlugin({ sourceId, kind, scopes: ['collector'], maxDowngradeRatio: ratio }, async () => {
        const observedAt = new Date().toISOString();
        const documents = await commands.documents(sourceId);
        return { observedAt, complete: true, completedScopes: ['collector'], visibilityComplete: true, heldCount: 0,
          rows: documents.filter(d => decodeFields(d.fields).source === source).map(d => ({ scope: 'collector',
            record: productRecord(decodeURIComponent(d.name.split('/').at(-1)!), decodeFields(d.fields), observedAt) })) };
      });
      plugins.push({ ...plugin, observationOnly: true });
    } else throw new Error('CYCLE_SOURCE_CONFIG_INVALID');
  }
  if (new Set(plugins.map(p => p.sourceId)).size !== plugins.length) throw new Error('CYCLE_DUPLICATE_WRITER');
  // 하향 가드 절대 개수 하한(기본 3): 노출 10~30대 소규모 공급사의 정당한 상태 변경이 매 회차 전체를 막지 않게 한다. 0 이면 옛 합산 비율.
  const floor = Number(env.SOURCE_CYCLE_DOWNGRADE_FLOOR ?? '3');
  if (!Number.isSafeInteger(floor) || floor < 0 || floor > 50) throw new Error('CYCLE_CONFIG_INVALID');
  for (const plugin of plugins) plugin.downgradeFloor = floor;
  return { plugins, commands, control, directory };
}

// No authentication or network on import. A reviewed runtime needs explicit environment configuration.
const configured = process.env.SOURCE_CYCLE_SOURCES ? createSourceCycleRuntime() : null;
export const plugins = configured?.plugins ?? [];
export const commands = configured?.commands;
export const control = configured?.control;

/** 무인 회차 실행 전 필수 조건 점검. 없으면 회차를 돌리지 않고 코드만 돌려준다(원천별 AUTH_FAILED 로 3회 정지되는 사고 방지). */
export type UnattendedProbes = { gwsBin(env: NodeJS.ProcessEnv): string | null; gcloudToken(): Promise<string> };
const defaultProbes: UnattendedProbes = { gwsBin: resolveGwsBin, gcloudToken: gcloudUserToken };
export async function unattendedPreflight(env: NodeJS.ProcessEnv, kinds: readonly string[], probes: UnattendedProbes = defaultProbes) {
  const missing: string[] = [];
  const sheets = kinds.includes('F05') || kinds.includes('AICA');
  if (sheets && !probes.gwsBin(env)) missing.push('PREFLIGHT_GWS_MISSING');
  if (kinds.includes('F05') && env.SHEETS_TRANSPORT !== 'gws') missing.push('PREFLIGHT_SHEETS_TRANSPORT_UNSET');
  try { if (!(await probes.gcloudToken())) missing.push('PREFLIGHT_GCLOUD_TOKEN_MISSING'); }
  catch { missing.push('PREFLIGHT_GCLOUD_TOKEN_MISSING'); }
  return missing;
}

/** 스케줄러가 부르는 한 회차: 사전점검 → 계획·적용(원천별) → 신선도 판정 → 실행 기록 한 줄(unattended-runs.jsonl). 토큰·원문은 기록하지 않는다. */
export async function runUnattended(args: string[], env: NodeJS.ProcessEnv, acceptDrift: string[], probes: UnattendedProbes = defaultProbes) {
  const directory = env.SOURCE_CYCLE_PRIVATE_DIR || join(homedir(), '.codex', 'private', 'source-cycle');
  const source = args.indexOf('--source') >= 0 ? args[args.indexOf('--source') + 1] : undefined;
  const record: { started: string; finished: string; exit: number; preflight?: string[]; error?: string;
    reports?: Array<{ source: string; stage: string; status: string; summary: string; digest: string | null }>;
    freshness?: ReturnType<typeof assessFreshness> } = { started: new Date().toISOString(), finished: '', exit: 0 };
  const alert = (reason: string) => appendFile(join(directory, 'alerts.jsonl'),
    JSON.stringify({ source: 'RUNNER', reason, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  await mkdir(directory, { recursive: true });
  try {
    const kinds = (env.SOURCE_CYCLE_SOURCES ?? '').split(',').map(x => x.trim()).filter(Boolean);
    record.preflight = await unattendedPreflight(env, kinds, probes);
    if (record.preflight.length) { record.exit = 1; await alert(record.preflight.join(',')); }
    else {
      const runtime = createSourceCycleRuntime(env, fetch, acceptDrift);
      const selected = runtime.plugins.filter(p => !source || p.sourceId === source);
      if (!selected.length) throw new Error('ONE_SOURCE_REQUIRED');
      record.reports = [];
      for (const plugin of selected) {
        const result = await runUnattendedSourceCycle(plugin, runtime.commands, runtime.control,
          { onlyWhenSynced: args.includes('--only-when-synced') && plugin.family === 'IANCAR' });
        record.reports.push({ source: plugin.sourceId, stage: result.stage, status: result.status, summary: result.summary,
          digest: 'planDigest' in result ? result.planDigest : null });
      }
      const lines = async (name: string) => (await readFile(join(directory, name), 'utf8').catch(() => '')).split('\n');
      record.freshness = assessFreshness(await lines('heartbeats.jsonl'), await lines('alerts.jsonl'),
        { maxAgeMinutes: Number(env.SOURCE_CYCLE_MAX_AGE_MINUTES ?? '120'), only: selected.map(p => p.sourceId) });
      if (record.reports.some(r => ['HOLD', 'STOPPED', 'APPLY_UNCERTAIN'].includes(r.status)) || record.freshness.status !== 'HEALTHY') record.exit = 1;
    }
  } catch (e) {
    const code = e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'UNATTENDED_RUN_ERROR';
    record.exit = 1; record.error = code; await alert(code);
  }
  record.finished = new Date().toISOString();
  await appendFile(join(directory, 'unattended-runs.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

export async function runtimeCli(args: string[], env = process.env) {
  const get = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const acceptDrift = (get('--accept-drift') ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (acceptDrift.some(c => !/^RP\d{3}$/.test(c))) throw new Error('ACCEPT_DRIFT_CODE_INVALID');
  // 무인 회차(스케줄러용): 명시 env 옵트인 + 플래그 둘 다 있어야 하며, 수동 승인 인자와 섞지 않는다.
  if (args.includes('--unattended')) {
    if (env.SOURCE_CYCLE_UNATTENDED !== '1') throw new Error('UNATTENDED_NOT_ENABLED');
    if (args.includes('--apply') || get('--plan') || get('--rollback')) throw new Error('UNATTENDED_ARGS_INVALID');
    return runUnattended(args, env, acceptDrift);
  }
  const runtime = createSourceCycleRuntime(env, fetch, acceptDrift);
  const key = get('--rollback');
  if (key) {
    if (!args.includes('--apply')) return { status: 'ROLLBACK_DRY_RUN', digest: await runtime.commands.rollbackDigest(key) };
    return runtime.commands.rollback(key, env.SOURCE_CYCLE_APPROVED_DIGEST ?? '');
  }
  const source = get('--source'), selected = runtime.plugins.filter(p => !source || p.sourceId === source);
  if (!selected.length || (args.includes('--apply') && selected.length !== 1)) throw new Error('ONE_SOURCE_REQUIRED');
  const planFile = get('--plan');
  const approvedPlan: CyclePlan | undefined = args.includes('--apply') && planFile
    ? JSON.parse(await readFile(resolve(planFile), 'utf8')) : undefined;
  if (args.includes('--apply') && !approvedPlan) throw new Error('APPROVED_PLAN_REQUIRED');
  const reports = [];
  for (const plugin of selected) {
    const result = await runSourceCycle(plugin, runtime.commands, runtime.control, {
      onlyWhenSynced: args.includes('--only-when-synced') && plugin.family === 'IANCAR',
      ...(approvedPlan ? { apply: true, approvedPlan, digest: stableDigest(approvedPlan), approval: env.SOURCE_CYCLE_APPROVED_DIGEST ?? '' } : {}) });
    if (!approvedPlan && planFile && 'plan' in result && result.plan) {
      if (selected.length !== 1) throw new Error('ONE_SOURCE_REQUIRED');
      await writeFile(resolve(planFile), JSON.stringify(result.plan), { mode: 0o600, flag: 'wx' });
    }
    reports.push({ source: plugin.sourceId, status: result.status, summary: result.summary + (acceptDrift.includes(plugin.sourceId) ? ` · 보정허용(--accept-drift ${plugin.sourceId})` : ''),
      digest: 'planDigest' in result ? result.planDigest : null });
  }
  return reports;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runtimeCli(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result));
    if (Array.isArray(result) && result.some(r => ['HOLD', 'STOPPED', 'APPLY_UNCERTAIN'].includes(r.status))) process.exitCode = 1;
    if (result && !Array.isArray(result) && 'exit' in result && typeof result.exit === 'number') process.exitCode = result.exit;
  }, () => { console.error('SOURCE_CYCLE_RUNTIME_HOLD'); process.exitCode = 1; });
}

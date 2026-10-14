import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendFile, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { firestoreCycleCommands, decodeFields, productRecord, gcloudUserToken } from '../infra/source-cycle-firestore.js';
import { resolveGwsBin } from '../infra/gws-bin.js';
import { readSheetsUrl } from '../infra/shared-sheet-capture-reader.js';
import { assessFreshness, parseFreshnessExempt, parseFreshnessThresholds } from '../application/source-freshness.js';
import { latestCollectionSuccess } from '../application/erp4-collection-evidence.js';
import { captureSharedSheetReadOnly } from '../jobs/capture-shared-sheet.js';
import { sharedSheetChannels, assertCurrentSharedSheetSource, sharedSheetCaptureDigest } from '../adapters/shared-sheet-source.js';
import { sourceCyclePlugin, iancarCyclePlugin, decisionWithdrawnPlugin, AICA_SCOPES, type CyclePlugin } from '../adapters/source-cycle-plugins.js';
import withdrawnSuppliers from '../../contracts/withdrawn-suppliers.v1.json' with { type: 'json' };
import { f05NativeCapture, aicaNativeCapture, aicaNativePlugin, ironNativeCapture, plateUidPlugin, type Visibility } from '../adapters/source-cycle-native.js';
import { collectIancarOneFullFacts, iancarOneApiConfigFromEnv, collectIancarOneVehicleList } from '../adapters/iancar-one-api.js';
import { fileCycleControl } from '../adapters/source-cycle-control.js';
import { createAutoplusHomepageClient, collectAutoplusHomepage, compareAutoplusHomepage } from '../adapters/autoplus-homepage.js';
import { readAutoplusSheet, autoplusSheetRowFloor, type AutoplusSheetTab } from '../adapters/autoplus-sheet.js';
import { createSonogongErpReader } from '../adapters/sonogong-erp-reader.js';
import { createSonogongApiClient, readSonogongApi, SONOGONG_API_POLICY, type SonogongApiRead } from '../adapters/sonogong-api.js';
import { judgeSonogongApiRead, claimEnrollCapOnce } from '../adapters/sonogong-api-guards.js';
import { readIronHomepage, IRON_HOMEPAGE_POLICY } from '../adapters/iron-homepage.js';
import { summarizeSonogong } from '../adapters/sonogong-observe.js';
import { runSourceCycle, runUnattendedSourceCycle } from '../jobs/source-cycle.js';
import type { CyclePlan } from '../ports/source-cycle.js';
import { stableDigest } from '../shared/stable-digest.js';

/** ERP4 단독 수집 원천(손오공 RP012·오토플러스 RP023)의 관측 전용 플러그인. 엔진은 쓰지 않고, 공급사 문서 전체(source 값과 무관)를 세며
 * 관측 시각은 «지금»이 아니라 노출 문서의 마지막 수정 시각이다 — 수집기가 멈추면 시각이 늙어 신선도 감시가 STALE 로 잡는다
 * (이전에는 관측 시각을 지금으로 찍어 수집이 6.5시간 멈춰도 정상으로 보였다: 2026-10-13 실측). */
type ObservedDoc = { name: string; updateTime?: string; fields: Record<string, unknown> };
export function collectorObservationPlugin(kind: 'SONOGONG' | 'AUTOPLUS', ratio: number,
  documents: (sourceId: string) => Promise<ObservedDoc[]>, now: () => number = Date.now,
  /** ERP4 수집(쓰기) 단계의 마지막 성공 시각. 있으면 «바뀐 문서만 쓰기» 로 문서 갱신 시각이 낡아 보이는 오탐을 막는 더 정확한 근거다. */
  collectionSuccessAt?: () => Promise<string | null>) {
  const sourceId = kind === 'SONOGONG' ? 'RP012' : 'RP023';
  const plugin = sourceCyclePlugin({ sourceId, kind, scopes: ['collector'], maxDowngradeRatio: ratio }, async () => {
    const decoded = (await documents(sourceId)).map(d => ({ d, f: decodeFields(d.fields as never) as Record<string, unknown> }));
    const latest = (list: typeof decoded) => Math.max(0, ...list.map(x => Date.parse(x.d.updateTime ?? '')).filter(Number.isFinite));
    const exposed = decoded.filter(x => x.f.listable === true);
    const docStamp = latest(exposed.length ? exposed : decoded);
    // 증거를 못 읽으면(gh 오류·한도) 문서 시각으로 되돌아간다: 신선하게 «보이게» 만드는 방향으로는 절대 폴백하지 않는다.
    const evidence = await collectionSuccessAt?.().then(v => v ? Date.parse(v) : NaN, () => NaN) ?? NaN;
    const evidenceStamp = Number.isFinite(evidence) && evidence <= now() + 60_000 ? evidence : 0;
    // 신선도 근거는 «수집 완료 시각»뿐이다(독립 검토 2026-10-14): 문서 하나만 수정돼도 신선해지면 수집이 멈춰도 못 잡는다.
    // 수집 증거 함수가 연결돼 있으면 문서 수정 시각을 쓰지 않고, 증거를 못 읽으면 epoch(= STALE)로 둔다. 증거 함수가 아예 없을 때만 옛 동작(문서 시각).
    const stamp = collectionSuccessAt ? evidenceStamp : docStamp;
    const observedAt = new Date(stamp > 0 ? stamp : collectionSuccessAt ? 0 : now()).toISOString();
    return { observedAt, complete: true, completedScopes: ['collector'], visibilityComplete: true, heldCount: 0,
      rows: decoded.map(({ d, f }) => ({ scope: 'collector',
        record: productRecord(decodeURIComponent(d.name.split('/').at(-1)!), f as never, observedAt) })) };
  });
  return { ...plugin, observationOnly: true };
}

/** 인증된 gh CLI 로 GitHub REST 를 읽는다(읽기 전용, 토큰은 gh 가 관리·기록하지 않음). 시간 제한을 둔다. */
async function defaultGhApi(path: string): Promise<unknown> {
  const { execFile } = await import('node:child_process');
  const out = await new Promise<string>((resolveOut, reject) => execFile('gh', ['api', path], { encoding: 'utf8', windowsHide: true,
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (e, stdout) => e ? reject(e) : resolveOut(stdout)));
  return JSON.parse(out);
}
async function writeJsonAtomic(path: string, value: unknown): Promise<boolean> {
  const tmp = `${path}.${process.pid}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, path); return true; }
  catch { await unlink(tmp).catch(() => undefined); return false; }
}
/** 손오공 공식 API 쓰기 플러그인: API 읽기 결과(번호 키·계약중=선점 표시·요금·사진)를 엔진 레코드로 넘긴다. 읽기가 불완전하면 부재 하향·적용이 막힌다. */
export function sonogongApiWritePlugin(ratio: number, collect: () => Promise<SonogongApiRead>) {
  return sourceCyclePlugin({ sourceId: 'RP012', kind: 'SONOGONG', scopes: ['api'], maxDowngradeRatio: ratio }, async () => {
    const c = await collect();
    return { observedAt: c.observedAt, complete: c.complete, completedScopes: c.complete ? ['api'] : [], visibilityComplete: true,
      ...(c.incompleteReason ? { incompleteReason: c.incompleteReason } : {}),
      ...(c.notes.length ? { notes: c.notes } : {}),
      heldCount: c.held.length + c.duplicatePlates.length,
      rows: c.records.map(record => ({ scope: 'api', record })) };
  }) as ReturnType<typeof sourceCyclePlugin>;
}
/** 손오공 공식 API 연동이 «완전히» 켜졌는지: 스위치 + 키 + 기준 주소. 하나라도 없으면 false(네트워크 호출 0, RP012 는 관측 전용). 키 값은 어디에도 남기지 않는다. */
export const sonogongApiEnabled = (env: NodeJS.ProcessEnv): boolean =>
  env.SOURCE_CYCLE_SONOGONG_API === '1' && !!env.SONOGONG_API_KEY?.trim() && !!env.SONOGONG_API_BASE?.trim();
export function createSourceCycleRuntime(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch, acceptDrift: string[] = [],
  ghApi: (path: string) => Promise<unknown> = defaultGhApi) {
  const directory = env.SOURCE_CYCLE_PRIVATE_DIR || join(homedir(), '.codex', 'private', 'source-cycle');
  const ratio = Number(env.SOURCE_CYCLE_MAX_DOWNGRADE_RATIO ?? '0.2');
  if (!(ratio > 0 && ratio <= 1)) throw new Error('CYCLE_CONFIG_INVALID');
  const commands = firestoreCycleCommands({ env, directory: join(directory, 'backups'), fetcher,
    // 오토플러스 홈피 쓰기 스위치가 켜지면 RP023 만 쓰기 허용(손오공 RP012 는 ERP4 승인 등록 경로가 쓰므로 계속 관측 전용).
    // 손오공 공식 API 쓰기(대표 2026-10-14): 스위치 SOURCE_CYCLE_SONOGONG_API=1 «과» 키·기준 주소가 모두 있을 때만 RP012 쓰기를 연다 — 키가 없으면 호출 0·관측 전용 유지.
    observationSources: [...(sonogongApiEnabled(env) ? [] : ['RP012']),
      ...(env.SOURCE_CYCLE_AUTOPLUS_SHEET === '1' ? [] : ['RP023'])], acceptDrift, writeMonthlyProductType: env.SOURCE_CYCLE_WRITE_MONTHLY_PRODUCT_TYPE === '1' });
  const control = fileCycleControl(directory, async (source, state, plan) => {
    await appendFile(join(directory, 'heartbeats.jsonl'), JSON.stringify({ source, ...state,
      sourceCount: plan?.sourceCount ?? null, digest: plan ? stableDigest(plan) : null }) + '\n', { mode: 0o600 });
  }, { takeOverDeadLocks: env.SOURCE_CYCLE_UNATTENDED === '1' && env.SOURCE_CYCLE_TAKEOVER !== '0' });   // 인계자는 «전체 정시 예약» 하나: 수동 실행·단독 원천 예약(-Source)은 보류+알림만
  // ERP4 수집(쓰기) 단계의 마지막 성공 시각(SOURCE_CYCLE_ERP4_REPO=owner/repo 일 때만). 한 회차 안에서 두 원천이 같은 조회를 공유한다.
  const erp4Repo = env.SOURCE_CYCLE_ERP4_REPO && /^[\w.-]+\/[\w.-]+$/.test(env.SOURCE_CYCLE_ERP4_REPO) ? env.SOURCE_CYCLE_ERP4_REPO : null;
  let evidenceCache: { at: number; value: Promise<string | null> } | null = null;
  const collectionEvidence = erp4Repo ? () => {
    if (!evidenceCache || Date.now() - evidenceCache.at > 60_000) {
      const workflow = encodeURIComponent(env.SOURCE_CYCLE_ERP4_WORKFLOW || 'erp5-ssot-refresh.yml');
      evidenceCache = { at: Date.now(), value: latestCollectionSuccess({
        runs: async () => ((await ghApi(`repos/${erp4Repo}/actions/workflows/${workflow}/runs?per_page=8&status=completed`)) as { workflow_runs?: never[] })
          .workflow_runs ?? [],
        jobs: async runId => await ghApi(`repos/${erp4Repo}/actions/runs/${runId}/jobs`) as never }) };
    }
    return evidenceCache.value;
  } : undefined;
  // 시트 읽기는 이미 인증된 gws(회사 계정 위임)로 한다 — gcloud 사용자 토큰에는 Sheets 권한이 없다. 비밀은 건드리지 않는다.
  // 온라인 실행기(Actions)는 gws 가 없으므로 SHEETS_TRANSPORT=adc 일 때만 ADC 읽기 전용 토큰(WIF 서비스 계정, 시트 «보기» 공유)으로 읽는다.
  const sheetsAdc = env.SHEETS_TRANSPORT === 'adc';
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
    if (authenticated && url.hostname === 'sheets.googleapis.com') return sheetsAdc ? new Response(JSON.stringify(await readSheetsUrl(url)), { status: 200 }) : sheetsViaGws(url);
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
    } else if (kind === 'IRON' && env.SOURCE_CYCLE_IRON_HOMEPAGE === '1') {
      // 아이언 홈페이지 상세 기준(대표 2026-10-14): 목록(신차·중고, 더보기) → 상세 전수, 판매완료 라벨은 판매 불가(1차 무조건 편입은 비노출), 번호 키, 사진 갤러리.
      // ERP4 의 RP006 쓰기(approveAll·변동)는 «폐기»가 확정되어야 켠다(이중 쓰기 금지). 읽기 불완전·목록 급감이면 쓰기·부재 하향이 막힌다.
      const countFile = join(directory, 'iron-homepage-count.json');
      plugins.push(plateUidPlugin(sourceCyclePlugin({ sourceId: 'RP006', kind: 'IRON', scopes: ['homepage'], maxDowngradeRatio: ratio }, async () => {
        const fetchHtml = async (url: string) => {
          const response = await fetch(url, { headers: { 'User-Agent': 'FreePassData/1 iron homepage sync' }, redirect: 'follow', signal: AbortSignal.timeout(IRON_HOMEPAGE_POLICY.timeoutMs) });
          if (!response.ok) throw new Error(`IRON_HTTP_${response.status}`);
          if (new URL(response.url || url).hostname !== IRON_HOMEPAGE_POLICY.host) throw new Error('IRON_HOST_REJECTED');
          const html = await response.text();
          if (!/<(?:!doctype|html)/i.test(html.slice(0, 300))) throw new Error('IRON_NOT_HTML');
          return html;
        };
        const read = await readIronHomepage(fetchHtml);
        const exposedDocs = (await commands.documents('RP006')).filter(d => {
          const f = decodeFields(d.fields as never) as Record<string, unknown>;
          const locked = (f.locked_by_contract !== undefined && f.locked_by_contract !== null && f.locked_by_contract !== false && f.locked_by_contract !== '')
            || f.status === '계약중' || f.status_kind === '계약중';
          return f.listable === true && !locked;
        }).length;
        let previous = 0, stateError: string | null = null;
        try {
          const parsed = JSON.parse(await readFile(countFile, 'utf8')) as { count?: unknown };
          if (typeof parsed.count === 'number' && Number.isSafeInteger(parsed.count) && parsed.count > 0) previous = parsed.count; else stateError = 'IRON_COUNT_STATE_INVALID';
        } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') stateError = 'IRON_COUNT_STATE_INVALID'; }
        // 판정은 손오공 API 와 같은 순수 함수: 축소·불완전 읽기는 기준 파일에 저장하지 않고 하한은 고유 차량번호 수 기준.
        const verdict = judgeSonogongApiRead(read, { exposedUnlockedDocs: exposedDocs, previousCount: previous, stateError });
        let complete = verdict.complete, reason = verdict.incompleteReason;
        if (verdict.saveCount !== null && !(await writeJsonAtomic(countFile, { count: verdict.saveCount, at: read.observedAt })) && verdict.complete) {
          complete = false; reason = 'IRON_COUNT_STATE_WRITE_FAILED';
        }
        return { observedAt: read.observedAt, complete, completedScopes: complete ? ['homepage'] : [], visibilityComplete: true,
          ...(reason ? { incompleteReason: reason } : {}), heldCount: read.held.length + read.duplicatePlates.length,
          rows: read.records.map(record => ({ scope: 'homepage', record })) };
      })));
    } else if (kind === 'IRON') {
      plugins.push(plateUidPlugin(sourceCyclePlugin({ sourceId: 'RP006', kind, scopes: ['homepage'], maxDowngradeRatio: ratio }, async () => {
        const url = new URL(required('SOURCE_CYCLE_IRON_LIST_URL'));
        if (url.origin !== 'https://ironrentcar.com' || url.username || url.password) throw new Error('IRON_TARGET_HOLD');
        return ironNativeCapture(await (await get(url, false)).text(), new Date().toISOString());
      })));
    } else if (kind === 'SONOGONG' || kind === 'AUTOPLUS') {
      // 오토플러스 홈피 관측 병행(대표 2026-10-14: 홈피가 정본): SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_REPORT=<보고 파일 경로> 일 때만, 문서를 읽을 때
      // 홈피 전수를 직렬로 읽어 번호 기준 비교 요약(건수·끝 4자리)을 파일에 쓴다. 쓰기 0, 실패는 회차에 영향 없음(best-effort).
      const homepageReport = kind === 'AUTOPLUS' ? env.SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_REPORT?.trim() : '';
      // 홈피 전수 읽기가 불완전 없이 끝난 시각 — 오토플러스 신선도 근거(대표: 홈피가 정본). ERP4 수집 단계 성공 시각과 더 최근 쪽을 쓴다.
      let homepageFreshAt: string | null = null;
      // 손오공 원천↔ERP5 문서 차이표 관측(사용자 대조: 화면 331 vs 반영 135): SOURCE_CYCLE_SONOGONG_REPORT=<보고 파일 경로> + SONOGONG_ACCOUNT_JSON 이
      // 있을 때만 버킷 3개를 직렬(250ms)로 읽어 번호 기준 NEW/MISSING/SAME 요약(건수·끝4·상태 분포)을 쓴다. 쓰기 0, 실패는 회차에 영향 없음.
      const sonogongReport = kind === 'SONOGONG' ? env.SOURCE_CYCLE_SONOGONG_REPORT?.trim() : '';
      const observeSonogong = async (docs: Array<{ fields: Record<string, unknown> }>) => {
        try {
          if (!env.SONOGONG_ACCOUNT_JSON) throw new Error('SONOGONG_ACCOUNT_REQUIRED');
          const reader = createSonogongErpReader({ accountJson: () => env.SONOGONG_ACCOUNT_JSON! });
          const observations = [];
          for (const bucket of ['LOW_SONOKONG_DAILY', 'LOW_SONOKONG', 'LOW_TCAR'] as const) observations.push(await reader.readBucket(bucket));
          const summary = summarizeSonogong(observations, docs.map(d => {
            const f = decodeFields(d.fields as never) as Record<string, unknown>;
            return { plate: typeof f.car_number === 'string' ? f.car_number : null, listable: f.listable === true, status: typeof f.status === 'string' ? f.status : null };
          }));
          await writeFile(sonogongReport!, JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 1), { mode: 0o600 });
        } catch (e) {
          const code = e instanceof Error && /^[A-Z][A-Z0-9_]{2,40}$/.test(e.message) ? e.message : 'SONOGONG_OBSERVE_FAILED';
          await writeFile(sonogongReport!, JSON.stringify({ at: new Date().toISOString(), error: code }), { mode: 0o600 }).catch(() => undefined);
        }
      };
      const documents = async (sourceId: string) => {
        const docs = await commands.documents(sourceId);
        if (sonogongReport) await observeSonogong(docs as never);
        homepageFreshAt = null;
        if (homepageReport) {
          try {
            const client = createAutoplusHomepageClient({ fetcher: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }) as never });
            const collected = await collectAutoplusHomepage(client);
            const codes: Record<string, number> = {};
            for (const f of collected.failures) codes[f.code] = (codes[f.code] ?? 0) + 1;
            const comparison = compareAutoplusHomepage(collected.records, docs.map(d => {
              const f = decodeFields(d.fields as never) as Record<string, unknown>;
              return { plate: typeof f.car_number === 'string' ? f.car_number : null, listable: f.listable === true };
            }));
            if (collected.complete) homepageFreshAt = collected.observedAt;
            await writeFile(homepageReport, JSON.stringify({ at: new Date().toISOString(), complete: collected.complete, productCount: collected.productCount,
              excluded: collected.excluded.length, failureCodes: codes, held: collected.held.map(h => h.reason),
              duplicatePlates: collected.duplicatePlates.length, comparison }, null, 1), { mode: 0o600 });
          } catch (e) {
            await writeFile(homepageReport, JSON.stringify({ at: new Date().toISOString(), error: e instanceof Error && /^[A-Z][A-Z0-9_]{2,40}$/.test(e.message) ? e.message : 'HOMEPAGE_OBSERVE_FAILED' }), { mode: 0o600 }).catch(() => undefined);
          }
        }
        return docs;
      };
      const evidence = kind === 'AUTOPLUS' && homepageReport ? async () => {
        // 홈피 관측 신선도와 저장 데이터 반영 신선도를 분리한다(독립 검토 2026-10-14): 홈피를 방금 읽어도 문서가 낡았을 수 있으므로
        // 홈피 완전 읽기 AND ERP4 수집 성공 중 «오래된 쪽»을 신선도 근거로 쓴다. ERP4 근거를 확인할 수 없으면 신선하다고 보지 않는다.
        const home = homepageFreshAt as string | null;
        if (!collectionEvidence) return home;
        const erp4 = await collectionEvidence().catch(() => null);
        if (!home || !erp4) return null;
        return Date.parse(home) < Date.parse(erp4) ? home : erp4;
      } : collectionEvidence;
      // 오토플러스 홈피 쓰기 모드는 폐기(대표 2026-10-14 «구버전 과감하게 폐기, 어설프게 양립하다가 다 망해»): RP023 쓰기 경로는 시트 하나뿐.
      // ERP4 의 RP023 쓰기 제외가 먼저 배포되어야 한다(이중 쓰기 금지).
      // 오토플러스 시트 우선(대표 2026-10-14: 정본 = 구글시트, 홈피는 보조 교차). SOURCE_CYCLE_AUTOPLUS_SHEET=1 + SOURCE_CYCLE_AUTOPLUS_SHEET_ID(공급사 원본 시트 ID, 저장소에 두지 않는다).
      // 홈피 관측 보고(교차 확인)는 위 documents 래퍼가 계속 만든다. 시트 읽기가 불완전하면 쓰기·부재 하향이 막힌다.
      // 손오공 공식 파트너 API(대표 2026-10-14 «손오공 연동»): SOURCE_CYCLE_SONOGONG_API=1 + SONOGONG_API_KEY + SONOGONG_API_BASE 가 모두 있을 때만.
      // 키가 없으면 이 분기에 들어오지 않아 호출 0(아래 관측 플러그인 유지). 키·URL·응답 본문은 코드·로그·시험에 남기지 않는다.
      if (kind === 'SONOGONG' && sonogongApiEnabled(env)) {
        const apiBase = env.SONOGONG_API_BASE!.trim(), apiKey = env.SONOGONG_API_KEY!.trim();
        const passFile = join(directory, 'sonogong-api-pass.json'), countFile = join(directory, 'sonogong-api-count.json');
        const oncePath = join(directory, 'sonogong-enroll-cap-once.done');
        const onceCap = Number(env.SOURCE_CYCLE_SONOGONG_ENROLL_CAP_ONCE ?? '0');
        const apiPlugin = plateUidPlugin(sonogongApiWritePlugin(ratio, async () => {
          const observedAt = new Date().toISOString();
          const soft = (reason: string): SonogongApiRead => ({ observedAt, complete: false, incompleteReason: reason, tabsRead: [], listed: 0, detailsRead: 0,
            notes: [], records: [], held: [], duplicatePlates: [] });
          // 부하 방어: 마지막 완전 읽기 후 55분 안에는 다시 읽지 않는다(손오공 데이터는 1시간 단위 갱신, 상세 최대 600건·간격 1.5초).
          // 간격 기록은 «무인 정시 회차»만 남기고 지킨다: 수동 계획(DRY_RUN) 읽기가 간격을 소비해 같은 시간대 무인 APPLY 를 막지 않게 한다(B3Q 10-14).
          const unattended = env.SOURCE_CYCLE_UNATTENDED === '1';
          if (unattended) try {
            const pass = JSON.parse(await readFile(passFile, 'utf8')) as { at?: unknown };
            if (typeof pass.at === 'string' && Date.now() - Date.parse(pass.at) < SONOGONG_API_POLICY.minPassIntervalMinutes * 60_000) return soft('SONOGONG_API_PASS_INTERVAL');
          } catch { /* 최초·읽기 불가는 허용 — 아래 읽기 안전장치가 막는다 */ }
          const client = createSonogongApiClient({ base: apiBase, key: apiKey });
          const read = await readSonogongApi(client);
          // 행 수 하한(부분 읽기 방어): 잠금 제외 노출 문서 80%·직전 정상 회차 목록 수 80% 중 큰 값. 기준 파일 손상은 이번 회차만 불인정 후 복구.
          const exposedDocs = (await commands.documents('RP012')).filter(d => {
            const f = decodeFields(d.fields as never) as Record<string, unknown>;
            const locked = (f.locked_by_contract !== undefined && f.locked_by_contract !== null && f.locked_by_contract !== false && f.locked_by_contract !== '')
              || f.status === '계약중' || f.status_kind === '계약중';
            return f.listable === true && !locked;
          }).length;
          let previous = 0, stateError: string | null = null;
          try {
            const parsed = JSON.parse(await readFile(countFile, 'utf8')) as { count?: unknown };
            if (typeof parsed.count === 'number' && Number.isSafeInteger(parsed.count) && parsed.count > 0) previous = parsed.count; else stateError = 'API_COUNT_STATE_INVALID';
          } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') stateError = 'API_COUNT_STATE_INVALID'; }
          // 판정은 순수 함수(시험 가능): 축소·불완전 읽기는 기준 파일에 저장하지 않고, 하한은 고유 차량번호 수 기준이다(#601 독립 검토).
          const verdict = judgeSonogongApiRead(read, { exposedUnlockedDocs: exposedDocs, previousCount: previous, stateError });
          let complete = verdict.complete, reason = verdict.incompleteReason;
          if (verdict.saveCount !== null) {
            const saved = (await writeJsonAtomic(countFile, { count: verdict.saveCount, at: observedAt })) &&
              (!verdict.complete || !unattended || await writeJsonAtomic(passFile, { at: observedAt }));
            if (verdict.complete && !saved) { complete = false; reason = 'API_COUNT_STATE_WRITE_FAILED'; }
          }
          // 한 회차 한정 편입 상한: 이 읽기 콜백은 원천 잠금 «안»에서 실행된다. 적용 «전에» 표식을 원자적으로 기록하고,
          // 기록 실패·읽기 불가·소진이면 상한을 올리지 않는다(보수적으로 확정 상한).
          delete apiPlugin.enrollCapOnce;
          if (complete && Number.isSafeInteger(onceCap) && onceCap > 100 && env.SOURCE_CYCLE_UNATTENDED === '1') {
            const claim = await claimEnrollCapOnce({
              read: async () => readFile(oncePath, 'utf8').catch(e => { if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null; throw e; }),
              write: async text => { const tmp = `${oncePath}.${process.pid}.tmp`;
                try { await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, oncePath); return true; } catch { await unlink(tmp).catch(() => undefined); return false; } },
            }, onceCap, observedAt);
            if (claim.granted) apiPlugin.enrollCapOnce = onceCap;
          }
          // API 교체 철회(대표 «손오공 기존 거 지우고 API 로»): 첫 «완전 읽기» 회차 한 번만, API 에 없는 기존 노출 문서를 부재 하향 대신 REPLACED_BY_API 로
          // 철회한다(삭제 아님, 계약 잠금은 건드리지 않음, 비율 가드 제외). 표식을 잠금 안에서 적용 전에 원자적으로 기록하고, 기록 실패·소진이면 철회하지 않는다.
          // 읽기 실패·API_SHRUNK 등 불완전이면 이 블록에 오지 않아 기존 문서는 그대로 남는다(공백 방지).
          // 일반 부재 하향의 사유 라벨은 NOT_IN_API(API 에 없음, 같은 비율 가드). 교체 철회 회차에만 REPLACED_BY_API(잠금 문서 노출도 내림).
          apiPlugin.absenceReason = 'NOT_IN_API';
          if (complete && env.SOURCE_CYCLE_SONOGONG_REPLACE_ONCE === '1' && env.SOURCE_CYCLE_UNATTENDED === '1') {
            const replacePath = join(directory, 'sonogong-replace-once.done');
            const claim = await claimEnrollCapOnce({
              read: async () => readFile(replacePath, 'utf8').catch(e => { if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null; throw e; }),
              write: async text => { const tmp = `${replacePath}.${process.pid}.tmp`;
                try { await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, replacePath); return true; } catch { await unlink(tmp).catch(() => undefined); return false; } },
            }, 1, observedAt);
            if (claim.granted) apiPlugin.absenceReason = 'REPLACED_BY_API';
          }
          return { ...read, complete, ...(reason ? { incompleteReason: reason } : {}) };
        }));
        plugins.push(apiPlugin);
      } else
      if (kind === 'AUTOPLUS' && env.SOURCE_CYCLE_AUTOPLUS_SHEET === '1') {
        const sheetId = (env.SOURCE_CYCLE_AUTOPLUS_SHEET_ID ?? '').trim();
        if (!/^[A-Za-z0-9_-]{20,80}$/.test(sheetId)) throw new Error('CYCLE_SOURCE_CONFIG_INVALID');
        plugins.push(plateUidPlugin(sourceCyclePlugin({ sourceId: 'RP023', kind: 'AUTOPLUS', scopes: ['sheet'], maxDowngradeRatio: ratio }, async () => {
          const observedAt = new Date().toISOString();
          const gws = async (args: string[], params: Record<string, unknown>): Promise<Record<string, unknown>> => {
            if (sheetsAdc) {
              const batch = args.includes('batchGet');
              const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(String(params.spreadsheetId))}${batch ? '/values:batchGet' : ''}`);
              for (const [k, v] of Object.entries(params)) if (k !== 'spreadsheetId') for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(one));
              return await readSheetsUrl(url) as Record<string, unknown>;
            }
            return JSON.parse(execFileSync(gwsBin(), [...args, '--params', JSON.stringify(params)],
              { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/^[^{]*/, '')) as Record<string, unknown>;
          };
          const incomplete = (reason: string) => ({ observedAt, complete: false, completedScopes: [] as string[], visibilityComplete: false, incompleteReason: reason, heldCount: 0, rows: [] });
          let tabs: AutoplusSheetTab[];
          try {
            const meta = await gws(['sheets', 'spreadsheets', 'get'], { spreadsheetId: sheetId, fields: 'sheets(properties(title,hidden))' }) as
              { sheets?: Array<{ properties?: { title?: string; hidden?: boolean } }> };
            const titles = (meta.sheets ?? []).filter(x => x.properties?.title && !x.properties.hidden).map(x => x.properties!.title!);
            if (!titles.length) return incomplete('SHEET_TABS_NOT_FOUND');
            const got = await gws(['sheets', 'spreadsheets', 'values', 'batchGet'], { spreadsheetId: sheetId,
              ranges: titles.map(t => `'${t.replace(/'/g, "''")}'!A1:AB1500`), valueRenderOption: 'FORMATTED_VALUE' }) as { valueRanges?: Array<{ values?: unknown[][] }> };
            tabs = titles.map((title, i) => ({ title, values: got.valueRanges?.[i]?.values ?? [] }));
          } catch { return incomplete('SHEET_READ_FAILED'); }
          const read = readAutoplusSheet(tabs, observedAt);
          // 잠금·계약중 차는 시트에서 내려가도 정산 전 노출을 유지하므로 행 수 하한 계산에서 뺀다.
          const exposedDocs = (await commands.documents('RP023')).filter(d => {
            const f = decodeFields(d.fields as never) as Record<string, unknown>;
            const locked = (f.locked_by_contract !== undefined && f.locked_by_contract !== null && f.locked_by_contract !== false && f.locked_by_contract !== '')
              || f.status === '계약중' || f.status_kind === '계약중';
            return f.listable === true && !locked;
          }).length;
          const countFile = join(directory, 'autoplus-sheet-count.json');
          let previous = 0, stateError: string | null = null;
          try {
            const parsed = JSON.parse(await readFile(countFile, 'utf8')) as { count?: unknown };
            if (typeof parsed.count === 'number' && Number.isSafeInteger(parsed.count) && parsed.count > 0) previous = parsed.count; else stateError = 'SHEET_COUNT_STATE_INVALID';
          } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') stateError = 'SHEET_COUNT_STATE_INVALID'; }
          const floor = autoplusSheetRowFloor(exposedDocs, previous);
          let complete = read.complete, reason = read.incompleteReason;
          if (complete && read.rowCount < floor) { complete = false; reason = 'SHEET_SHRUNK'; }
          if (complete && stateError) { complete = false; reason = stateError; }
          if (complete) {
            const tmp = `${countFile}.${process.pid}.tmp`;
            try { await writeFile(tmp, JSON.stringify({ count: read.rowCount, at: observedAt }), { mode: 0o600 }); await rename(tmp, countFile); }
            catch { await unlink(tmp).catch(() => undefined); }
          }
          return { observedAt, complete, completedScopes: complete ? ['sheet'] : [], visibilityComplete: true, ...(reason ? { incompleteReason: reason } : {}),
            heldCount: read.held.length + read.duplicatePlates.length, rows: read.records.map(record => ({ scope: 'sheet', record })) };
        })));
      } else plugins.push(collectorObservationPlugin(kind, ratio, documents, Date.now, evidence));
    } else throw new Error('CYCLE_SOURCE_CONFIG_INVALID');
  }
  // 대표 지시로 내린 공급사(계약서 목록)는 매 회차 노출 문서를 내린다. 같은 공급사가 일반 원천으로도 읽히면 중복 쓰기 충돌로 멈춘다.
  for (const supplier of withdrawnSuppliers.suppliers) plugins.push(decisionWithdrawnPlugin(supplier.code));
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
  // SHEETS_TRANSPORT=adc(온라인 실행기)는 gws 가 필요 없다. 그 외에는 기존대로 gws 필수.
  if (sheets && env.SHEETS_TRANSPORT !== 'adc' && !probes.gwsBin(env)) missing.push('PREFLIGHT_GWS_MISSING');
  if (kinds.includes('F05') && env.SHEETS_TRANSPORT !== 'gws' && env.SHEETS_TRANSPORT !== 'adc') missing.push('PREFLIGHT_SHEETS_TRANSPORT_UNSET');
  try { if (!(await probes.gcloudToken())) missing.push('PREFLIGHT_GCLOUD_TOKEN_MISSING'); }
  catch { missing.push('PREFLIGHT_GCLOUD_TOKEN_MISSING'); }
  return missing;
}

/** 폐기된 설정 알림(Codex 독립 검토 2026-10-15): 예전 SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_WRITE 는 더 이상 RP023 쓰기를 열지 않는다(쓰기 = 시트 하나, SOURCE_CYCLE_AUTOPLUS_SHEET=1).
 * 이 변수만 켜진 환경이 «오류·안내 없이» 관측 전용으로 바뀌어 RP023 쓰기가 멈추는 일을 막기 위해, 설정이 있으면 항상 코드로 알리고 쓰기 유지 여부를 명시한다.
 *  - …_RP023_OBSERVATION_ONLY: 시트 쓰기가 켜져 있지 않아 RP023 은 관측 전용이다(쓰기 중단) — 변수를 지우고 SOURCE_CYCLE_AUTOPLUS_SHEET=1 로 바꿔야 쓴다.
 *  - …_IGNORED_SHEET_WRITE_KEPT: 시트 쓰기가 켜져 있어 RP023 쓰기는 유지된다 — 폐기 변수는 무시되므로 지우면 된다. */
export function deprecatedConfigNotices(env: NodeJS.ProcessEnv): Array<{ code: string; blocksWrites: boolean }> {
  const legacy = (env.SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_WRITE ?? '').trim();
  if (!legacy) return [];
  return env.SOURCE_CYCLE_AUTOPLUS_SHEET === '1'
    ? [{ code: 'DEPRECATED_AUTOPLUS_HOMEPAGE_WRITE_IGNORED_SHEET_WRITE_KEPT', blocksWrites: false }]
    : [{ code: 'DEPRECATED_AUTOPLUS_HOMEPAGE_WRITE_RP023_OBSERVATION_ONLY', blocksWrites: true }];
}

/** 스케줄러가 부르는 한 회차: 사전점검 → 계획·적용(원천별) → 신선도 판정 → 실행 기록 한 줄(unattended-runs.jsonl). 토큰·원문은 기록하지 않는다. */
export async function runUnattended(args: string[], env: NodeJS.ProcessEnv, acceptDrift: string[], probes: UnattendedProbes = defaultProbes) {
  const directory = env.SOURCE_CYCLE_PRIVATE_DIR || join(homedir(), '.codex', 'private', 'source-cycle');
  const source = args.indexOf('--source') >= 0 ? args[args.indexOf('--source') + 1] : undefined;
  const record: { started: string; finished: string; exit: number; preflight?: string[]; error?: string; configNotices?: string[];
    reports?: Array<{ source: string; stage: string; status: string; summary: string; digest: string | null;
      /** 공급사별 노출(listable=true) 수 전후: before=이번 회차 시작 전, after=이번 회차 적용 뒤(미적용이면 before 와 같다).
       *  prior=직전 회차 기록의 after. unexplained=before-prior(회차 밖에서 바뀐 수, 0 이면 설명됨). */
      exposure?: { before: number; after: number | null; applied: boolean; prior: number | null; unexplained: number | null;
        /** 원천에서 판매 가능으로 읽은 대수와 적용 뒤 노출 대수의 차(대표 2026-10-14: 대수를 맞추고 그 대수의 데이터를 신선하게). 보류 행이 있으면 일부는 정당하다. */
        sourceSellable: number | null; gap: number | null } }>;
    freshness?: ReturnType<typeof assessFreshness> } = { started: new Date().toISOString(), finished: '', exit: 0 };
  const alert = (reason: string) => appendFile(join(directory, 'alerts.jsonl'),
    JSON.stringify({ source: 'RUNNER', reason, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  await mkdir(directory, { recursive: true });
  try {
    const kinds = (env.SOURCE_CYCLE_SOURCES ?? '').split(',').map(x => x.trim()).filter(Boolean);
    // 폐기 설정은 조용히 넘기지 않는다: 코드를 실행 기록·알림에 남기고, 쓰기가 막히는 경우(시트 쓰기 미설정)는 회차를 실패(exit 1)로 눈에 띄게 한다.
    const notices = deprecatedConfigNotices(env);
    if (notices.length) {
      record.configNotices = notices.map(n => n.code);
      for (const notice of notices) await alert(notice.code);
      if (notices.some(n => n.blocksWrites)) record.exit = 1;
    }
    record.preflight = await unattendedPreflight(env, kinds, probes);
    if (record.preflight.length) { record.exit = 1; await alert(record.preflight.join(',')); }
    else {
      const runtime = createSourceCycleRuntime(env, fetch, acceptDrift);
      const selected = runtime.plugins.filter(p => !source || p.sourceId === source);
      if (!selected.length) throw new Error('ONE_SOURCE_REQUIRED');
      record.reports = [];
      // 직전 회차 기록의 원천별 «적용 뒤 노출 수» — 이번 회차 시작 노출 수와 비교해 회차 밖 증감(다른 쓰기 주체·수동 작업)을 표시한다.
      const priorAfter = new Map<string, number>();
      try {
        // 한 원천만 돌린 회차(-Source)가 끼어도 다른 원천의 직전 값을 잃지 않도록 최근 기록 줄들을 오래된 순으로 훑어 원천별 마지막 값을 쓴다.
        const recent = (await readFile(join(directory, 'unattended-runs.jsonl'), 'utf8')).split('\n').filter(l => l.trim()).slice(-100);
        for (const line of recent) {
          let parsed: { reports?: Array<{ source: string; exposure?: { after?: number } }> };
          try { parsed = JSON.parse(line.replace(/^﻿/, '')); } catch { continue; }
          for (const r of parsed.reports ?? []) if (typeof r.exposure?.after === 'number') priorAfter.set(r.source, r.exposure.after);
        }
      } catch { /* 첫 회차 또는 기록 없음 */ }
      for (const plugin of selected) {
        const result = await runUnattendedSourceCycle(plugin, runtime.commands, runtime.control,
          { onlyWhenSynced: args.includes('--only-when-synced') && plugin.family === 'IANCAR' });
        let exposure: NonNullable<typeof record.reports>[number]['exposure'];
        const plan = 'plan' in result ? result.plan : null;
        if (plan && typeof plan.exposedBefore === 'number') {
          const count = (kind: string) => plan.entries.filter(e => e.kind === kind).length;
          // 비노출 편입(INFO_INCOMPLETE)은 노출 집계에 넣지 않는다 — gap 허위 0 방지(독립 검토 2026-10-14).
          const exposedEnroll = plan.entries.filter(e => e.kind === 'ENROLL' && e.after.listable).length;
          const applied = result.stage === 'APPLY' && result.status === 'APPLIED';
          const before = plan.exposedBefore;
          // APPLY_UNCERTAIN 은 일부만 쓰였을 수 있어 노출 대수를 알 수 없다 — 추정값 대신 «미확인»(null)으로 기록한다(독립 검토 2026-10-14).
          // 쓰기 결과를 확정할 수 없는 모든 경우(불확실·연속 실패 정지·적용 단계의 비정상 종료)는 «미확인»이다(독립 검토 2026-10-14).
          // 판정은 상태 이름이 아니라 «적용 단계에 도달했는지(쓰기 시도·성공 수)» 로 한다: 상품 적용 뒤 heartbeat 실패는 HOLD/PLAN 으로 분류돼도
          // 실제로는 일부·전부 반영됐다(독립 검토 4차).
          const writes = 'writes' in result ? (result as { writes?: number | null }).writes : 0;
          const uncertain = result.status === 'APPLY_UNCERTAIN' || result.status === 'STOPPED' ||
            (result.status !== 'APPLIED' && (writes === null || (typeof writes === 'number' && writes > 0))) ||
            (result.stage === 'APPLY' && result.status !== 'APPLIED' && plan.entries.length > 0);
          const after = uncertain ? null : applied ? before - count('DOWNGRADE') + exposedEnroll + count('REEXPOSE') : before;
          const prior = priorAfter.get(plugin.sourceId) ?? null;
          const sourceSellable = typeof plan.sourceCount === 'number' ? plan.sourceCount : null;
          exposure = { before, after, applied, prior, unexplained: prior === null ? null : before - prior,
            sourceSellable, gap: sourceSellable === null || after === null ? null : sourceSellable - after };
        }
        record.reports.push({ source: plugin.sourceId, stage: result.stage, status: result.status, summary: result.summary,
          digest: 'planDigest' in result ? result.planDigest : null, ...(exposure ? { exposure } : {}) });
      }
      const lines = async (name: string) => (await readFile(join(directory, name), 'utf8').catch(() => '')).split('\n');
      record.freshness = assessFreshness(await lines('heartbeats.jsonl'), await lines('alerts.jsonl'),
        { maxAgeMinutes: Number(env.SOURCE_CYCLE_MAX_AGE_MINUTES ?? '120'), only: selected.map(p => p.sourceId),
          knownFalsePositive: (env.SOURCE_CYCLE_STALE_FALSE_POSITIVE ?? '').split(',').map(v => v.trim()).filter(Boolean),
          exempt: parseFreshnessExempt(env.SOURCE_CYCLE_FRESHNESS_EXEMPT),
          // 원천별 임계값: 설정(SOURCE_CYCLE_FRESHNESS_THRESHOLDS)이 우선, 없으면 손오공 API 모드에서만 기본 90분 정체·180분 에스컬레이션(커맨드 센터 10-14).
          sourceThresholds: env.SOURCE_CYCLE_FRESHNESS_THRESHOLDS !== undefined ? parseFreshnessThresholds(env.SOURCE_CYCLE_FRESHNESS_THRESHOLDS)
            : sonogongApiEnabled(env) ? parseFreshnessThresholds('RP012=90:180:SONOGONG_API_STAGNANT') : [] });
      if (record.reports.some(r => ['HOLD', 'STOPPED', 'APPLY_UNCERTAIN'].includes(r.status)) || record.freshness.status !== 'HEALTHY') record.exit = 1;
      // 즉시 실행 요청(처리기가 SOURCE_CYCLE_REQUEST_RUN=1 로 부름)은 «실제로 읽고 계획했는지»가 중요하다: 잠금(LOCKED)·변경 없음 생략(UNCHANGED_SYNC)은
      // 정시 실행에는 정상이지만 요청에는 «미실행»이므로 종료 코드 3 으로 알려 처리기가 요청을 소비하지 않고 되돌리게 한다(독립 검토 2026-10-14).
      else if (env.SOURCE_CYCLE_REQUEST_RUN === '1' && record.reports.some(r => ['LOCKED', 'UNCHANGED_SYNC'].includes(r.status))) record.exit = 3;
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

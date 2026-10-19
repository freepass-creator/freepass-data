import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendFile, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { firestoreCycleCommands, decodeFields, productRecord, gcloudUserToken } from '../infra/source-cycle-firestore.js';
import { resolveGwsBin } from '../infra/gws-bin.js';
import { readSheetsUrl } from '../infra/shared-sheet-capture-reader.js';
import { judgeSheetCount, parseSheetCountState, SHEET_SHRINK_RATIO } from '../adapters/sheet-count-guard.js';
import { assessFreshness, parseFreshnessExempt, parseFreshnessThresholds } from '../application/source-freshness.js';
import { latestCollectionSuccess } from '../application/erp4-collection-evidence.js';
import { captureSharedSheetReadOnly } from '../jobs/capture-shared-sheet.js';
import { sharedSheetChannels, assertCurrentSharedSheetSource, sharedSheetCaptureDigest, type SharedSheetCapture } from '../adapters/shared-sheet-source.js';
import { ingestSharedSheetObservedRows } from '../jobs/ingest-shared-sheet-canonical.js';
import { sourceCyclePlugin, iancarCyclePlugin, decisionWithdrawnPlugin, AICA_SCOPES, type CyclePlugin, type CycleCapture } from '../adapters/source-cycle-plugins.js';
import withdrawnSuppliers from '../../contracts/withdrawn-suppliers.v1.json' with { type: 'json' };
import { f05NativeCapture, aicaNativeCapture, aicaNativePlugin, ironNativeCapture, plateUidPlugin, type Visibility } from '../adapters/source-cycle-native.js';
import { collectIancarOneFullFacts, iancarOneApiConfigFromEnv, collectIancarOneVehicleList } from '../adapters/iancar-one-api.js';
import { parseIancarDetailCache, mergeIancarDetailCache, type IancarDetailCache, type IancarDetailCacheEntry } from '../adapters/iancar-detail-cache.js';
import { fileCycleControl } from '../adapters/source-cycle-control.js';
import { createAutoplusHomepageClient, collectAutoplusHomepage, compareAutoplusHomepage } from '../adapters/autoplus-homepage.js';
import { readAutoplusSheet, autoplusSheetRowFloor, type AutoplusSheetTab } from '../adapters/autoplus-sheet.js';
import { createSonogongErpReader } from '../adapters/sonogong-erp-reader.js';
import { createSonogongApiClient, readSonogongApi, SONOGONG_API_POLICY, type SonogongApiRead } from '../adapters/sonogong-api.js';
import { parseDetailCache, waitForUpstreamRefresh, type DetailCache } from '../adapters/sonogong-detail-cache.js';
import { judgeSonogongApiRead, claimEnrollCapOnce } from '../adapters/sonogong-api-guards.js';
import { readIronHomepage, ironFloorRecords, IRON_HOMEPAGE_POLICY } from '../adapters/iron-homepage.js';
import { summarizeSonogong } from '../adapters/sonogong-observe.js';
import { runSourceCycle, runUnattendedSourceCycle } from '../jobs/source-cycle.js';
import type { CyclePlan, CycleControl, VehicleIdentityRefiner } from '../ports/source-cycle.js';
import { captureVehicleMasterSnapshotReadOnly, withSharedSheetCatalogAccess } from '../jobs/data-access-runtime.js';
import { verifiedMasterRecords, type VehicleMasterSnapshot } from '../adapters/vehicle-identity-inputs.js';
import { identityMastersFromVehicleMaster, refineEngineIdentity } from '../application/identity-promotion-plan.js';
import { stableDigest } from '../shared/stable-digest.js';
import { masterTrimFuelLookup } from '../domain/fuel-alias.js';
import { createHash } from 'node:crypto';
import { readXlsx } from '../adapters/xlsx-reader.js';
import { convertMaumcarWorkbook, MAUMCAR_SOURCE_ID, type MaumcarConversion } from '../adapters/maumcar-file.js';

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
/** 마음카(RP034) 파일 원천 플러그인(대표 2026-10-14·커맨드 센터 2026-10-16): 공급사가 보낸 XLSX 를 변환해 엔진 입력으로 넘긴다.
 * 파일은 «스냅숏»이지 전체 목록의 권위가 아니다 — 파일에 없는 차는 하향하지 않고(부재 판정 보류, 공급사 확인 필요) 보류 건수에 항상 1건을 더해 부재 하향을 막는다.
 * 같은 파일을 다시 적용해도 내용이 같으면 계획이 비어 쓰기가 없다(해시는 raw.source_file_sha256 로 기록). 번호 중복이 있으면 불완전. */
export function maumcarFilePlugin(ratio: number, collect: () => Promise<{ conversion: MaumcarConversion; observedAt: string }>) {
  return sourceCyclePlugin({ sourceId: MAUMCAR_SOURCE_ID, kind: 'FILE', scopes: ['file'], maxDowngradeRatio: ratio }, async () => {
    const { conversion, observedAt } = await collect();
    const duplicates = conversion.duplicatePlates.length > 0;
    const report = conversion.reportOnly;
    return { observedAt, complete: !duplicates, completedScopes: duplicates ? [] : ['file'], visibilityComplete: true,
      ...(duplicates ? { incompleteReason: 'DUPLICATE_PLATES' } : {}),
      notes: [...conversion.notes, `PRE_RELEASE_REPORT_ONLY:${report.preReleaseRows}`, ...report.headerlessSheets.map(s => `HEADERLESS_SHEET_REPORT_ONLY:${s.rows}`)],
      heldCount: conversion.held.length + 1,
      heldReasons: [...conversion.held.map(h => `${h.reason}:UPSTREAM_ROW_HOLD`), 'ABSENCE_NOT_AUTHORITATIVE:UPSTREAM_ROW_HOLD'],
      rows: conversion.records.map(record => ({ scope: 'file', record })) } as CycleCapture;
  }) as ReturnType<typeof sourceCyclePlugin>;
}

/** 손오공 공식 API 쓰기 플러그인: API 읽기 결과(번호 키·계약중=선점 표시·요금·사진)를 엔진 레코드로 넘긴다. 읽기가 불완전하면 부재 하향·적용이 막힌다. */
export function sonogongApiWritePlugin(ratio: number, collect: () => Promise<SonogongApiRead>) {
  return sourceCyclePlugin({ sourceId: 'RP012', kind: 'SONOGONG', scopes: ['api'], maxDowngradeRatio: ratio }, async () => {
    const c = await collect();
    return { observedAt: c.observedAt, complete: c.complete, completedScopes: c.complete ? ['api'] : [], visibilityComplete: true,
      ...(c.incompleteReason ? { incompleteReason: c.incompleteReason } : {}),
      ...(c.notes.length ? { notes: c.notes } : {}),
      heldCount: c.held.length + c.duplicatePlates.length,
      // 행별 보류 사유를 보고에 그대로(PLATE_INVALID·STATUS_UNKNOWN·ID_MISSING…). 이 행들은 레코드가 없어 다른 차의 부재 판정을 가릴 수 있으므로
      // «:UPSTREAM_ROW_HOLD» 를 붙여 값 계열 보류(benign)로 세지 않게 한다 — 부재 하향을 건너뛰는 보수 동작은 그대로다(보고 코드는 앞부분만 쓴다).
      heldReasons: [...c.held.map(h => `${h.reason}:UPSTREAM_ROW_HOLD`), ...c.duplicatePlates.map(() => 'DUPLICATE_PLATE:UPSTREAM_ROW_HOLD')],
      rows: c.records.map(record => ({ scope: 'api', record })) };
  }) as ReturnType<typeof sourceCyclePlugin>;
}
/** 손오공 공식 API 연동이 «완전히» 켜졌는지: 스위치 + 키 + 기준 주소. 하나라도 없으면 false(네트워크 호출 0, RP012 는 관측 전용). 키 값은 어디에도 남기지 않는다. */
/** 엔진 회차 정체성 정제용 차종 마스터(대표 2026-10-15 «손오공 새로 API 연동해서 땡겨온 애들은 … 모델명도 정제되어 있지 않고»): 회차마다 «한 번» 기존 읽기 경로
 * (captureVehicleMasterSnapshotReadOnly — 데이터 접근 게이트웨이·원자 읽기)로 활성 마스터를 읽고, 기존 검증기(verifiedMasterRecords: 최신성·digest·완전성·이름 일치)를
 * 통과할 때만 대조기를 만든다. 못 읽거나 검증에 실패하면 null(정제 안 함 = 지금 동작)이고 상태 코드만 남긴다. 값·번호는 남기지 않는다. */
export async function loadIdentityRefiner(load: () => Promise<unknown>, now: () => number = Date.now, timeoutMs = 120_000):
  Promise<{ status: string; refiner: VehicleIdentityRefiner | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const snapshot = await Promise.race([load(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('VEHICLE_MASTER_READ_TIMEOUT')), timeoutMs); })]) as VehicleMasterSnapshot;
    // A server-issued readTime can be slightly ahead of the collector clock. Wait for real
    // time to catch up once; keep the sealed timestamp and the existing validator unchanged.
    // Large skew and a clock that fails to advance still fail closed.
    const futureMs = Date.parse(snapshot?.readAt) - now();
    if (futureMs > 1000 && futureMs <= Math.min(5000, timeoutMs)) {
      await new Promise(resolve => setTimeout(resolve, futureMs + 1));
    }
    let records;
    try { records = verifiedMasterRecords(snapshot, now()); }
    catch { return { status: 'SKIPPED:VEHICLE_MASTER_INVALID', refiner: null }; }
    const masters = identityMastersFromVehicleMaster({ masters: snapshot.masters, records });
    if (!masters.length) return { status: 'SKIPPED:VEHICLE_MASTER_EMPTY', refiner: null };
    const digest = stableDigest(masters);
    const eligibleTrims = new Set(records.map(r => r.trimId));
    return { status: `ENABLED:${digest.slice(0, 12)}`, refiner: { digest, match: input => refineEngineIdentity(input, masters), makers: [...new Set(masters.map(m => m.maker.trim()).filter(Boolean))].sort(),
      allowsYear: (id, year) => Number.isInteger(year) && masters.some(m => m.id === id && m.yearFrom !== null &&
        year >= m.yearFrom && (m.yearTo === null || year <= m.yearTo)) &&
        (year <= new Date(now()).getUTCFullYear() || snapshot.trims.some(t => eligibleTrims.has(t.id) &&
          t.data.master_id === id && /^(?:19|20)\d{2}$/.test(String(t.data.model_year_start ?? '')) &&
          Number(t.data.model_year_start) === year)),
      ...modelTablesFromMasters(masters),
      // 확정 정체성 → vehicle_trim_master 연료(하나로 모일 때만, 대표 2026-10-19): 제원 채움이 원천에 연료가 없을 때만 쓴다.
      trimFuel: masterTrimFuelLookup(records) } };
  } catch (e) {
    return { status: e instanceof Error && e.message === 'VEHICLE_MASTER_READ_TIMEOUT' ? 'SKIPPED:VEHICLE_MASTER_READ_TIMEOUT' : 'SKIPPED:VEHICLE_MASTER_UNAVAILABLE', refiner: null };
  } finally { if (timer) clearTimeout(timer); }
}
/** 입구 매핑이 쓰는 마스터 모델 표(순수): 허용 집합 = 마스터 «정식 모델 이름»만, 별칭은 «정식 이름으로 변환» 표로만(별칭 자체가 «신형 카니발» 같은 금지 표기일 수 있다).
 * 같은 제조사에서 한 별칭(정규화 키: 공백·대소문자 무시)이 서로 다른 정식 모델 둘 이상에 있으면 모호하므로 그 별칭은 제외한다(틀린 모델을 쓰지 않는다, Codex #706). */
export function modelTablesFromMasters(masters: ReadonlyArray<{ maker: string; model: string; model_aliases: readonly string[] }>):
  { models: Record<string, readonly string[]>; modelAliases: Record<string, Record<string, string>> } {
  const key = (v: string): string => v.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const models: Record<string, Set<string>> = {};
  for (const m of masters) {
    const maker = m.maker.trim(), model = m.model.trim();
    if (maker && model) (models[maker] ??= new Set<string>()).add(model);
  }
  const canonicalKeys = (maker: string): Set<string> => new Set([...(models[maker] ?? [])].map(key));
  const candidates: Record<string, Map<string, Map<string, string>>> = {};   // maker → aliasKey → (정식 키 → 정식 이름)
  for (const m of masters) {
    const maker = m.maker.trim(), model = m.model.trim();
    if (!maker || !model) continue;
    for (const alias of m.model_aliases) {
      const a = alias.trim();
      if (!a || key(a) === key(model)) continue;
      const byAlias = (candidates[maker] ??= new Map<string, Map<string, string>>());
      const targets = byAlias.get(key(a)) ?? byAlias.set(key(a), new Map<string, string>()).get(key(a))!;
      targets.set(key(model), model);
    }
  }
  const modelAliases: Record<string, Record<string, string>> = {};
  for (const [maker, byAlias] of Object.entries(candidates)) {
    const own = canonicalKeys(maker);
    for (const [aliasKey, targets] of byAlias) {
      if (targets.size !== 1 || own.has(aliasKey)) continue;   // 모호(정식 모델 둘 이상) 또는 다른 정식 이름과 같은 키
      (modelAliases[maker] ??= {})[aliasKey] = [...targets.values()][0]!;
    }
  }
  return { models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, [...v].sort()])), modelAliases };
}
export const sonogongApiEnabled = (env: NodeJS.ProcessEnv): boolean =>
  env.SOURCE_CYCLE_SONOGONG_API === '1' && !!env.SONOGONG_API_KEY?.trim() && !!env.SONOGONG_API_BASE?.trim();
export function createSourceCycleRuntime(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch, acceptDrift: string[] = [],
  ghApi: (path: string) => Promise<unknown> = defaultGhApi, loadVehicleMaster: () => Promise<unknown> = captureVehicleMasterSnapshotReadOnly) {
  const directory = env.SOURCE_CYCLE_PRIVATE_DIR || join(homedir(), '.codex', 'private', 'source-cycle');
  const ratio = Number(env.SOURCE_CYCLE_MAX_DOWNGRADE_RATIO ?? '0.2');
  if (!(ratio > 0 && ratio <= 1)) throw new Error('CYCLE_CONFIG_INVALID');
  // 정체성 정제: 기본 켜짐, SOURCE_CYCLE_IDENTITY_REFINE=0 이면 끔. 첫 목록 읽기 때 한 번만 읽고(같은 Promise) 회차 내내 같은 마스터를 쓴다.
  // 입구 매핑이 켜진 공급사가 있으면 마스터(제조사 목록)를 읽어야 하므로 REFINE=0 이어도 로드한다(정제 자체는 identityRefine=false 로 끈 채).
  const sourceIdentitySources = (env.SOURCE_CYCLE_SOURCE_IDENTITY_SOURCES ?? '').split(',').map(v => v.trim()).filter(Boolean);
  // 정체성 정제 켜기(IDENTITY-SAME-CYCLE-DESIGN 2단계, 기본 꺼짐으로 뒤집음): SOURCE_CYCLE_IDENTITY_SOURCES=공급사 코드 목록(쉼표)일 때만 그 공급사에 켠다.
  // 목록이 없으면 SOURCE_CYCLE_IDENTITY_REFINE=1 일 때만 전체에 켠다(명시). 그 밖(미설정 포함)은 꺼짐 — 옵션 사고(#674)의 교훈: 무인 쓰기 경로는 기본 꺼짐.
  const identitySources = (env.SOURCE_CYCLE_IDENTITY_SOURCES ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const refineOff = env.SOURCE_CYCLE_IDENTITY_REFINE === '0' || (identitySources.length === 0 && env.SOURCE_CYCLE_IDENTITY_REFINE !== '1');
  // 제원 채움만 켜는 공급사(대표 2026-10-19 «연료가 빠지면 안 된다»): 입구 매핑(제조사·모델)은 켜지 않고 빈 제원 칸 채움·다시 채움만 켠다. 기본 꺼짐(쉼표 목록).
  // 입구 매핑 공급사(SOURCE_CYCLE_SOURCE_IDENTITY_SOURCES)는 지금처럼 제원 채움도 함께 한다.
  const specFillSources = (env.SOURCE_CYCLE_SPEC_FILL_SOURCES ?? '').split(',').map(v => v.trim()).filter(Boolean);
  let identityStatus = refineOff && !sourceIdentitySources.length && !specFillSources.length ? 'DISABLED' : 'NOT_LOADED';
  let identityLoad: Promise<VehicleIdentityRefiner | null> | null = null;
  const identity = () => identityLoad ??= identityStatus === 'DISABLED' ? Promise.resolve(null)
    : loadIdentityRefiner(loadVehicleMaster).then(r => { identityStatus = r.status; return r.refiner; });
  const commands = firestoreCycleCommands({ env, directory: join(directory, 'backups'), fetcher,
    // 오토플러스 홈피 쓰기 스위치가 켜지면 RP023 만 쓰기 허용(손오공 RP012 는 ERP4 승인 등록 경로가 쓰므로 계속 관측 전용).
    // 손오공 공식 API 쓰기(대표 2026-10-14): 스위치 SOURCE_CYCLE_SONOGONG_API=1 «과» 키·기준 주소가 모두 있을 때만 RP012 쓰기를 연다 — 키가 없으면 호출 0·관측 전용 유지.
    observationSources: [...(sonogongApiEnabled(env) ? [] : ['RP012']),
      ...(env.SOURCE_CYCLE_AUTOPLUS_SHEET === '1' ? [] : ['RP023'])], acceptDrift, writeMonthlyProductType: env.SOURCE_CYCLE_WRITE_MONTHLY_PRODUCT_TYPE === '1',
      // 손오공 API 옵션 칸(api_options_*)은 대표 재확인 뒤에만 켠다(기본 꺼짐). 켜면 회차당 100대 상한으로 채운다.
      writeApiOptions: env.SOURCE_CYCLE_WRITE_API_OPTIONS === '1',
      // 입구 매핑(원천 brand·model → 빈 maker·model): 기본 꺼짐. 공급사 코드 목록(쉼표)일 때만 그 공급사에 켠다(예: RP012). 회차당 100대 상한은 계획 단계가 건다.
      sourceIdentitySources, specFillSources,
      provenanceUids: (env.SOURCE_CYCLE_PROVENANCE_UIDS ?? '').split(',').map(v => v.trim()).filter(Boolean),
      identityRefine: !refineOff, ...(identitySources.length ? { identityRefineSources: identitySources } : {}), identity });
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
  // 시트 읽기 전송은 읽기 모듈의 단일 판정(resolveSheetsTransport)을 쓴다: SHEETS_TRANSPORT=gws 면 이미 인증된 gws(회사 계정 위임, 시간 제한 120초·
  // 실패 코드 분류), 그 밖은 ADC 읽기 전용 토큰(온라인 실행기: WIF 서비스 계정, 시트 «보기» 공유). 같은 F05 읽기 안의 캡처(capture-shared-sheet)도 같은 판정이다.
  const sheetsRead = (url: URL) => readSheetsUrl(url, { env });
  const get = async (url: URL, authenticated: boolean, retriedAuth = false): Promise<Response> => {
    if (authenticated && url.hostname === 'sheets.googleapis.com') return new Response(JSON.stringify(await sheetsRead(url)), { status: 200 });
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: authenticated ? { authorization: `Bearer ${await gcloudUserToken()}` } : {} });
    // 401 = 캐시 토큰 만료·무효: 한 번만 다시 발급해 재요청(createGcloudTokenSource 참고).
    if (authenticated && response.status === 401 && !retriedAuth) { gcloudUserToken.invalidate(); return get(url, false || authenticated, true); }
    if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
    return response;
  };
  const required = (key: string) => { const v = env[key]?.trim(); if (!v) throw new Error('SOURCE_CONFIGURATION_REQUIRED'); return v; };
  // 시트 원천(F05 공급사별·아이카) 급감 하한: 읽힌 행이 직전 정상 수·잠금 제외 노출 문서 수의 80% 를 둘 다 밑돌면 불완전(SOURCE_SHRUNK).
  // 기준 수는 오토플러스 시트와 같은 방식(비공개 폴더, 임시 파일 + 이름 바꾸기)으로 공급사마다 따로 둔다. 노출 문서 수는 필요할 때만 센다.
  const sheetCountGuard = async (sourceId: string, capture: CycleCapture): Promise<CycleCapture> => {
    const countFile = join(directory, `sheet-count-${sourceId}.json`);
    let countText: string | null = null, countReadError = false;
    try { countText = await readFile(countFile, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') countReadError = true; }
    const countState = parseSheetCountState(countText, countReadError);
    const previous = countState.previous, stateError: string | null = countState.stateError;
    const rows = capture.rows.length + capture.heldCount;
    const needExposed = capture.complete && (stateError !== null || previous === 0 || rows < previous * SHEET_SHRINK_RATIO);
    const exposed = needExposed ? (await commands.documents(sourceId)).filter(d => {
      const f = decodeFields(d.fields as never) as Record<string, unknown>;
      const locked = (f.locked_by_contract !== undefined && f.locked_by_contract !== null && f.locked_by_contract !== false && f.locked_by_contract !== '')
        || f.status === '계약중' || f.status_kind === '계약중';
      return f.listable === true && !locked;
    }).length : 0;
    const verdict = judgeSheetCount({ complete: capture.complete, rows, previousCount: previous, exposedUnlockedDocs: exposed, stateError });
    let complete = verdict.complete, reason = verdict.incompleteReason;
    if (verdict.saveCount !== null && verdict.saveCount > 0) {
      await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => undefined);
      if (!(await writeJsonAtomic(countFile, { count: verdict.saveCount, at: capture.observedAt })) && complete) { complete = false; reason = 'SHEET_COUNT_STATE_WRITE_FAILED'; }
    }
    return complete || !capture.complete ? capture : { ...capture, complete: false, ...(reason ? { incompleteReason: reason } : {}) };
  };
  const visibility = async (id: string): Promise<Visibility> => {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`);
    url.searchParams.set('includeGridData', 'true');
    url.searchParams.set('fields', 'sheets(properties(title,hidden,gridProperties(rowCount)),data(startRow,rowMetadata(hiddenByUser,hiddenByFilter)))');
    return (await get(url, true)).json();
  };
  const plugins: CyclePlugin<any>[] = [];
  const enabled = required('SOURCE_CYCLE_SOURCES').split(',').map(x => x.trim());
  let f05Capture: Promise<{ capture: SharedSheetCapture; observedCapture: SharedSheetCapture; visibility: Visibility }> | null = null;
  const readF05 = async () => {
    const id = required('SOURCE_CYCLE_F05_SHEET_ID'); assertCurrentSharedSheetSource(id);
    const fullUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values:batchGet`);
    for (const title of new Set(sharedSheetChannels.map(c => c.tab))) fullUrl.searchParams.append('ranges', `'${title.replace(/'/g, "''")}'`);
    const before = await visibility(id), rawBefore = await (await get(fullUrl, true)).json();
    const capture = await captureSharedSheetReadOnly(id), rawAfter = await (await get(fullUrl, true)).json(), after = await visibility(id);
    if (stableDigest(before) !== stableDigest(after)) throw new Error('SOURCE_VISIBILITY_CHANGED');
    if (stableDigest(rawBefore) !== stableDigest(rawAfter) || rawAfter.valueRanges?.length !== capture.tabs.length) throw new Error('SOURCE_CAPTURE_CHANGED');
    const observedCapture = structuredClone(capture);
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
    return { capture, observedCapture, visibility: after };
  };
  const f05ObservedCapture = async () => {
    if (env.SOURCE_CYCLE_F05_SOURCE_ROWS !== '1') throw new Error('F05_SOURCE_ROWS_DISABLED');
    return structuredClone((await (f05Capture ??= readF05())).observedCapture);
  };
  for (const kind of enabled) {
    if (kind === 'F05') {
      for (const code of new Set(sharedSheetChannels.map(c => c.code))) {
        const scopes = [...new Set(sharedSheetChannels.filter(c => c.code === code).map(c => c.tab))];
        plugins.push(sourceCyclePlugin({ sourceId: code, kind: 'F05', scopes, maxDowngradeRatio: ratio }, async () => {
          const read = env.SOURCE_CYCLE_F05_SOURCE_ROWS === '1' ? await (f05Capture ??= readF05()) : await readF05();
          return sheetCountGuard(code, f05NativeCapture(code, structuredClone(read.capture), read.visibility,
            env.SOURCE_CYCLE_F05_SOURCE_YEARS === '1' && (sourceIdentitySources.includes(code) || specFillSources.includes(code))
              ? await identity() ?? undefined : undefined));
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
        return sheetCountGuard('RP004', aicaNativeCapture(AICA_SCOPES.map((title, i) => ({ title, values: before.valueRanges[i].values ?? [] })), observedAt, visibilityAfter));
      }, ratio));
    } else if (kind === 'IANCAR') {
      // 상세·가용 캐시(1번 커맨드 오더 2026-10-16, 기본 꺼짐): SOURCE_CYCLE_IANCAR_DETAIL_CACHE=1 일 때만 직전 회차 캐시를 재사용해 차량별 호출 3→1(요금만).
      // 상태 파일 손상·형식 불일치면 캐시 없음(전수 읽기). 캐시 갱신은 무인 정시 회차만 저장한다(수동 plan 이 파일을 흔들지 않게).
      const iancarCacheOn = (env.SOURCE_CYCLE_IANCAR_DETAIL_CACHE ?? '').trim() === '1';
      const iancarCacheFile = join(directory, 'iancar-detail-cache.json');
      // 값 지문 안정화(1번 커맨드 오더 2026-10-17, 기본 꺼짐): SOURCE_CYCLE_IANCAR_STABLE_FACTS=1 일 때 관측 시각·사진 자격 URL 을 뺀 원문으로 저장·비교해
      // 값이 같은 문서를 매 회차 다시 쓰지 않는다. 켜는 첫 회차는 전량 1회 UPDATE(저장 digest 이관), 그다음부터 변화 없는 문서는 쓰기 0.
      const iancarStableFacts = (env.SOURCE_CYCLE_IANCAR_STABLE_FACTS ?? '').trim() === '1';
      plugins.push(plateUidPlugin(iancarCyclePlugin(ratio, async () => {
        let detailCache: IancarDetailCache | null = null;
        if (iancarCacheOn) try { detailCache = parseIancarDetailCache(JSON.parse(await readFile(iancarCacheFile, 'utf8'))); } catch { detailCache = null; }
        // 캐시 적재는 회차 성공·실패와 무관(닭과 달걀 해소, 1번 커맨드 2026-10-16): 검증을 통과한 차량별 봉투(sink)를 기존 파일과 병합해 저장한다.
        // finally 에는 로컬 파일 저장만 두고 원래 예외·실패 상태는 그대로 전파한다 — 발행·Firestore 쓰기 경로는 변하지 않는다(Codex P1 ③).
        const sink: Record<string, IancarDetailCacheEntry> = {};
        try {
          return await collectIancarOneFullFacts(iancarOneApiConfigFromEnv(env), fetcher, undefined, undefined, iancarCacheOn ? { detailCache, cacheSink: sink } : {});
        } finally {
          if (iancarCacheOn && env.SOURCE_CYCLE_UNATTENDED === '1' && Object.keys(sink).length) {
            try { await writeJsonAtomic(iancarCacheFile, mergeIancarDetailCache(detailCache, sink, Date.now())); } catch { /* 저장 실패는 원래 결과를 가리지 않는다 */ }
          }
        }
      }, undefined, async () => (await collectIancarOneVehicleList(iancarOneApiConfigFromEnv(env), fetcher)).syncedAt, { stableFacts: iancarStableFacts })));
    } else if (kind === 'MAUMCAR') {
      // 파일 경로는 명시해야 한다(없으면 회차 설정 오류). 쓰기는 별도 승인 범위 — 이 플러그인은 읽기·계획 입력만 만든다.
      const file = required('SOURCE_CYCLE_MAUMCAR_FILE');
      plugins.push(plateUidPlugin(maumcarFilePlugin(ratio, async () => {
        const bytes = await readFile(file);
        const observedAt = new Date().toISOString();
        const fileSha256 = createHash('sha256').update(bytes).digest('hex');
        return { conversion: convertMaumcarWorkbook(readXlsx(bytes), { observedAt, fileSha256 }), observedAt };
      })));
    } else if (kind === 'IRON' && env.SOURCE_CYCLE_IRON_HOMEPAGE === '1') {
      // 아이언 홈페이지 상세 기준(대표 2026-10-14): 목록(신차·중고, 더보기) → 상세 전수, 판매완료 라벨은 판매 불가(1차 무조건 편입은 비노출), 번호 키, 사진 갤러리.
      // ERP4 의 RP006 쓰기(approveAll·변동)는 «폐기»가 확정되어야 켠다(이중 쓰기 금지). 읽기 불완전·목록 급감이면 쓰기·부재 하향이 막힌다.
      // 기준 파일은 «판매 가능 고유 번호 수» 기준(2026-10-14 like-with-like). 옛 파일(전체 레코드 수)과 섞지 않도록 이름을 바꿨다.
      const countFile = join(directory, 'iron-homepage-sellable-count.json');
      plugins.push(plateUidPlugin(sourceCyclePlugin({ sourceId: 'RP006', kind: 'IRON', scopes: ['homepage'], maxDowngradeRatio: ratio }, async () => {
        const fetchHtml = async (url: string) => {
          const response = await fetch(url, { headers: { 'User-Agent': 'FreePassData/1 iron homepage sync' }, redirect: 'follow', signal: AbortSignal.timeout(IRON_HOMEPAGE_POLICY.timeoutMs) });
          if (!response.ok) throw new Error(`IRON_HTTP_${response.status}`);
          if (new URL(response.url || url).hostname !== IRON_HOMEPAGE_POLICY.host) throw new Error('IRON_HOST_REJECTED');
          const html = await response.text();
          // 사이트맵(완전성 대조)만 XML 을 받는다. 그 밖은 HTML 이어야 한다.
          const sitemap = new URL(url).pathname === '/sitemap.xml';
          if (!(sitemap ? /<(?:\?xml|urlset)/i : /<(?:!doctype|html)/i).test(html.slice(0, 300))) throw new Error('IRON_NOT_HTML');
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
        // 같은 것끼리 비교한다: 노출 문서(잠금·계약중 제외)와 «판매 가능·계약중 아닌» 레코드. 판매완료까지 센 전체 레코드 수와 비교하면
        // 판매 가능 차가 크게 줄어도 하한을 통과했다(2026-10-14).
        const verdict = judgeSonogongApiRead({ ...read, records: ironFloorRecords(read.records) }, { exposedUnlockedDocs: exposedDocs, previousCount: previous, stateError });
        let complete = verdict.complete, reason = verdict.incompleteReason;
        if (verdict.saveCount !== null && verdict.saveCount > 0 && !(await writeJsonAtomic(countFile, { count: verdict.saveCount, at: read.observedAt })) && verdict.complete) {
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
              return { plate: typeof f.car_number === 'string' ? f.car_number : null, listable: f.listable === true, price: f.price };
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
          // 부하 방어: 마지막 완전 읽기 후 45분 안에는 다시 읽지 않는다(손오공 데이터는 1시간 단위 갱신, 상세 최대 600건·간격 1.5초).
          // 간격 기록은 «무인 정시 회차»만 남기고 지킨다: 수동 계획(DRY_RUN) 읽기가 간격을 소비해 같은 시간대 무인 APPLY 를 막지 않게 한다(B3Q 10-14).
          const unattended = env.SOURCE_CYCLE_UNATTENDED === '1';
          if (unattended) try {
            const pass = JSON.parse(await readFile(passFile, 'utf8')) as { at?: unknown };
            if (typeof pass.at === 'string' && Date.now() - Date.parse(pass.at) < SONOGONG_API_POLICY.minPassIntervalMinutes * 60_000) return soft('SONOGONG_API_PASS_INTERVAL');
          } catch { /* 최초·읽기 불가는 허용 — 아래 읽기 안전장치가 막는다 */ }
          const client = createSonogongApiClient({ base: apiBase, key: apiKey });
          // 상세 캐시(커맨드 센터 승인 2026-10-16): 직전 회차에서 목록 행 digest 가 같은 차의 상세를 재사용(6시간 상한·24시간마다 전수 갱신).
          // 상태 파일이 없거나 손상·형식 불일치면 캐시 없음(전수 읽기)으로 폴백한다. SOURCE_CYCLE_SONOGONG_DETAIL_CACHE=off 면 쓰지 않는다.
          const cacheFile = join(directory, 'sonogong-detail-cache.json');
          const cacheOn = (env.SOURCE_CYCLE_SONOGONG_DETAIL_CACHE ?? '').trim().toLowerCase() !== 'off';
          let detailCache: DetailCache | null = null;
          if (cacheOn) try { detailCache = parseDetailCache(JSON.parse(await readFile(cacheFile, 'utf8'))); } catch { detailCache = null; }
          // 갱신 직후 시작: 상류 생성 시각이 바뀐 것을 확인한 뒤 읽는다(읽는 도중 판이 바뀌는 일을 줄임). 최대 대기 시간 상한(기본 5분, 0 = 기다리지 않음) 뒤에는 그대로 읽는다.
          // 무인 정시 회차만 기다린다 — 수동 plan 은 기다리지 않는다.
          if (unattended && cacheOn && detailCache?.lastGeneratedAt) {
            const maxWaitMin = Number(env.SOURCE_CYCLE_SONOGONG_WAIT_MAX_MIN ?? '5');
            const maxWaitMs = Number.isFinite(maxWaitMin) && maxWaitMin >= 0 && maxWaitMin <= 20 ? maxWaitMin * 60_000 : 5 * 60_000;
            await waitForUpstreamRefresh(async () => {
              const first = await client.get('/vehicles', { tab: 'rent', page: 1, pageSize: 1 });
              return typeof first.attrs.generatedAt === 'string' ? first.attrs.generatedAt : null;
            }, { lastGeneratedAt: detailCache.lastGeneratedAt, maxWaitMs, pollMs: 60_000, sleep: ms => new Promise(r => setTimeout(r, ms)) });
          }
          const read = await readSonogongApi(client, cacheOn ? { detailCache } : {});
          if (cacheOn && unattended && read.detailCacheOut) await writeJsonAtomic(cacheFile, read.detailCacheOut);
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
        // 규격 검증(기본 꺼짐): SOURCE_CYCLE_SPEC_VALIDATION_SOURCES 에 RP012 가 있을 때만.
        if ((env.SOURCE_CYCLE_SPEC_VALIDATION_SOURCES ?? '').split(',').map(x => x.trim()).includes('RP012')) apiPlugin.specValidation = true;
        { const optCap = Number(env.SOURCE_CYCLE_API_OPTIONS_CAP ?? ''); if (Number.isSafeInteger(optCap) && optCap > 100 && optCap <= 400) apiPlugin.optionsRewriteCap = optCap; }
        plugins.push(apiPlugin);
      } else
      if (kind === 'AUTOPLUS' && env.SOURCE_CYCLE_AUTOPLUS_SHEET === '1') {
        const sheetId = (env.SOURCE_CYCLE_AUTOPLUS_SHEET_ID ?? '').trim();
        if (!/^[A-Za-z0-9_-]{20,80}$/.test(sheetId)) throw new Error('CYCLE_SOURCE_CONFIG_INVALID');
        plugins.push(plateUidPlugin(sourceCyclePlugin({ sourceId: 'RP023', kind: 'AUTOPLUS', scopes: ['sheet'], maxDowngradeRatio: ratio }, async () => {
          const observedAt = new Date().toISOString();
          const gws = async (args: string[], params: Record<string, unknown>): Promise<Record<string, unknown>> => {
            const batch = args.includes('batchGet');
            const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(String(params.spreadsheetId))}${batch ? '/values:batchGet' : ''}`);
            for (const [k, v] of Object.entries(params)) if (k !== 'spreadsheetId') for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(one));
            return await sheetsRead(url) as Record<string, unknown>;
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
          let countText: string | null = null, countReadError = false;
          try { countText = await readFile(countFile, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') countReadError = true; }
          const countState = parseSheetCountState(countText, countReadError);
          const previous = countState.previous, stateError: string | null = countState.stateError;
          const floor = autoplusSheetRowFloor(exposedDocs, previous);
          let complete = read.complete, reason = read.incompleteReason;
          if (complete && read.rowCount < floor) { complete = false; reason = 'SHEET_SHRUNK'; }
          if (complete && stateError) { complete = false; reason = stateError; }
          if (complete && read.rowCount > 0) {
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
  return { plugins, commands, control, directory, identityStatus: () => identityStatus, f05ObservedCapture };
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
  const sheets = kinds.includes('F05') || kinds.includes('AICA') || (kinds.includes('AUTOPLUS') && env.SOURCE_CYCLE_AUTOPLUS_SHEET === '1');
  // SHEETS_TRANSPORT=adc(온라인 실행기)는 gws 가 필요 없다. 그 외에는 기존대로 gws 필수.
  if (sheets && env.SHEETS_TRANSPORT !== 'adc' && !probes.gwsBin(env)) missing.push('PREFLIGHT_GWS_MISSING');
  // 시트 원천은 전송을 명시해야 한다(미설정 기본값은 ADC — 운영 PC 에서 조용히 다른 전송으로 읽지 않게, F05 뿐 아니라 아이카·오토플러스 시트도).
  if (sheets && env.SHEETS_TRANSPORT !== 'gws' && env.SHEETS_TRANSPORT !== 'adc') missing.push('PREFLIGHT_SHEETS_TRANSPORT_UNSET');
  try { if (!(await probes.gcloudToken())) missing.push('PREFLIGHT_GCLOUD_TOKEN_MISSING'); }
  catch (e) {
    // 사유 코드(GCLOUD_TOKEN_FAILED_TIMEOUT 등)가 있으면 함께 남긴다 — 10-17 장애 때 «MISSING» 만 남아 원인을 gcloud 로그에서 찾아야 했다.
    missing.push('PREFLIGHT_GCLOUD_TOKEN_MISSING');
    if (e instanceof Error && /^GCLOUD_TOKEN_FAILED_[A-Z_]+$/.test(e.message)) missing.push(e.message);
  }
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
/** 무인 회차 종료 코드(순수). HOLD·STOPPED·APPLY_UNCERTAIN 이 있거나 신선도가 HEALTHY 가 아니면 1.
 * 예외: 보고가 «모두 LOCKED»(다른 회차가 그 원천을 쓰는 중이라 이 회차는 아무것도 하지 않음)이면 신선도 판정을 종료 코드에 쓰지 않는다 —
 * 쓰는 도중에는 상태 파일이 아직 확정 전이라 신선도가 낡은 값(STALE)으로 읽힌다(2026-10-16 RP031 :05 단독 회차 오경보: lastComplete 21:01Z 로 읽혀 124분 STALE).
 * 잠금을 잡은 회차가 자기 결과로 신선도를 판정·기록한다. 즉시 실행 요청(REQUEST_RUN)에서 LOCKED·UNCHANGED_SYNC 는 «미실행» 이라 종료 코드 3. */
export function unattendedExitCode(input: { statuses: readonly string[]; freshnessStatus: string; requestRun: boolean }): { exit: 0 | 1 | 3; freshnessSkipped: boolean } {
  const onlyLocked = input.statuses.length > 0 && input.statuses.every(status => status === 'LOCKED');
  const freshnessBad = input.freshnessStatus !== 'HEALTHY' && !onlyLocked;
  if (input.statuses.some(status => ['HOLD', 'STOPPED', 'APPLY_UNCERTAIN'].includes(status)) || freshnessBad) return { exit: 1, freshnessSkipped: false };
  if (input.requestRun && input.statuses.some(status => ['LOCKED', 'UNCHANGED_SYNC'].includes(status))) return { exit: 3, freshnessSkipped: onlyLocked && input.freshnessStatus !== 'HEALTHY' };
  return { exit: 0, freshnessSkipped: onlyLocked && input.freshnessStatus !== 'HEALTHY' };
}

type F05SourceObservationReport = Awaited<ReturnType<typeof ingestSharedSheetObservedRows>>;
type F05SourceObservationFailure = { schema: 'freepass-data.shared-sheet-source-observation-receipt/v1';
  mode: 'SOURCE_OBSERVATIONS_ONLY'; status: 'HOLD' | 'APPLY_UNCERTAIN'; reasonCode: string;
  intent?: Awaited<ReturnType<CycleControl['load']>>['sourceObservationIntent'] };
/** Called only by the existing full F05 unattended producer. Activation follows
 * the single-owner cutover; manual plans and all other collectors stay unchanged.
 */
export async function refreshF05SourceObservations(env: NodeJS.ProcessEnv, selectedSource: string | undefined, ports: {
  acquire: (source: string) => Promise<null | (() => Promise<void>)>;
  observedCapture?: () => Promise<SharedSheetCapture>;
  control?: Pick<CycleControl, 'load' | 'save'>;
  capture?: (id: string) => Promise<SharedSheetCapture>;
  master?: () => Promise<unknown>;
  persist?: (input: { capture: SharedSheetCapture; liveCapture: SharedSheetCapture;
    claimEffect: NonNullable<Parameters<typeof ingestSharedSheetObservedRows>[1]['claimEffect']> }) => Promise<F05SourceObservationReport>;
}) {
  if (env.SOURCE_CYCLE_F05_SOURCE_ROWS !== '1') return null;
  const kinds = (env.SOURCE_CYCLE_SOURCES ?? '').split(',').map(k => k.trim()).filter(Boolean);
  if (env.SOURCE_CYCLE_UNATTENDED !== '1' || selectedSource || kinds.length !== 1 || kinds[0] !== 'F05') throw new Error('F05_SOURCE_ROWS_REQUIRE_EXCLUSIVE_FULL_PRODUCER');
  const id = env.SOURCE_CYCLE_F05_SHEET_ID?.trim();
  if (!id) throw new Error('F05_SOURCE_ROWS_SHEET_REQUIRED');
  if (!ports.observedCapture) throw new Error('F05_SOURCE_ROWS_PRODUCER_CAPTURE_REQUIRED');
  if (!ports.control) throw new Error('F05_SOURCE_ROWS_CONTROL_REQUIRED');
  const release = await ports.acquire('F05_SOURCE_ROWS');
  if (!release) throw new Error('F05_SOURCE_ROWS_LOCKED');
  try {
    const state = await ports.control.load('F05_SOURCE_ROWS');
    if (state.error === 'APPLY_UNCERTAIN') throw new Error('F05_SOURCE_ROWS_UNCERTAIN_REQUIRES_READBACK');
    const capture = ports.capture ?? (async (sheetId: string) => { assertCurrentSharedSheetSource(sheetId); return captureSharedSheetReadOnly(sheetId); });
    const first = await ports.observedCapture();
    const master = await (ports.master ?? captureVehicleMasterSnapshotReadOnly)().catch(() => undefined);
    const live = await capture(id);
    if (master) { first.vehicleMasterSnapshot = master; live.vehicleMasterSnapshot = master; }
    first.digest = sharedSheetCaptureDigest(first); live.digest = sharedSheetCaptureDigest(live);
    const persist = ports.persist ?? (input => withSharedSheetCatalogAccess(true,
      stableDigest({ operation: 'F05_SOURCE_OBSERVATIONS_ONLY', capture: input.capture.digest, live: input.liveCapture.digest }),
      async (_catalog, source) => ingestSharedSheetObservedRows(source, { target: 'freepasserp5', ...input })));
    let claimed = false;
    const claimEffect: NonNullable<Parameters<typeof ingestSharedSheetObservedRows>[1]['claimEffect']> = async intent => {
      state.stopped = true; state.error = 'APPLY_UNCERTAIN'; state.lastAttemptAt = new Date().toISOString();
      state.sourceObservationIntent = intent;
      await ports.control!.save('F05_SOURCE_ROWS', state); claimed = true;
    };
    const report = await persist({ capture: first, liveCapture: live, claimEffect });
    if (!claimed) throw new Error('F05_SOURCE_ROWS_EFFECT_JOURNAL_REQUIRED');
    state.stopped = false; state.error = null; state.lastCompleteAt = report.verifiedAt;
    state.readCount = report.rawRows; state.heldCount = report.heldCandidateRows;
    await ports.control.save('F05_SOURCE_ROWS', state);
    return report;
  } finally { await release(); }
}

export async function runUnattended(args: string[], env: NodeJS.ProcessEnv, acceptDrift: string[], probes: UnattendedProbes = defaultProbes,
  runtimeFactory: typeof createSourceCycleRuntime = createSourceCycleRuntime) {
  const directory = env.SOURCE_CYCLE_PRIVATE_DIR || join(homedir(), '.codex', 'private', 'source-cycle');
  const source = args.indexOf('--source') >= 0 ? args[args.indexOf('--source') + 1] : undefined;
  const record: { started: string; finished: string; exit: number; preflight?: string[]; error?: string; configNotices?: string[];
    reports?: Array<{ source: string; stage: string; status: string; summary: string; digest: string | null;
      /** 공급사별 노출(listable=true) 수 전후: before=이번 회차 시작 전, after=이번 회차 적용 뒤(미적용이면 before 와 같다).
       *  prior=직전 회차 기록의 after. unexplained=before-prior(회차 밖에서 바뀐 수, 0 이면 설명됨). */
      exposure?: { before: number; after: number | null; applied: boolean; prior: number | null; unexplained: number | null;
        /** 원천에서 판매 가능으로 읽은 대수와 적용 뒤 노출 대수의 차(대표 2026-10-14: 대수를 맞추고 그 대수의 데이터를 신선하게). 보류 행이 있으면 일부는 정당하다. */
        sourceSellable: number | null; gap: number | null } }>;
    freshness?: ReturnType<typeof assessFreshness>;
    /** 신선도 판정을 종료 코드에 쓰지 않은 사유 코드(SKIPPED_ALL_LOCKED = 모든 원천이 다른 회차의 잠금으로 건너뜀). */
    freshnessNote?: string;
    /** 정체성 정제 상태: ENABLED:<마스터 digest 앞 12> · SKIPPED:<사유 코드>(정제 안 함 = 지금 동작) · DISABLED · NOT_LOADED(목록을 읽지 않음). */
    identityRefine?: string; sourceObservations?: F05SourceObservationReport | F05SourceObservationFailure } = { started: new Date().toISOString(), finished: '', exit: 0 };
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
      const runtime = runtimeFactory(env, fetch, acceptDrift);
      const selected = runtime.plugins.filter(p => !source || p.sourceId === source);
      if (!selected.length) throw new Error('ONE_SOURCE_REQUIRED');
      try {
        const sourceObservations = await refreshF05SourceObservations(env, source, {
          acquire: id => runtime.control.acquire(id), observedCapture: runtime.f05ObservedCapture, control: runtime.control,
        });
        if (sourceObservations) record.sourceObservations = sourceObservations;
      } catch (error) {
        const reasonCode = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'F05_SOURCE_ROWS_FAILED';
        const state = await runtime.control.load('F05_SOURCE_ROWS').catch(() => null);
        record.sourceObservations = { schema: 'freepass-data.shared-sheet-source-observation-receipt/v1',
          mode: 'SOURCE_OBSERVATIONS_ONLY', status: state?.error === 'APPLY_UNCERTAIN' ? 'APPLY_UNCERTAIN' : 'HOLD',
          reasonCode, ...(state?.sourceObservationIntent ? { intent: state.sourceObservationIntent } : {}) };
        record.exit = 1; await alert(`F05_SOURCE_ROWS:${reasonCode}`);
        // Preserve the existing product collector; failed source storage is
        // independently non-green and its uncertain effect remains fenced.
      }
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
          { onlyWhenSynced: args.includes('--only-when-synced') && plugin.family === 'IANCAR',
            // 상류 갱신 감시(독립 판독기): --watch-sync 를 줄 때만(기본 꺼짐). 창(분)은 SOURCE_CYCLE_IANCAR_WATCH_MIN(기본 20, 1~30) — 예: :50 에 시작해 :10 까지.
            ...(args.includes('--watch-sync') && args.includes('--only-when-synced') && plugin.family === 'IANCAR'
              ? { syncWatch: { windowMs: Math.min(30, Math.max(1, Number(env.SOURCE_CYCLE_IANCAR_WATCH_MIN ?? '20') || 20)) * 60_000 } } : {}) });
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
      record.identityRefine = runtime.identityStatus();
      const lines = async (name: string) => (await readFile(join(directory, name), 'utf8').catch(() => '')).split('\n');
      record.freshness = assessFreshness(await lines('heartbeats.jsonl'), await lines('alerts.jsonl'),
        { maxAgeMinutes: Number(env.SOURCE_CYCLE_MAX_AGE_MINUTES ?? '120'), only: selected.map(p => p.sourceId),
          knownFalsePositive: (env.SOURCE_CYCLE_STALE_FALSE_POSITIVE ?? '').split(',').map(v => v.trim()).filter(Boolean),
          exempt: parseFreshnessExempt(env.SOURCE_CYCLE_FRESHNESS_EXEMPT),
          // 원천별 임계값: 설정(SOURCE_CYCLE_FRESHNESS_THRESHOLDS)이 우선, 없으면 손오공 API 모드에서만 기본 90분 정체·180분 에스컬레이션(커맨드 센터 10-14).
          sourceThresholds: env.SOURCE_CYCLE_FRESHNESS_THRESHOLDS !== undefined ? parseFreshnessThresholds(env.SOURCE_CYCLE_FRESHNESS_THRESHOLDS)
            : sonogongApiEnabled(env) ? parseFreshnessThresholds('RP012=90:180:SONOGONG_API_STAGNANT') : [] });
      const decided = unattendedExitCode({ statuses: record.reports.map(r => r.status), freshnessStatus: record.freshness.status, requestRun: env.SOURCE_CYCLE_REQUEST_RUN === '1' });
      record.exit = record.sourceObservations && record.sourceObservations.status !== 'SOURCE_HEAD_VERIFIED' ? 1 : decided.exit;
      if (decided.freshnessSkipped) record.freshnessNote = 'SKIPPED_ALL_LOCKED';
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
      ...(planFile && !approvedPlan ? { manualPlan: true } : {}),
      ...(approvedPlan ? { apply: true, approvedPlan, digest: stableDigest(approvedPlan), approval: env.SOURCE_CYCLE_APPROVED_DIGEST ?? '' } : {}) });
    if (!approvedPlan && planFile && 'plan' in result && result.plan) {
      if (selected.length !== 1) throw new Error('ONE_SOURCE_REQUIRED');
      await writeFile(resolve(planFile), JSON.stringify(result.plan), { mode: 0o600, flag: 'wx' });
    }
    reports.push({ source: plugin.sourceId, status: result.status, summary: result.summary + (acceptDrift.includes(plugin.sourceId) ? ` · 보정허용(--accept-drift ${plugin.sourceId})` : ''),
      digest: 'planDigest' in result ? result.planDigest : null, identityRefine: runtime.identityStatus() });
  }
  return reports;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runtimeCli(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result));
    if (Array.isArray(result) && result.some(r => ['HOLD', 'STOPPED', 'APPLY_UNCERTAIN'].includes(r.status))) process.exitCode = 1;
    if (result && !Array.isArray(result) && 'exit' in result && typeof result.exit === 'number') process.exitCode = result.exit;
  }, () => { console.error('SOURCE_CYCLE_RUNTIME_HOLD'); process.exitCode = 1; });
}

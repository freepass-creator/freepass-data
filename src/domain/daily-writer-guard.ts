/**
 * «정해진 작업이 아닌 쓰기» 감시 — 매일 박제 계정(github-data-inventory-writer)의 Firestore 쓰기 감사 로그를 판정한다
 * (대표 승인 10-04 ①안의 감지 점검). IAM 은 데이터베이스 단위까지만 좁혀지므로 모음 단위는 사후 감지로 막는다.
 *  - 로그에 쓴 문서 경로가 있으면: 허용 모음 밖(특히 ERP4 화면의 `products`)·다른 데이터베이스 쓰기 → 경보
 *  - 경로가 있든 없든: shared-sheet-daily(main) 실행 구간 밖의 쓰기 → 경보
 *  - 적용 실행이 성공했는데 그 구간의 쓰기 로그가 하나도 없으면(감사 로그 꺼짐·누락) → 보류
 * 공개 로그에 나가므로 모음 이름은 정해진 목록만 그대로 내보내고, 나머지는 «(other)» 로 센다.
 */
export const DAILY_WRITER_ALLOWED_COLLECTIONS = Object.freeze([
  'catalog_vehicle_models', 'catalog_vehicle_assets', 'catalog_products', 'catalog_offers',
  'canonical_source_bindings', 'catalog_entity_revisions',
  'sources', 'source_runs', 'source_heads', 'raw_records', 'normalized_candidates', 'field_lineage',
  'canonicalization_receipts', 'reviewed_source_change_receipts',
  'audit_events', 'outbox_events', 'data_access_events',
] as const);
/** Collections owned by other writers — named in the report when hit (never allowed). */
const KNOWN_FORBIDDEN = ['products', 'policy', 'vehicle_master', 'vehicle_trim_master', 'command_receipts', 'catalog_policies',
  'writer_ownership', 'writer_ownership_transfer_receipts', 'contract', 'partner'] as const;
export const DAILY_WRITER_WRITE_METHODS = Object.freeze(['Commit', 'BatchWrite', 'Write', 'CreateDocument', 'UpdateDocument', 'DeleteDocument']);
const DATABASE_PREFIX = 'projects/freepasserp5/databases/(default)/documents';

export type DailyWriterLogEntry = {
  timestamp?: string;
  protoPayload?: { methodName?: string; serviceName?: string; resourceName?: string; request?: unknown;
    authenticationInfo?: { principalEmail?: string } };
};
export type DailyWriterRun = { id?: number; head_branch?: string; event?: string; display_title?: string; status?: string;
  conclusion?: string | null; created_at?: string; run_started_at?: string; updated_at?: string };

const isWrite = (entry: DailyWriterLogEntry) => {
  const method = entry.protoPayload?.methodName ?? '';
  return DAILY_WRITER_WRITE_METHODS.some((m) => method.endsWith(`.${m}`));
};

/** Every document path a write request names: resourceName, writes[].update.name / delete / transform.document,
 * CreateDocument parent + collectionId — any string holding «/documents». */
function writtenPaths(entry: DailyWriterLogEntry): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { if (typeof v === 'string' && v.includes('/documents')) out.push(v); };
  add(entry.protoPayload?.resourceName);
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') { add(value); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.parent === 'string' && typeof record.collectionId === 'string') out.push(`${record.parent}/${record.collectionId}/(new)`);
    for (const v of Object.values(record)) visit(v);
  };
  visit(entry.protoPayload?.request);
  return [...new Set(out)];
}

/** Every «projects/…/databases/…» named anywhere in the entry — checked apart from document paths, so a write against
 * another database is caught even when the log carries no document path. */
function databasesNamed(entry: DailyWriterLogEntry): string[] {
  const out = new Set<string>();
  const scan = (value: unknown) => {
    if (typeof value === 'string') { for (const m of value.matchAll(/projects\/[^/\s]+\/databases\/[^/\s]+/g)) out.add(m[0]); return; }
    if (Array.isArray(value)) { value.forEach(scan); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(scan);
  };
  scan(entry.protoPayload?.resourceName);
  scan(entry.protoPayload?.request);
  return [...out];
}

/** '' = database-level path (no collection), '(other-database)' = not this project's default database. */
function collectionOf(path: string): string {
  if (!path.startsWith(DATABASE_PREFIX)) return '(other-database)';
  if (!path.startsWith(`${DATABASE_PREFIX}/`)) return '';
  return path.slice(DATABASE_PREFIX.length + 1).split('/')[0] ?? '';
}

const publicName = (collection: string) =>
  ([...DAILY_WRITER_ALLOWED_COLLECTIONS, ...KNOWN_FORBIDDEN, '(other-database)'] as string[]).includes(collection) ? collection : '(other)';

export function evaluateDailyWriterGuard(input: {
  entries: DailyWriterLogEntry[]; runs: DailyWriterRun[]; account: string; now: Date; lookbackHours: number; graceMinutes?: number;
}) {
  const grace = (input.graceMinutes ?? 10) * 60_000;
  const since = input.now.getTime() - input.lookbackHours * 3_600_000;
  // Only runs of the daily workflow on main that actually ran (in_progress / completed) open a window.
  const windows = input.runs.filter((run) => run.head_branch === 'main' && (run.status === 'in_progress' || run.status === 'completed'))
    .flatMap((run) => {
      const start = Date.parse(run.run_started_at ?? '');
      const end = run.status === 'completed' ? Date.parse(run.updated_at ?? '') : input.now.getTime();
      return Number.isFinite(start) && Number.isFinite(end) ? [{ run, from: start - grace, to: end + grace }] : [];
    });
  const writes = input.entries.filter((e) => e.protoPayload?.authenticationInfo?.principalEmail === input.account && isWrite(e));
  const outsideCollections: Record<string, number> = {};
  let withPaths = 0;
  let outsideRuns = 0;
  for (const entry of writes) {
    const paths = writtenPaths(entry);
    if (paths.length) withPaths += 1;
    if (databasesNamed(entry).some((d) => `${d}/documents` !== DATABASE_PREFIX))
      outsideCollections['(other-database)'] = (outsideCollections['(other-database)'] ?? 0) + 1;
    for (const path of paths) {
      const collection = collectionOf(path);
      if (collection === '') continue;
      if (!(DAILY_WRITER_ALLOWED_COLLECTIONS as readonly string[]).includes(collection)) {
        const name = publicName(collection);
        outsideCollections[name] = (outsideCollections[name] ?? 0) + 1;
      }
    }
    const at = Date.parse(entry.timestamp ?? '');
    if (!Number.isFinite(at) || !windows.some((w) => at >= w.from && at <= w.to)) outsideRuns += 1;
  }
  // A successful apply run (schedule, or a dispatch whose title names «apply») inside the lookback must have left write logs.
  const silentApplies = windows.filter(({ run, from, to }) => run.status === 'completed' && run.conclusion === 'success' &&
    (run.event === 'schedule' || /\bapply\b/.test(run.display_title ?? '')) && from >= since &&
    !writes.some((e) => { const at = Date.parse(e.timestamp ?? ''); return at >= from && at <= to; })).length;
  const reasons = [
    ...(Object.keys(outsideCollections).length ? ['DAILY_WRITER_OUTSIDE_ALLOWED_COLLECTIONS'] : []),
    ...(outsideRuns ? ['DAILY_WRITER_OUTSIDE_SCHEDULED_RUN'] : []),
    ...(silentApplies ? ['DAILY_WRITER_AUDIT_LOG_MISSING'] : []),
  ];
  const status = reasons.some((r) => r !== 'DAILY_WRITER_AUDIT_LOG_MISSING') ? 'ALERT' as const
    : reasons.length ? 'HOLD' as const : 'OK' as const;
  return { status, reasons, writes: writes.length, writesWithDocumentPaths: withPaths, outsideCollections, outsideRuns,
    dailyRunsInWindow: windows.length, silentApplies };
}

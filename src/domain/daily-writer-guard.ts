/**
 * «정해진 작업이 아닌 쓰기» 감시 — 매일 박제 계정(github-data-inventory-writer)의 Firestore 쓰기 감사 로그를 판정한다.
 * IAM 은 모음 단위로 좁힐 수 없으므로(데이터베이스 단위까지만) 사후 감지로 막는다:
 *  - 로그에 쓴 문서 경로가 있으면: 허용 모음 밖(특히 ERP4 화면의 `products`) 쓰기 → 경보
 *  - 경로가 있든 없든: data-owned-refresh 실행 시간 밖의 쓰기 → 경보
 */
export const DAILY_WRITER_ALLOWED_COLLECTIONS = Object.freeze([
  'catalog_vehicle_models', 'catalog_vehicle_assets', 'catalog_products', 'catalog_offers',
  'canonical_source_bindings', 'catalog_entity_revisions',
  'sources', 'source_runs', 'source_heads', 'raw_records', 'normalized_candidates', 'field_lineage',
  'canonicalization_receipts', 'reviewed_source_change_receipts',
  'audit_events', 'outbox_events', 'data_access_events',
] as const);

export type DailyWriterLogEntry = {
  timestamp?: string;
  protoPayload?: { methodName?: string; resourceName?: string; request?: unknown; authenticationInfo?: { principalEmail?: string } };
};
export type DailyWriterRun = { created_at?: string; run_started_at?: string; updated_at?: string; status?: string };

/** Document names written by one Commit/BatchWrite/Write/Create/Update request, when the log carries them. */
function writtenDocumentNames(entry: DailyWriterLogEntry): string[] {
  const out: string[] = [];
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (['name', 'delete', 'document', 'parent'].includes(key) && value.includes('/documents/')) out.push(value);
      return;
    }
    if (Array.isArray(value)) { value.forEach((v) => visit(v, key)); return; }
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  visit(entry.protoPayload?.request);
  return out;
}

const collectionOf = (documentName: string) => documentName.split('/documents/')[1]?.split('/')[0] ?? '';

export function evaluateDailyWriterGuard(input: {
  entries: DailyWriterLogEntry[]; runs: DailyWriterRun[]; account: string; now: Date; graceMinutes?: number;
}) {
  const grace = (input.graceMinutes ?? 10) * 60_000;
  const windows = input.runs.flatMap((run) => {
    const start = Date.parse(run.run_started_at ?? run.created_at ?? '');
    if (!Number.isFinite(start)) return [];
    const end = run.status === 'completed' ? Date.parse(run.updated_at ?? '') : input.now.getTime();
    return Number.isFinite(end) ? [[start - grace, end + grace] as const] : [];
  });
  const mine = input.entries.filter((e) => e.protoPayload?.authenticationInfo?.principalEmail === input.account);
  const outsideCollections: Record<string, number> = {};
  let withPaths = 0;
  let outsideRuns = 0;
  for (const entry of mine) {
    const names = writtenDocumentNames(entry);
    if (names.length) withPaths += 1;
    for (const name of names) {
      const collection = collectionOf(name) || '(unknown)';
      if (!(DAILY_WRITER_ALLOWED_COLLECTIONS as readonly string[]).includes(collection))
        outsideCollections[collection] = (outsideCollections[collection] ?? 0) + 1;
    }
    const at = Date.parse(entry.timestamp ?? '');
    if (!Number.isFinite(at) || !windows.some(([a, b]) => at >= a && at <= b)) outsideRuns += 1;
  }
  const reasons = [
    ...(Object.keys(outsideCollections).length ? ['DAILY_WRITER_OUTSIDE_ALLOWED_COLLECTIONS'] : []),
    ...(outsideRuns ? ['DAILY_WRITER_OUTSIDE_SCHEDULED_RUN'] : []),
  ];
  return { status: reasons.length ? 'ALERT' as const : 'OK' as const, reasons,
    writes: mine.length, writesWithDocumentPaths: withPaths, outsideCollections, outsideRuns };
}

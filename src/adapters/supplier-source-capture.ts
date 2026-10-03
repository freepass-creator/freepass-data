import { createHash } from 'node:crypto';
import { collectSupplierSource, validateSourceIntakeBatch, type SourceIntakeBatch, type SupplierSourceAdapter } from '../domain/source-intake.js';
import type { SupplierGridCell, AicaGridBinding, AicaGridObservation } from '../domain/source-intake.js';
export type { SupplierGridCell, AicaGridBinding, AicaGridObservation } from '../domain/source-intake.js';
import { plateIdentityKey } from '../domain/vehicle-plate.js';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const plate = plateIdentityKey;
const buckets = ['LOW_SONOKONG_DAILY', 'LOW_SONOKONG', 'LOW_TCAR'] as const;

// Transport/auth is injected by an authorized connector. These adapters neither
// copy legacy credentials nor guess endpoints, terms, amounts or availability.
export type SonogongBucketObservation = {
  bucket: typeof buckets[number]; observedAt: string; revision: string;
  declaredTotal: number | null; complete: boolean;
  records: Array<{ list: Record<string, unknown>; detail: Record<string, unknown> | null }>;
};

export function sonogongSourceAdapter(input: {
  expectedFreshnessSeconds: number;
  readBucket: (bucket: SonogongBucketObservation['bucket']) => Promise<SonogongBucketObservation>;
}): SupplierSourceAdapter {
  return {
    adapterId: 'sonogong-api', sourceId: 'supplier:RP012:sonogong-original-api', scope: 'inventory',
    read: async () => {
      const observations: SonogongBucketObservation[] = [];
      // Sequential, bounded reads; failure does not become an empty bucket.
      for (const bucket of buckets) {
        const observation = await input.readBucket(bucket);
        if (observation.bucket !== bucket || !text(observation.revision)
          || !Number.isFinite(Date.parse(observation.observedAt))) throw new Error('INVALID_SONOGONG_BUCKET');
        observations.push(observation);
      }
      let complete = true;
      const records: SourceIntakeBatch['records'] = [];
      for (const observation of observations) {
        complete &&= observation.complete === true && Number.isSafeInteger(observation.declaredTotal)
          && observation.declaredTotal === observation.records.length;
        for (const record of observation.records) {
          if (!object(record.list) || (typeof record.list.id !== 'string' && typeof record.list.id !== 'number')
            || !String(record.list.id).trim() || !plate(record.list.carNumber)) throw new Error('INVALID_SONOGONG_IDENTITY');
          if (!record.detail) complete = false;
          else if (String(record.detail.id) !== String(record.list.id)
            || plate(record.detail.carNumber) !== plate(record.list.carNumber)) throw new Error('SONOGONG_DETAIL_IDENTITY_MISMATCH');
          const payload = structuredClone({ bucket: observation.bucket,
            sourceRevision: observation.revision, observedAt: observation.observedAt,
            list: record.list, detail: record.detail });
          records.push({ sourceRecordId: `${observation.bucket}:${record.list.id}`,
            sourceFingerprint: fingerprint(payload), payload });
        }
      }
      const checksum = fingerprint(observations);
      const batch: SourceIntakeBatch = {
        laneId: 'PRODUCT_VEHICLE', source: { sourceId: 'supplier:RP012:sonogong-original-api',
          kind: 'API', displayName: '손오공 원본 API', expectedFreshnessSeconds: input.expectedFreshnessSeconds,
          authorityScope: ['Observed bucket/list/detail only; no inferred rates or source absence'] },
        observedAt: observations.map(o => o.observedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0]!,
        observationTimes: observations.map(o => o.observedAt),
        sourceRevision: `sonogong-raw/1:${checksum}`, checksum,
        coverage: { mode: complete ? 'FULL' : 'PARTIAL', completeness: complete ? 'COMPLETE' : 'INCOMPLETE',
          scope: 'LOW_SONOKONG_DAILY + LOW_SONOKONG + LOW_TCAR list and detail',
          note: 'Non-atomic bucket observations; terms/policy completeness and absence authority are not established.' }, records,
      };
      validateSourceIntakeBatch(batch);
      return batch;
    },
  };
}

export type WelrixSheetObservation = {
  // Binding must come from the approved source registry, never partner.sheet_url.
  sourceId: string; sheetId: string; tabId: string; range: string; revision: string;
  observedAt: string; expectedRows: number | null; complete: boolean;
  headers: unknown[]; rows: unknown[][]; identityColumn: number;
};

export function welrixSourceAdapter(input: {
  sourceId: string; sheetId: string; tabId: string; range: string;
  scope: 'inventory' | 'policy'; expectedFreshnessSeconds: number;
  readGrid: () => Promise<WelrixSheetObservation>;
}): SupplierSourceAdapter {
  return {
    adapterId: 'welrix-sheet', sourceId: input.sourceId, scope: input.scope,
    read: async () => {
      const grid = await input.readGrid();
      if (!text(input.sheetId) || !text(input.tabId) || !text(input.range)
        || grid.sourceId !== input.sourceId || grid.sheetId !== input.sheetId
        || grid.tabId !== input.tabId || grid.range !== input.range || !text(grid.revision)
        || !Number.isSafeInteger(grid.identityColumn) || grid.identityColumn < 0
        || grid.identityColumn >= grid.headers.length) throw new Error('WELRIX_SHEET_BINDING_MISMATCH');
      const complete = grid.complete === true && Number.isSafeInteger(grid.expectedRows)
        && grid.expectedRows === grid.rows.length;
      const records = grid.rows.map((cells, rowIndex) => {
        const identity = input.scope === 'inventory' ? plate(cells[grid.identityColumn]) : text(cells[grid.identityColumn]);
        if (!identity) throw new Error('WELRIX_ROW_IDENTITY_MISSING');
        // Policy UID can repeat across different condition rows. RAW row identity
        // is not a Canonical policy ID; original cells/positions remain evidence.
        const sourceRecordId = input.scope === 'inventory' ? identity : `${grid.tabId}:row:${rowIndex}:${identity}`;
        const payload = structuredClone({ sheetId: grid.sheetId, tabId: grid.tabId, range: grid.range,
          rowIndex, headers: grid.headers, cells });
        return { sourceRecordId, sourceFingerprint: fingerprint(payload), payload };
      });
      const checksum = fingerprint(grid);
      const batch: SourceIntakeBatch = {
        laneId: 'PRODUCT_VEHICLE', source: { sourceId: input.sourceId, kind: 'GOOGLE_SHEET',
          displayName: '웰릭스 원본 시트', expectedFreshnessSeconds: input.expectedFreshnessSeconds,
          authorityScope: [`RP013 ${input.scope} observed original cells only`] },
        observedAt: grid.observedAt, sourceRevision: `welrix-raw/1:${grid.revision}:${checksum}`, checksum,
        coverage: { mode: complete ? 'FULL' : 'PARTIAL', completeness: complete ? 'COMPLETE' : 'INCOMPLETE',
          scope: `RP013 ${input.scope} selected tab/range`, note: 'Inventory and policy are separate observations; no unit inference.' }, records,
      };
      validateSourceIntakeBatch(batch);
      return batch;
    },
  };
}

export { collectSupplierSource };

const cellPlate = (cell: SupplierGridCell | undefined): string => {
  const value = cell?.effectiveValue?.stringValue ?? cell?.userEnteredValue?.stringValue ?? cell?.formattedValue;
  return typeof value === 'string' ? value : '';
};
const cellLinks = (cell: SupplierGridCell | undefined): string[] => [cell?.hyperlink,
  cell?.userEnteredFormat?.textFormat?.link?.uri,
  ...(cell?.textFormatRuns ?? []).map(run => run.format?.link?.uri)]
  .filter((value): value is string => typeof value === 'string' && value.length > 0);

export function aicaSourceAdapter(input: {
  sourceId: string; bindings: readonly AicaGridBinding[]; expectedFreshnessSeconds: number | null;
  readGrid: (binding: AicaGridBinding) => Promise<AicaGridObservation>;
}): SupplierSourceAdapter {
  return { adapterId: 'aica-sheet', sourceId: input.sourceId, scope: 'inventory', read: async () => {
    if (!input.bindings.length || new Set(input.bindings.map(b => `${b.sheetId}:${b.tabId}`)).size !== input.bindings.length)
      throw new Error('AICA_GRID_BINDING_MISMATCH');
    const grids: AicaGridObservation[] = [];
    for (const binding of input.bindings) {
      if (!text(binding.sheetId) || !text(binding.range) || !Number.isSafeInteger(binding.tabId) || binding.tabId < 0
        || !Number.isSafeInteger(binding.plateColumn) || binding.plateColumn < 0) throw new Error('AICA_GRID_BINDING_MISMATCH');
      const grid = await input.readGrid(structuredClone(binding));
      if (grid.sheetId !== binding.sheetId || grid.tabId !== binding.tabId || grid.range !== binding.range
        || grid.plateColumn !== binding.plateColumn || !text(grid.revision)
        || !Number.isFinite(Date.parse(grid.observedAt)) || !Number.isSafeInteger(grid.firstDataRow)
        || grid.firstDataRow < 1 || binding.plateColumn >= grid.headers.length)
        throw new Error('AICA_GRID_BINDING_MISMATCH');
      grids.push(structuredClone(grid));
    }
    const observations = grids.flatMap(grid => grid.rows.map((cells, index) => ({ grid, cells,
      row: grid.firstDataRow + index + 1, plateRaw: cellPlate(cells[grid.plateColumn]),
      links: cellLinks(cells[grid.plateColumn]) })));
    const plates = new Map<string, number>();
    const urlOwners = new Map<string, Set<string>>();
    for (const observation of observations) {
      const key = plate(observation.plateRaw);
      if (key) plates.set(key, (plates.get(key) ?? 0) + 1);
      for (const link of observation.links) {
        // A missing identity must not make a shared URL look uniquely attributed.
        const owners = urlOwners.get(link) ?? new Set<string>();
        owners.add(key || `UNKNOWN:${observation.grid.tabId}:${observation.row}`);
        urlOwners.set(link, owners);
      }
    }
    const records = observations.map(({ grid, cells, row, plateRaw, links }) => {
      const identity = plate(plateRaw), captureIssues: string[] = [];
      if (!identity) captureIssues.push('AICA_EMPTY_PLATE');
      if ((plates.get(identity) ?? 0) > 1) captureIssues.push('AICA_DUPLICATE_PLATE');
      if (links.some(link => (urlOwners.get(link)?.size ?? 0) > 1)) captureIssues.push('AICA_SHARED_LINK');
      for (const link of links) {
        try {
          const url = new URL(link);
          if (!['http:', 'https:'].includes(url.protocol)) captureIssues.push('AICA_LINK_SCHEME_UNKNOWN');
          if (/^(?:www\.)?(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|shorturl\.at|cutt\.ly|url\.kr|me2\.kr)$/i.test(url.hostname))
            captureIssues.push('AICA_SHORT_LINK');
        } catch { captureIssues.push('AICA_LINK_INVALID'); }
      }
      // Every link is an unverified RAW reference, never an image_urls assignment.
      const payload = { schema: 'aica-rich-grid/1', sheetId: grid.sheetId, tabId: grid.tabId,
        range: grid.range, row, plate: plateRaw, observedAt: grid.observedAt, sourceRevision: grid.revision,
        headers: grid.headers, cells, links, photoState: 'UNKNOWN', captureIssues: [...new Set(captureIssues)] };
      return { sourceRecordId: JSON.stringify([grid.sheetId, grid.tabId, row, plateRaw]),
        sourceFingerprint: fingerprint(payload), payload };
    });
    // Keep ambiguity fail-closed even when a caller hands this batch directly to
    // the existing ingestion lifecycle without the common evidence report.
    const complete = grids.every(grid => grid.complete && Number.isSafeInteger(grid.expectedRows) && grid.expectedRows === grid.rows.length)
      && records.every(record => record.payload.captureIssues.length === 0);
    const checksum = fingerprint(grids);
    const batch: SourceIntakeBatch = { laneId: 'PRODUCT_VEHICLE',
      source: { sourceId: input.sourceId, kind: 'GOOGLE_SHEET', displayName: '아이카 원본 rich-cell RAW',
        expectedFreshnessSeconds: input.expectedFreshnessSeconds },
      observedAt: grids.map(grid => grid.observedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0]!,
      observationTimes: grids.map(grid => grid.observedAt), sourceRevision: `aica-raw/1:${checksum}`, checksum,
      coverage: { mode: complete ? 'FULL' : 'PARTIAL', completeness: complete ? 'COMPLETE' : 'INCOMPLETE',
        scope: 'RP004 explicitly bound inventory ranges; not whole supplier inventory',
        note: 'Read time is not supplier modification time. RAW links have no photo authority.' }, records };
    validateSourceIntakeBatch(batch);
    return batch;
  } };
}

export const IRON_DETAIL_REQUEST_LIMITS = Object.freeze({ concurrency: 2, requestsPerVehicle: 1 });
export type IronDetailTarget = { id: string; url: string; plate: string };
/** No network implementation/default. Only approved targets; no discovery, redirects or retries. */
export type IronDetailFetcher = (target: Readonly<IronDetailTarget>) => Promise<{
  html: string; observedAt: string; revision: string;
}>;

// Small strict extractor for the observed explicit closing-tag markup. It is not a
// browser HTML repair algorithm. Unsupported/malformed markup remains RAW + HOLD.
type RawHtmlNode = { tag: string; attrs: Record<string, string>; start: number; end: number;
  text: string; children: RawHtmlNode[] };
function rawHtmlTree(html: string): { root: RawHtmlNode; valid: boolean } {
  const root: RawHtmlNode = { tag: '#root', attrs: {}, start: 0, end: html.length, text: '', children: [] };
  const stack = [root];
  let cursor = 0, valid = true;
  const tokens = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+(?:[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s<>]+))?))*\s*\/?>/g;
  for (const match of html.matchAll(tokens)) {
    const token = match[0], start = match.index!;
    if (start < cursor) continue;
    for (const node of stack) node.text += html.slice(cursor, start);
    cursor = start + token.length;
    if (token.startsWith('<!')) continue;
    const tag = /^<\/?([^\s/>]+)/.exec(token)![1]!.toLowerCase();
    if (token.startsWith('</')) {
      if (stack.at(-1)?.tag !== tag) { valid = false; continue; }
      stack.pop()!.end = cursor;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of token.slice(tag.length + 1, -1).matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attrs[attr[1]!.toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? '';
    const node: RawHtmlNode = { tag, attrs, start, end: cursor, text: '', children: [] };
    stack.at(-1)!.children.push(node);
    if (tag === 'script' || tag === 'style') {
      const close = new RegExp(`</${tag}\\s*>`, 'ig');
      close.lastIndex = cursor;
      const end = close.exec(html);
      if (!end) { valid = false; cursor = html.length; break; }
      cursor = end.index + end[0].length;
      node.end = cursor;
      continue;
    }
    if (!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag) && !token.endsWith('/>')) stack.push(node);
  }
  for (const node of stack) node.text += html.slice(cursor);
  return { root, valid: valid && stack.length === 1 };
}
const descendants = (node: RawHtmlNode): RawHtmlNode[] => node.children.flatMap(child => [child, ...descendants(child)]);
const hasClass = (node: RawHtmlNode, name: string) => (node.attrs.class ?? '').split(/\s+/).includes(name);

export function parseIronRawDetail(html: string, target: IronDetailTarget) {
  const { root, valid } = rawHtmlTree(html), nodes = descendants(root), captureIssues: string[] = [];
  if (!valid) captureIssues.push('IRON_HTML_SHAPE_UNKNOWN');
  const mains = nodes.filter(node => node.tag === 'main');
  const main = mains[0], mainNodes = main ? descendants(main) : [];
  if (mains.length !== 1 || !mainNodes.some(node => node.tag === 'h1' && hasClass(node, 'product-detail-title')))
    captureIssues.push('IRON_DETAIL_IDENTITY_UNKNOWN');
  const plates: string[] = [];
  for (const parent of [root, ...nodes]) {
    if (parent !== main && !mainNodes.includes(parent)) continue;
    parent.children.forEach((node, index) => {
      if (node.tag === 'dt' && node.text.trim() === '차량번호' && parent.children[index + 1]?.tag === 'dd')
        plates.push(parent.children[index + 1]!.text);
    });
  }
  if (plates.length !== 1 || plate(plates[0]) !== plate(target.plate)) captureIssues.push('IRON_PLATE_MISMATCH');
  const terms = nodes.filter(node => hasClass(node, 'product-detail-rent-row')).map(node => {
    const children = descendants(node), periods = children.filter(child => child.tag === 'dt'), rents = children.filter(child => child.tag === 'dd');
    if (periods.length !== 1 || rents.length !== 1) captureIssues.push('IRON_TERM_SHAPE_UNKNOWN');
    return { periodRaw: periods.map(child => child.text).join(''), rentRaw: rents.map(child => child.text).join(''),
      htmlRaw: html.slice(node.start, node.end) };
  });
  if (!terms.length || terms.some(term => !term.periodRaw.trim() || !term.rentRaw.trim())) captureIssues.push('IRON_TERMS_UNKNOWN');
  const deposits = nodes.filter(node => hasClass(node, 'product-detail-price-block--deposit')).map(node => node.text);
  // No generic money parser here: even explicit 0 stays original text pending normalization.
  const deposit = { raw: deposits, state: 'UNKNOWN' as const };
  if (deposits.length !== 1 || !deposits[0]?.trim()) captureIssues.push('IRON_DEPOSIT_UNKNOWN');
  const gallery = nodes.filter(node => hasClass(node, 'product-detail-gallery'));
  const image_urls = gallery.flatMap(node => descendants(node).filter(child => child.tag === 'img')
    .map(child => child.attrs.src).filter((src): src is string => !!src));
  if (!image_urls.length) captureIssues.push('IRON_PHOTOS_UNKNOWN');
  return { html, plateRaw: plates, terms, deposit, image_urls,
    mileageRaw: nodes.filter(node => hasClass(node, 'product-detail-rent-mileage-note')).map(node => node.text),
    captureIssues: [...new Set(captureIssues)] };
}

export function ironSourceAdapter(input: {
  sourceId: string; targets: readonly IronDetailTarget[]; expectedFreshnessSeconds: number | null;
  fetchDetail: IronDetailFetcher;
}): SupplierSourceAdapter {
  return { adapterId: 'iron-html', sourceId: input.sourceId, scope: 'inventory', read: async () => {
    const ids = new Set<string>(), plates = new Set<string>();
    for (const target of input.targets) {
      const url = new URL(target.url), identity = plate(target.plate);
      if (!text(target.id) || !identity || ids.has(target.id) || plates.has(identity)
        || url.origin !== 'https://ironrentcar.com' || url.username || url.password || url.hash
        || url.pathname !== `/vehicles/${encodeURIComponent(target.id)}`)
        throw new Error('IRON_TARGET_INVALID');
      ids.add(target.id); plates.add(identity);
    }
    if (!input.targets.length) throw new Error('IRON_TARGETS_EMPTY');
    const results: Array<{ observedAt: string; record: SourceIntakeBatch['records'][number] }> = [];
    // Sequential is intentionally below the port maximum of two concurrent calls.
    for (const target of input.targets) {
      const response = await input.fetchDetail(Object.freeze({ ...target }));
      if (!Number.isFinite(Date.parse(response.observedAt)) || !text(response.revision) || !text(response.html))
        throw new Error('IRON_DETAIL_EVIDENCE_INVALID');
      const payload = { schema: 'iron-html-raw/1', target: { ...target }, observedAt: response.observedAt,
        sourceRevision: response.revision, ...parseIronRawDetail(response.html, target) };
      results.push({ observedAt: response.observedAt, record: { sourceRecordId: target.id,
        sourceFingerprint: fingerprint(payload), payload } });
    }
    const checksum = fingerprint(results);
    const batch: SourceIntakeBatch = { laneId: 'PRODUCT_VEHICLE', source: { sourceId: input.sourceId,
      kind: 'API', displayName: '아이언 지정 상세 HTML RAW', expectedFreshnessSeconds: input.expectedFreshnessSeconds },
      observedAt: results.map(item => item.observedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0]!,
      observationTimes: results.map(item => item.observedAt), sourceRevision: `iron-raw/1:${checksum}`, checksum,
      coverage: { mode: 'PARTIAL', completeness: 'UNKNOWN', scope: 'RP006 explicitly approved details only',
        note: 'No listing crawl or supplier inventory completeness. No money/term normalization.' },
      records: results.map(item => item.record) };
    validateSourceIntakeBatch(batch);
    return batch;
  } };
}

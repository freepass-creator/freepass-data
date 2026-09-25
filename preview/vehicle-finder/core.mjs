/** Read-only presentation projection over the Vehicle Master hierarchy.
 * This module never invents master facts, canonical IDs, or writes.
 */
export const READ_SCHEMA = 'freepass.vehicle-finder.read/v2';

export const NODE_TYPES = Object.freeze({
  MAKE: '제조사',
  MODEL: '차종',
  GENERATION: '세대',
  PHASE: '변경형',
  MODEL_YEAR: '연식',
  POWERTRAIN: '파워트레인',
  VARIANT: '구성',
  TRIM: '트림',
  BASE_ITEM: '기본품목',
  OPTION: '옵션',
  PACKAGE: '패키지',
  OPTION_GROUP: '옵션그룹',
  COLOR: '색상',
});

/** Types that belong to Vehicle Master but are intentionally not Finder destinations. */
export const EXCLUDED_NODE_TYPES = Object.freeze(new Set([
  'BASE_ITEM', 'OPTION', 'PACKAGE', 'OPTION_GROUP', 'COLOR',
]));
export const LEVELS = NODE_TYPES;
export const FACETS = Object.freeze(['modelYear', 'fuel', 'seatCount', 'drivetrain', 'trim']);
export const SEARCH_RESULT_LIMIT = 100;

const text = value => typeof value === 'string' && value.trim().length > 0;
const normalize = value => String(value).normalize('NFKC').toLocaleLowerCase('ko-KR').trim();
const compact = value => normalize(value).replace(/\s+/gu, '');
const invalid = field => { throw new Error(`INVALID_FINDER_READ:${field}`); };
const indexCache = new WeakMap();

function validatePath(entry) {
  if (!Array.isArray(entry.path) || !entry.path.length) invalid('path');
  const ids = new Set();
  for (const node of entry.path) {
    if (!node || !text(node.id) || ids.has(node.id) || !Object.hasOwn(NODE_TYPES, node.nodeType) || !text(node.label)) {
      invalid('path');
    }
    ids.add(node.id);
  }
  const leaf = entry.path.at(-1);
  if (leaf.id !== entry.id || leaf.nodeType !== entry.nodeType || leaf.label !== entry.label) invalid('pathLeaf');
}

function searchable(entry) {
  return !EXCLUDED_NODE_TYPES.has(entry.nodeType);
}

/** Reject malformed/duplicate reads instead of silently repairing source identity or hierarchy. */
export function validateRead(input) {
  if (!input || input.schemaVersion !== READ_SCHEMA) invalid('schemaVersion');
  if (!text(input.observationId) || !text(input.observedAt) || !Number.isFinite(Date.parse(input.observedAt))) invalid('observation');
  if (!['COMPLETE', 'PARTIAL'].includes(input.coverage) || !Array.isArray(input.entries)) invalid('coverage');
  const ids = new Set();
  for (const entry of input.entries) {
    if (!entry || !text(entry.id) || ids.has(entry.id)) invalid('entryId');
    ids.add(entry.id);
    if (!Object.hasOwn(NODE_TYPES, entry.nodeType) || !text(entry.label)) invalid('entry');
    validatePath(entry);
    if (!Array.isArray(entry.aliases) || entry.aliases.some(value => !text(value))) invalid('aliases');
    if (!Array.isArray(entry.configurations)) invalid('configurations');
    const configurationIds = new Set();
    for (const configuration of entry.configurations) {
      if (!configuration || !text(configuration.id) || configurationIds.has(configuration.id)) invalid('configurationId');
      configurationIds.add(configuration.id);
      if (!text(configuration.evidenceId) || !Array.isArray(configuration.terms) ||
          configuration.terms.some(value => !text(value))) invalid('configurationEvidence');
      if (!configuration.facets || typeof configuration.facets !== 'object' ||
          Array.isArray(configuration.facets)) invalid('facets');
      for (const [key, value] of Object.entries(configuration.facets)) {
        if (!FACETS.includes(key)) invalid('facetKey');
        if (value !== null && !(text(value) || (Number.isSafeInteger(value) && value > 0))) invalid('facetValue');
      }
    }
  }
  return structuredClone(input);
}

export function normalizeFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) invalid('filters');
  const result = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!FACETS.includes(key)) invalid('filterKey');
    if (value === undefined || value === null || value === '') continue;
    if (!(text(value) || (Number.isSafeInteger(value) && value > 0))) invalid('filterValue');
    result[key] = String(value).trim();
  }
  return result;
}

const includesToken = (normalizedTerms, compactTerms, token) => {
  if (/^\d+$/.test(token)) {
    return normalizedTerms.some(term => term.split(/\D+/u).includes(token));
  }
  if (/^[a-z0-9-]+$/.test(token)) {
    return normalizedTerms.some(term =>
      term.split(/[^a-z0-9-]+/u).some(word =>
        word === token || (token.length > 1 && word.startsWith(token))
      )
    );
  }
  if (/^\d/.test(token)) {
    return normalizedTerms.some(term =>
      term.split(/(?<!\d)(?=\d)/u).some(part => part.startsWith(token))
    );
  }
  const tight = compact(token);
  return normalizedTerms.some(term => term.includes(token)) ||
    compactTerms.some(term => term.includes(tight));
};

function buildIndex(read) {
  const cached = indexCache.get(read);
  if (cached) return cached;
  const entries = read.entries.map(entry => ({
    entry,
    searchable: searchable(entry),
    pathText: entry.path.map(node => node.label).join(' › '),
    entryTerms: [entry.label, ...entry.aliases, ...entry.path.map(node => node.label)],
    configurations: entry.configurations.map(configuration => ({
      configuration,
      terms: [
        ...configuration.terms,
        ...Object.values(configuration.facets).filter(value => value != null),
      ],
    })),
  })).map(item => ({
    ...item,
    normalizedEntryTerms: item.entryTerms.map(normalize),
    compactEntryTerms: item.entryTerms.map(compact),
    configurations: item.configurations.map(config => ({
      ...config,
      normalizedTerms: config.terms.map(value => normalize(value)),
      compactTerms: config.terms.map(value => compact(value)),
    })),
  }));
  indexCache.set(read, entries);
  return entries;
}

function queryMatches(normalizedEntryTerms, compactEntryTerms, config, tokens) {
  const normalizedTerms = config
    ? [...normalizedEntryTerms, ...config.normalizedTerms]
    : normalizedEntryTerms;
  const compactTerms = config
    ? [...compactEntryTerms, ...config.compactTerms]
    : compactEntryTerms;
  return tokens.every(token => includesToken(normalizedTerms, compactTerms, token));
}

/** All explicit filters must hold on ONE evidence-backed configuration.
 * Parent path labels are searchable, so identical trim names remain distinguishable.
 */
export function searchEntries(read, query = '', filters = {}, options = {}) {
  const applied = normalizeFilters(filters);
  const tokens = normalize(query).split(/\s+/u).filter(Boolean);
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0
    ? options.limit
    : SEARCH_RESULT_LIMIT;
  const matches = [];
  let totalMatches = 0;
  let excludedUnknownFacetCount = 0;

  for (const indexed of buildIndex(read)) {
    if (!indexed.searchable) continue;
    const contexts = indexed.configurations.length ? indexed.configurations : [null];
    const queryContexts = contexts.filter(config =>
      queryMatches(indexed.normalizedEntryTerms, indexed.compactEntryTerms, config, tokens)
    );
    if (!queryContexts.length) continue;

    const matchedContexts = queryContexts.filter(config =>
      Object.entries(applied).every(([key, value]) =>
        config?.configuration.facets[key] != null &&
        normalize(config.configuration.facets[key]) === normalize(value)
      )
    );

    if (!matchedContexts.length && Object.keys(applied).length) {
      const hasUnknown = queryContexts.some(config =>
        Object.keys(applied).some(key => config?.configuration.facets[key] == null)
      );
      if (hasUnknown) excludedUnknownFacetCount++;
      continue;
    }
    if (!matchedContexts.length) continue;

    totalMatches++;
    if (matches.length < limit) {
      matches.push({
        entry: indexed.entry,
        pathText: indexed.pathText,
        matchedConfigurationIds: matchedContexts.filter(Boolean).map(item => item.configuration.id),
      });
    }
  }

  return {
    query,
    filters: applied,
    matches,
    totalMatches,
    hasMore: totalMatches > matches.length,
    excludedUnknownFacetCount,
    coverage: read.coverage,
    observationId: read.observationId,
  };
}

/** Selection is a reference at its actual master level, never a completed quote configuration. */
export function partialSelection(read, entryId, context = {}) {
  const entry = read.entries.find(item => item.id === entryId);
  if (!entry || !searchable(entry)) throw new Error('FINDER_SELECTION_NOT_IN_OBSERVATION');
  const candidateConfigurationIds = Array.isArray(context.matchedConfigurationIds)
    ? context.matchedConfigurationIds.filter(value => text(value))
    : [];
  return {
    kind: 'PARTIAL_REFERENCE',
    nodeId: entry.id,
    nodeType: entry.nodeType,
    label: entry.label,
    path: structuredClone(entry.path),
    observationId: read.observationId,
    configurationConfirmed: false,
    candidateConfigurationIds: [...new Set(candidateConfigurationIds)],
    searchContext: {
      query: context.query ?? '',
      filters: normalizeFilters(context.filters),
    },
  };
}

/** Transport may be injected only by an authorized read adapter. No demo fallback.
 * Refresh keeps the last-known-good snapshot visible until a newer valid snapshot arrives.
 */
export function createReadController(read, notify = () => {}) {
  let generation = 0;
  let abort;
  let disposed = false;
  let state = { status: 'idle', snapshot: null, error: null };
  const publish = next => { state = next; notify(state); };
  return {
    getState: () => state,
    async refresh() {
      if (disposed) return;
      const ticket = ++generation;
      abort?.abort();
      if (typeof read !== 'function') {
        publish({ status: 'not_connected', snapshot: state.snapshot, error: null });
        return;
      }
      abort = new AbortController();
      const previous = state.snapshot;
      publish({ status: previous ? 'refreshing' : 'loading', snapshot: previous, error: null });
      try {
        const payload = await read({ signal: abort.signal });
        if (disposed || ticket !== generation) return;
        publish({ status: 'ready', snapshot: validateRead(payload), error: null });
      } catch (error) {
        if (disposed || ticket !== generation) return;
        publish({
          status: 'error',
          snapshot: previous,
          error: error instanceof Error ? error.message : 'READ_FAILED',
        });
      }
    },
    dispose() { disposed = true; ++generation; abort?.abort(); },
  };
}

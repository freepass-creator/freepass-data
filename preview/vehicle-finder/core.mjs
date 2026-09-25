/** Read-only presentation model. This module neither creates canonical IDs nor writes facts. */
export const READ_SCHEMA = 'freepass.vehicle-finder.read/v1';
export const LEVELS = Object.freeze({
  MODEL: '차종', GENERATION: '세대', PHASE: '변경형', MODEL_YEAR: '연식',
  POWERTRAIN: '파워트레인', VARIANT: '구성', TRIM: '트림',
});
export const FACETS = Object.freeze(['modelYear', 'fuel', 'seatCount', 'drivetrain', 'trim']);
const text = value => typeof value === 'string' && value.trim().length > 0;
const normalize = value => String(value).normalize('NFKC').toLocaleLowerCase('ko-KR').trim();
const invalid = field => { throw new Error(`INVALID_FINDER_READ:${field}`); };

/** Reject malformed/duplicate reads instead of silently dropping rows or inventing values. */
export function validateRead(input) {
  if (!input || input.schemaVersion !== READ_SCHEMA) invalid('schemaVersion');
  if (!text(input.observationId) || !text(input.observedAt) || !Number.isFinite(Date.parse(input.observedAt))) invalid('observation');
  if (!['COMPLETE', 'PARTIAL'].includes(input.coverage) || !Array.isArray(input.entries)) invalid('coverage');
  const ids = new Set();
  for (const entry of input.entries) {
    if (!entry || !text(entry.id) || ids.has(entry.id)) invalid('entryId');
    ids.add(entry.id);
    if (!Object.hasOwn(LEVELS, entry.level) || !text(entry.label)) invalid('entry');
    if (!Array.isArray(entry.aliases) || entry.aliases.some(value => !text(value))) invalid('aliases');
    if (!Array.isArray(entry.configurations)) invalid('configurations');
    const configurationIds = new Set();
    for (const configuration of entry.configurations) {
      if (!configuration || !text(configuration.id) || configurationIds.has(configuration.id)) invalid('configurationId');
      configurationIds.add(configuration.id);
      if (!text(configuration.evidenceId) || !Array.isArray(configuration.terms) || configuration.terms.some(value => !text(value))) invalid('configurationEvidence');
      if (!configuration.facets || typeof configuration.facets !== 'object' || Array.isArray(configuration.facets)) invalid('facets');
      for (const [key, value] of Object.entries(configuration.facets)) {
        if (!FACETS.includes(key)) invalid('facetKey');
        if (value !== null && !(text(value) || (Number.isSafeInteger(value) && value > 0))) invalid('facetValue');
      }
    }
  }
  // Own the read snapshot: a caller cannot mutate an in-flight observation by reference.
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

const includesToken = (terms, token) => terms.some(term => {
  const normalized = normalize(term);
  // A year/seat number must not match only a substring of a larger number.
  if (/^\d+$/.test(token)) return normalized.split(/\D+/u).includes(token);
  if (/^[a-z0-9-]+$/.test(token)) {
    return normalized.split(/[^a-z0-9-]+/u).some(word => word === token || (token.length > 1 && word.startsWith(token)));
  }
  if (/^\d/.test(token)) return normalized.split(/(?<!\d)(?=\d)/u).some(part => part.startsWith(token));
  return normalized.includes(token);
});

/** All conditions must hold on ONE configuration; never union siblings' attributes. */
export function searchEntries(read, query = '', filters = {}) {
  const applied = normalizeFilters(filters);
  const tokens = normalize(query).split(/\s+/u).filter(Boolean);
  const matches = [];
  for (const entry of read.entries) {
    const entryTerms = [entry.label, ...entry.aliases];
    const contexts = entry.configurations.length ? entry.configurations : [null];
    const matchedContexts = contexts.filter(configuration => {
      if (!Object.entries(applied).every(([key, value]) => configuration?.facets[key] != null && normalize(configuration.facets[key]) === normalize(value))) return false;
      const terms = [...entryTerms, ...(configuration?.terms ?? []), ...Object.values(configuration?.facets ?? {}).filter(value => value != null)];
      return tokens.every(token => includesToken(terms, token));
    });
    if (matchedContexts.length) matches.push({ entry, matchedConfigurationIds: matchedContexts.filter(Boolean).map(item => item.id) });
  }
  // Preserve source order. No history-based ranking or hidden condition relaxation.
  return { query, filters: applied, matches, coverage: read.coverage, observationId: read.observationId };
}

/** Selection is a reference at its actual level, NOT a complete vehicle/quote configuration. */
export function partialSelection(read, entryId, context = {}) {
  const entry = read.entries.find(item => item.id === entryId);
  if (!entry) throw new Error('FINDER_SELECTION_NOT_IN_OBSERVATION');
  return {
    kind: 'PARTIAL_REFERENCE', nodeId: entry.id, nodeType: entry.level, label: entry.label,
    observationId: read.observationId, configurationConfirmed: false,
    searchContext: { query: context.query ?? '', filters: normalizeFilters(context.filters) },
  };
}

/** Transport may be injected only by an authorized read adapter. No demo fallback. */
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
        publish({ status: 'not_connected', snapshot: null, error: null });
        return;
      }
      abort = new AbortController();
      publish({ status: 'loading', snapshot: null, error: null });
      try {
        const payload = await read({ signal: abort.signal });
        if (disposed || ticket !== generation) return;
        publish({ status: 'ready', snapshot: validateRead(payload), error: null });
      } catch (error) {
        if (disposed || ticket !== generation) return;
        publish({ status: 'error', snapshot: null, error: error instanceof Error ? error.message : 'READ_FAILED' });
      }
    },
    dispose() { disposed = true; ++generation; abort?.abort(); },
  };
}

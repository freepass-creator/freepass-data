export const SOURCE_FIRESTORE_COLLECTIONS = Object.freeze({
  sources: 'sources',
  runs: 'source_runs',
  heads: 'source_heads',
  raw: 'raw_records',
  candidates: 'normalized_candidates',
  lineage: 'field_lineage'
} as const);

export const sourceFirestoreDocumentId = (value: string) =>
  value.replaceAll('/', '__');

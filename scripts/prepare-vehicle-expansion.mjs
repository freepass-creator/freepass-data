import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BRANDS = ['BMW', '벤츠', 'KGM', '르노', '폭스바겐'];
export function prepare(bytes) {
  const source = JSON.parse(gunzipSync(bytes));
  if (source.schema !== 'kamatch-reference-catalog/v1' || !Array.isArray(source.rows)) throw Error('SOURCE_SCHEMA_REQUIRED');
  const selected = source.rows.filter(r => BRANDS.includes(r.brand) && r.visible === true);
  const ids = new Set();
  const records = selected.map(r => {
    if (!r.id || ids.has(r.id)) throw Error('SOURCE_ID_MISSING_OR_DUPLICATE');
    ids.add(r.id);
    for (const key of ['brand', 'model', 'lineup', 'trim']) if (typeof r[key] !== 'string' || !r[key].trim()) throw Error('SOURCE_IDENTITY_REQUIRED');
    return {
      sourceId: r.id,
      raw: Object.fromEntries(['brand', 'model', 'lineup', 'trim', 'price'].map(k => [k, r[k]])),
      // lineup is mixed provider taxonomy, not a proven POWERTRAIN identity.
      canonical: { makerId: null, modelId: null, generationId: null, modelYear: null, powertrainId: null, trimId: null },
      state: 'CANDIDATE_REQUIRES_CANONICAL_RECONCILIATION',
      priceUse: 'AUDIT_ONLY_NOT_CANONICAL',
    };
  }).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return {
    schema: 'freepass-vehicle-expansion-evidence/v1',
    observedDate: source.observedDate,
    provenance: { url: source.source, snapshotSha256: createHash('sha256').update(bytes).digest('hex'), repository: 'freepass-creator/freepass-estimate', commit: '4f5aa3a80f562803f4a5b15d247da1f489c2a604', path: 'docs/references/kamatch/catalog.snapshot.json.gz' },
    scope: { brands: BRANDS, excluded: ['현대', '기아', '제네시스', '현대 전기차', '기아 전기차'], visibleOnly: true, accountSaleAvailability: 'NOT_CONFIRMED_FOR_THESE_BRANDS' },
    counts: { records: records.length, rawModels: new Set(selected.map(r => `${r.brand}\u001f${r.model}`)).size, byBrand: Object.fromEntries(BRANDS.map(b => [b, selected.filter(r => r.brand === b).length])) },
    productionReady: false,
    records,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw Error('usage: node scripts/prepare-vehicle-expansion.mjs snapshot.json.gz output.json');
  writeFileSync(process.argv[3], JSON.stringify(prepare(readFileSync(process.argv[2])), null, 2) + '\n');
}

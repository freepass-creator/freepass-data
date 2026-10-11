import { createHash } from 'node:crypto';

export function orderedJsonDigest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

export function stableDigest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

export function compactFirestoreDocumentIdPart(value: string) {
  const safe = value.replace(/[\/#?[\]*]/g, '_');
  if (safe.length <= 180) return safe;
  const hash = createHash('sha256').update(value).digest('hex');
  return `${safe.slice(0, 100)}__sha256_${hash}`;
}

export function stableRecordSetDigest<T extends { lineageRecordId: string }>(
  values: readonly T[]
) {
  return stableDigest(
    [...values].sort((a, b) => a.lineageRecordId.localeCompare(b.lineageRecordId))
  );
}

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
        // Preserve the existing en-US producer order across Windows/CI host locales.
        .sort(([a], [b]) => a.localeCompare(b, 'en-US'))
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

export function stableRecordSetDigest<T extends { lineageRecordId: string }>(
  values: readonly T[]
) {
  return stableDigest(
    [...values].sort((a, b) => a.lineageRecordId.localeCompare(b.lineageRecordId, 'en-US'))
  );
}

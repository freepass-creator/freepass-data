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

export function stableRecordSetDigest<T extends { lineageRecordId: string }>(
  values: readonly T[]
) {
  return stableDigest(
    [...values].sort((a, b) => a.lineageRecordId.localeCompare(b.lineageRecordId))
  );
}

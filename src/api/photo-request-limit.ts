/** Per-process limits; request.ip follows the gateway's explicit trusted proxy hop boundary. */
export const PHOTO_REQUEST_LIMITS = {
  failedAuth: { capacity: 120, refillPerSecond: 20 },
  consumer: { capacity: 60, refillPerSecond: 10 },
  maxKeys: 4096, idleMs: 60_000, maxKeyLength: 200,
} as const;

/** Bounded memory, injectable clock. Full tables reject new keys instead of resetting active budgets. */
export function createPhotoRequestBucket(policy: { capacity: number; refillPerSecond: number }, now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  return {
    get size() { return buckets.size; },
    take(key: string): number {
      const time = now();
      for (const [id, entry] of buckets) if (time - entry.updatedAt >= PHOTO_REQUEST_LIMITS.idleMs) buckets.delete(id);
      if (key.length > PHOTO_REQUEST_LIMITS.maxKeyLength) return 1;
      let entry = buckets.get(key);
      if (!entry) {
        if (buckets.size >= PHOTO_REQUEST_LIMITS.maxKeys) return Math.max(1, Math.ceil(PHOTO_REQUEST_LIMITS.idleMs / 1000));
        entry = { tokens: policy.capacity, updatedAt: time }; buckets.set(key, entry);
      }
      entry.tokens = Math.min(policy.capacity, entry.tokens + Math.max(0, time - entry.updatedAt) * policy.refillPerSecond / 1000);
      entry.updatedAt = Math.max(time, entry.updatedAt);
      if (entry.tokens < 1) return Math.max(1, Math.ceil((1 - entry.tokens) / policy.refillPerSecond));
      entry.tokens--;
      return 0;
    },
  };
}

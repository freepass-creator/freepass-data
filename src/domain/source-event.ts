/** Event receipts belong to SourceIngestionStore, not a second source database. */
export type SourceEventObservation = {
  observationId: string; rawRef: string; fingerprint: string;
  version: number; verified: boolean;
};
export type SourceEventReceipt = {
  eventId: string; sourceId: string; owner: string; revision: number;
  leaseUntil: string; state: 'RESERVED' | 'UNKNOWN' | 'ARCHIVED';
  firstRawRef: string; latestRawRef: string | null; latestVersion: number;
  fingerprint: string; observations: SourceEventObservation[];
  archiveRefs: string[];
};
export type SourceEventClaim = {
  eventId: string; sourceId: string; owner: string; now: string; leaseUntil: string;
  observation: SourceEventObservation;
};

/** Expiry never grants another upload: a lost response must be reconciled. */
export function observeSourceEvent(previous: SourceEventReceipt | null, input: SourceEventClaim) {
  const o = input.observation;
  if (!/^[a-f0-9]{64}$/.test(input.eventId) || !input.sourceId || !input.owner
    || !Number.isFinite(Date.parse(input.now)) || !(Date.parse(input.leaseUntil) > Date.parse(input.now))
    || !o.rawRef || !o.observationId || !/^[a-f0-9]{64}$/.test(o.fingerprint)
    || !Number.isSafeInteger(o.version) || o.version < 0) throw new Error('INVALID_SOURCE_EVENT');
  if (!previous) return { acquired: true, conflict: false, receipt: {
    eventId: input.eventId, sourceId: input.sourceId, owner: input.owner, revision: 1,
    leaseUntil: input.leaseUntil, state: 'RESERVED', firstRawRef: o.rawRef,
    latestRawRef: o.verified ? o.rawRef : null, latestVersion: o.verified ? o.version : -1,
    fingerprint: o.fingerprint, observations: [structuredClone(o)], archiveRefs: [],
  } satisfies SourceEventReceipt };
  if (previous.sourceId !== input.sourceId) throw new Error('SOURCE_EVENT_BINDING_CONFLICT');
  const seen = previous.observations.find(x => x.observationId === o.observationId);
  if (seen && JSON.stringify(seen) !== JSON.stringify(o)) throw new Error('OBSERVATION_ID_CONFLICT');
  const receipt = structuredClone(previous);
  // Different bytes at the same/older version are evidence of a conflict, never a newer truth.
  const conflict = o.fingerprint !== receipt.fingerprint && (!o.verified || o.version <= receipt.latestVersion);
  if (!seen) { receipt.observations.push(structuredClone(o)); receipt.revision++; }
  if (o.verified && o.version > receipt.latestVersion) {
    receipt.latestRawRef = o.rawRef; receipt.latestVersion = o.version;
    receipt.fingerprint = o.fingerprint;
    // New evidence needs archive reconciliation; it does not reopen the upload grant.
    receipt.state = 'UNKNOWN';
  }
  return { acquired: false, conflict, receipt };
}

export function finishSourceEvent(previous: SourceEventReceipt, input: {
  revision: number; state: 'UNKNOWN' | 'ARCHIVED'; archiveRefs: string[];
}) {
  if (previous.revision !== input.revision) throw new Error('SOURCE_EVENT_REVISION_CONFLICT');
  if (previous.state === 'ARCHIVED' && input.state !== 'ARCHIVED') throw new Error('SOURCE_EVENT_ALREADY_ARCHIVED');
  return { ...previous, revision: previous.revision + 1, state: input.state,
    archiveRefs: [...new Set([...previous.archiveRefs, ...input.archiveRefs])] };
}

export type SupplierSourceObservation = {
  supplierCode: string; eventKey: string; observedAt: string;
  kind: 'KAKAO_MEMO' | 'KAKAO_TABLE' | 'SHEET' | 'API' | 'OTHER';
};

/** Descriptive frequency, never a field-authority decision or permission to collect a website. */
export function summarizeSupplierSources(observations: SupplierSourceObservation[], options: { now: string; days: number }) {
  const end = Date.parse(options.now);
  if (!Number.isFinite(end) || !Number.isSafeInteger(options.days) || options.days < 1 || options.days > 365)
    throw new Error('INVALID_OBSERVATION_WINDOW');
  const start = end - options.days * 86_400_000;
  const unique = new Map<string, SupplierSourceObservation>();
  for (const o of observations) {
    const time = Date.parse(o.observedAt);
    if (!o.supplierCode || !o.eventKey || !Number.isFinite(time) || time < start || time > end) continue;
    const key = JSON.stringify([o.supplierCode, o.eventKey]);
    const previous = unique.get(key);
    if (previous && previous.kind !== o.kind) throw new Error('SOURCE_OBSERVATION_KIND_CONFLICT');
    if (!previous || time < Date.parse(previous.observedAt)) unique.set(key, o);
  }
  const grouped = new Map<string, SupplierSourceObservation[]>();
  for (const o of unique.values()) grouped.set(o.supplierCode, [...(grouped.get(o.supplierCode) ?? []), o]);
  return [...grouped].map(([supplierCode, events]) => {
    const counts = { KAKAO_MEMO: 0, KAKAO_TABLE: 0, SHEET: 0, API: 0, OTHER: 0 };
    for (const event of events) counts[event.kind]++;
    const primary = counts.KAKAO_MEMO > events.length / 2
      ? 'KAKAO_MEMO_PRIMARY' : counts.SHEET > events.length / 2
        ? 'SHEET_PRIMARY' : 'MIXED_OR_INSUFFICIENT';
    return { supplierCode, counts, eventCount: events.length, primary,
      crossCheckObserved: counts.API > 0, // No inference that an unobserved website exists or is usable.
      latestAt: events.map(e => e.observedAt).sort((a, b) => Date.parse(b) - Date.parse(a))[0]!,
      window: { from: new Date(start).toISOString(), to: new Date(end).toISOString() },
      authorityChanged: false as const };
  }).sort((a, b) => a.supplierCode.localeCompare(b.supplierCode));
}

export function selectKakaoPilotSuppliers(observations: SupplierSourceObservation[], options: { now: string; days: number; limit: number }) {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error('INVALID_PILOT_LIMIT');
  return summarizeSupplierSources(observations, options)
    .filter(s => s.counts.KAKAO_MEMO + s.counts.KAKAO_TABLE > 0)
    .sort((a, b) => (b.counts.KAKAO_MEMO + b.counts.KAKAO_TABLE) - (a.counts.KAKAO_MEMO + a.counts.KAKAO_TABLE)
      || Date.parse(b.latestAt) - Date.parse(a.latestAt) || a.supplierCode.localeCompare(b.supplierCode))
    .slice(0, options.limit);
}

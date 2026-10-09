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

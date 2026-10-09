import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { NormalizedCandidateRecord, RawRecord, SourceDefinition, SourceHead, SourceRun } from '../domain/source.js';
import { decideSourceHead } from '../domain/source.js';
import type { SourceIngestionStore } from '../ports/source-store.js';
import type { FieldLineageRecord } from '../domain/lineage.js';
import { FIRESTORE_COLLECTIONS, sourceFirestoreDocumentId } from './firestore-layout.js';
import { getTargetFirebaseApp } from './firebase-target.js';
import { observeSourceEvent, finishSourceEvent, type SourceEventReceipt } from '../domain/source-event.js';

const C = {
  sources: FIRESTORE_COLLECTIONS.source.definitions,
  runs: FIRESTORE_COLLECTIONS.source.runs,
  heads: FIRESTORE_COLLECTIONS.source.heads,
  raw: FIRESTORE_COLLECTIONS.source.raw,
  candidates: FIRESTORE_COLLECTIONS.source.candidates,
  lineage: FIRESTORE_COLLECTIONS.source.lineage
} as const;

export class FirestoreSourceStore implements SourceIngestionStore {
  constructor(private readonly db: Firestore) {}

  async claimEvent(input: Parameters<SourceIngestionStore['claimEvent']>[0]) {
    return this.db.runTransaction(async tx => {
      const ref = this.db.collection(FIRESTORE_COLLECTIONS.source.eventReceipts).doc(sourceFirestoreDocumentId(input.eventId));
      const snap = await tx.get(ref);
      const result = observeSourceEvent(snap.exists ? snap.data() as SourceEventReceipt : null, input);
      if (snap.exists) tx.update(ref, { ...result.receipt });
      else tx.create(ref, result.receipt);
      return result;
    });
  }
  async getEvent(eventId: string) {
    const snap = await this.db.collection(FIRESTORE_COLLECTIONS.source.eventReceipts).doc(sourceFirestoreDocumentId(eventId)).get();
    return snap.exists ? snap.data() as SourceEventReceipt : null;
  }
  async finishEvent(eventId: string, input: Parameters<SourceIngestionStore['finishEvent']>[1]) {
    return this.db.runTransaction(async tx => {
      const ref = this.db.collection(FIRESTORE_COLLECTIONS.source.eventReceipts).doc(sourceFirestoreDocumentId(eventId));
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('SOURCE_EVENT_NOT_FOUND');
      const receipt = finishSourceEvent(snap.data() as SourceEventReceipt, input);
      tx.update(ref, { ...receipt });
      return receipt;
    });
  }

  async upsertSource(source: SourceDefinition) {
    await this.db.collection(C.sources).doc(sourceFirestoreDocumentId(source.sourceId)).set(source, { merge: true });
  }
  async getSource(sourceId: string) {
    const snap = await this.db.collection(C.sources).doc(sourceFirestoreDocumentId(sourceId)).get();
    return snap.exists ? snap.data() as SourceDefinition : null;
  }
  async beginRun(run: SourceRun) {
    await this.db.collection(C.runs).doc(run.runId).create(run);
  }
  async appendRaw(record: RawRecord) {
    await this.db.collection(C.raw).doc(sourceFirestoreDocumentId(record.rawRecordId)).create(record);
  }
  async appendCandidate(record: NormalizedCandidateRecord) {
    await this.db.collection(C.candidates).doc(sourceFirestoreDocumentId(record.candidateId)).create(record);
  }
  async appendLineage(record: FieldLineageRecord) {
    await this.db.collection(C.lineage).doc(record.lineageRecordId).create(record);
  }
  async completeRun(input: Parameters<SourceIngestionStore['completeRun']>[0]) {
    return this.db.runTransaction(async (tx) => {
      const runRef = this.db.collection(C.runs).doc(input.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) throw new Error(`Source run not found: ${input.runId}`);
      const run = runSnap.data() as SourceRun;

      const headRef = this.db.collection(C.heads).doc(sourceFirestoreDocumentId(run.sourceId));
      const headSnap = await tx.get(headRef);
      const currentHead = headSnap.exists ? headSnap.data() as SourceHead : null;

      if (run.status === 'COMPLETED') {
        return {
          acceptedAsHead: run.headStatus === 'CURRENT',
          headRunId: currentHead?.runId ?? null
        };
      }

      const decision = decideSourceHead(
        input.coverage,
        input.observedAt,
        currentHead?.observedAt
      );
      const { acceptedAsHead, headStatus } = decision;

      tx.update(runRef, {
        status: 'COMPLETED',
        completedAt: input.completedAt,
        observedAt: input.observedAt,
        checkpoint: input.checkpoint,
        coverage: input.coverage,
        headStatus,
        rawCount: input.rawCount,
        candidateCount: input.candidateCount,
        lineageCount: input.lineageCount,
        warningCount: input.warningCount
      });

      if (acceptedAsHead) {
        if (currentHead?.runId) {
          const previousRef = this.db.collection(C.runs).doc(currentHead.runId);
          tx.update(previousRef, { headStatus: 'STALE' });
        }
        tx.set(headRef, {
          sourceId: run.sourceId,
          runId: run.runId,
          observedAt: input.observedAt,
          acceptedAt: input.completedAt,
          checkpoint: input.checkpoint,
          coverage: input.coverage
        } satisfies SourceHead);
      }

      return {
        acceptedAsHead,
        headRunId: acceptedAsHead ? run.runId : currentHead?.runId ?? null
      };
    });
  }
  async failRun(input: Parameters<SourceIngestionStore['failRun']>[0]) {
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.collection(C.runs).doc(input.runId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error(`Source run not found: ${input.runId}`);
      // Completion may have committed before its response/readback failed.
      // A delayed failure must never invalidate an accepted immutable run.
      if (snap.get('status') !== 'RUNNING') return;
      tx.update(ref, { status: 'FAILED', completedAt: input.completedAt, error: input.error });
    });
  }
  async getRun(runId: string) {
    const snap = await this.db.collection(C.runs).doc(runId).get();
    return snap.exists ? snap.data() as SourceRun : null;
  }
  async getSourceHead(sourceId: string) {
    const snap = await this.db.collection(C.heads).doc(sourceFirestoreDocumentId(sourceId)).get();
    return snap.exists ? snap.data() as SourceHead : null;
  }
  async listRaw(runId: string) {
    const snap = await this.db.collection(C.raw).where('runId', '==', runId).get();
    return snap.docs.map((x) => x.data() as RawRecord);
  }
  async listCandidates(runId: string) {
    const snap = await this.db.collection(C.candidates).where('runId', '==', runId).get();
    return snap.docs.map((x) => x.data() as NormalizedCandidateRecord);
  }
  async listLineage(runId: string) {
    const snap = await this.db.collection(C.lineage).where('runId', '==', runId).get();
    return snap.docs.map((x) => x.data() as FieldLineageRecord);
  }
}

export function createFirestoreSourceStore() {
  return new FirestoreSourceStore(getFirestore(getTargetFirebaseApp()));
}

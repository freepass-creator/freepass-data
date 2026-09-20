import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { NormalizedCandidateRecord, RawRecord, SourceDefinition, SourceHead, SourceRun } from '../domain/source.js';
import { canAdvanceSourceHead } from '../domain/source.js';
import type { SourceStore } from '../ports/source-store.js';
import type { FieldLineageRecord } from '../domain/lineage.js';

const C = {
  sources: 'sources',
  runs: 'source_runs',
  raw: 'raw_records',
  candidates: 'normalized_candidates',
  lineage: 'field_lineage',
  heads: 'source_heads'
} as const;

export class FirestoreSourceStore implements SourceStore {
  constructor(private readonly db: Firestore) {}

  async upsertSource(source: SourceDefinition) {
    await this.db.collection(C.sources).doc(source.sourceId.replaceAll('/', '__')).set(source, { merge: true });
  }
  async getSource(sourceId: string) {
    const snap = await this.db.collection(C.sources).doc(sourceId.replaceAll('/', '__')).get();
    return snap.exists ? snap.data() as SourceDefinition : null;
  }
  async beginRun(run: SourceRun) {
    await this.db.collection(C.runs).doc(run.runId).create(run);
  }
  async appendRaw(record: RawRecord) {
    await this.db.collection(C.raw).doc(record.rawRecordId.replaceAll('/', '__')).create(record);
  }
  async appendCandidate(record: NormalizedCandidateRecord) {
    await this.db.collection(C.candidates).doc(record.candidateId.replaceAll('/', '__')).create(record);
  }
  async appendLineage(record: FieldLineageRecord) {
    await this.db.collection(C.lineage).doc(record.lineageRecordId).create(record);
  }
  async completeRun(input: Parameters<SourceStore['completeRun']>[0]) {
    return this.db.runTransaction(async (tx) => {
      const runRef = this.db.collection(C.runs).doc(input.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) throw new Error(`Source run not found: ${input.runId}`);
      const run = runSnap.data() as SourceRun;

      const headRef = this.db.collection(C.heads).doc(run.sourceId.replaceAll('/', '__'));
      const headSnap = await tx.get(headRef);
      const currentHead = headSnap.exists ? headSnap.data() as SourceHead : null;

      if (run.status === 'COMPLETED') {
        return {
          acceptedAsHead: run.headStatus === 'CURRENT',
          headRunId: currentHead?.runId ?? null
        };
      }

      const eligible = input.coverage.completeness === 'COMPLETE';
      const newerThanHead = canAdvanceSourceHead(input.observedAt, currentHead?.observedAt);
      const acceptedAsHead = eligible && newerThanHead;
      const headStatus = acceptedAsHead ? 'CURRENT' : eligible ? 'STALE' : 'INELIGIBLE';

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
  async failRun(input: Parameters<SourceStore['failRun']>[0]) {
    await this.db.collection(C.runs).doc(input.runId).update({
      status: 'FAILED', completedAt: input.completedAt, error: input.error
    });
  }
  async getRun(runId: string) {
    const snap = await this.db.collection(C.runs).doc(runId).get();
    return snap.exists ? snap.data() as SourceRun : null;
  }
  async getSourceHead(sourceId: string) {
    const snap = await this.db.collection(C.heads).doc(sourceId.replaceAll('/', '__')).get();
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
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is required for target FreePass Data writes');

  const appName = 'freepass-data-target';
  const app = getApps().some((item) => item.name === appName)
    ? getApp(appName)
    : initializeApp({ credential: applicationDefault(), projectId }, appName);

  return new FirestoreSourceStore(getFirestore(app));
}

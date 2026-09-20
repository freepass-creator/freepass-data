import type { Firestore } from 'firebase-admin/firestore';
import type {
  NormalizedCandidateRecord,
  RawRecord,
  SourceDefinition,
  SourceRun
} from '../domain/source.js';
import type { SourceStore } from '../ports/source-store.js';

const C = {
  sources: 'sources',
  runs: 'source_runs',
  raw: 'raw_records',
  candidates: 'normalized_candidates'
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

  async completeRun(input: Parameters<SourceStore['completeRun']>[0]) {
    await this.db.collection(C.runs).doc(input.runId).update({
      status: 'COMPLETED',
      completedAt: input.completedAt,
      observedAt: input.observedAt,
      checkpoint: input.checkpoint,
      rawCount: input.rawCount,
      candidateCount: input.candidateCount,
      warningCount: input.warningCount
    });
  }

  async failRun(input: Parameters<SourceStore['failRun']>[0]) {
    await this.db.collection(C.runs).doc(input.runId).update({
      status: 'FAILED',
      completedAt: input.completedAt,
      error: input.error
    });
  }

  async getRun(runId: string) {
    const snap = await this.db.collection(C.runs).doc(runId).get();
    return snap.exists ? snap.data() as SourceRun : null;
  }

  async listRaw(runId: string) {
    const snap = await this.db.collection(C.raw).where('runId', '==', runId).get();
    return snap.docs.map((x) => x.data() as RawRecord);
  }

  async listCandidates(runId: string) {
    const snap = await this.db.collection(C.candidates).where('runId', '==', runId).get();
    return snap.docs.map((x) => x.data() as NormalizedCandidateRecord);
  }
}

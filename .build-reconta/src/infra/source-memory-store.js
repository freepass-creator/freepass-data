import { decideSourceHead } from '../domain/source.js';
import { observeSourceEvent, finishSourceEvent } from '../domain/source-event.js';
const copy = (value) => structuredClone(value);
export class MemorySourceStore {
    events = new Map();
    async claimEvent(input) {
        const result = observeSourceEvent(this.events.get(input.eventId) ?? null, input);
        this.events.set(input.eventId, copy(result.receipt));
        return copy(result);
    }
    async getEvent(eventId) { return copy(this.events.get(eventId) ?? null); }
    async finishEvent(eventId, input) {
        const previous = this.events.get(eventId);
        if (!previous)
            throw new Error('SOURCE_EVENT_NOT_FOUND');
        const receipt = finishSourceEvent(previous, input);
        this.events.set(eventId, copy(receipt));
        return copy(receipt);
    }
    sources = new Map();
    runs = new Map();
    raw = new Map();
    candidates = new Map();
    lineage = new Map();
    heads = new Map();
    async upsertSource(source) { this.sources.set(source.sourceId, copy(source)); }
    async getSource(sourceId) { return copy(this.sources.get(sourceId) ?? null); }
    async beginRun(run) {
        if (this.runs.has(run.runId))
            throw new Error(`Source run already exists: ${run.runId}`);
        this.runs.set(run.runId, copy(run));
    }
    async appendRaw(record) {
        if (this.raw.has(record.rawRecordId))
            throw new Error(`Raw record is immutable: ${record.rawRecordId}`);
        this.raw.set(record.rawRecordId, copy(record));
    }
    async appendCandidate(record) {
        if (this.candidates.has(record.candidateId))
            throw new Error(`Candidate is immutable: ${record.candidateId}`);
        this.candidates.set(record.candidateId, copy(record));
    }
    async appendLineage(record) {
        if (this.lineage.has(record.lineageRecordId))
            throw new Error(`Lineage record is immutable: ${record.lineageRecordId}`);
        this.lineage.set(record.lineageRecordId, copy(record));
    }
    async completeRun(input) {
        const run = this.runs.get(input.runId);
        if (!run)
            throw new Error(`Source run not found: ${input.runId}`);
        const currentHead = this.heads.get(run.sourceId);
        if (run.status === 'COMPLETED') {
            return {
                acceptedAsHead: run.headStatus === 'CURRENT',
                headRunId: currentHead?.runId ?? null
            };
        }
        if (run.status !== 'RUNNING')
            throw new Error('SOURCE_RUN_NOT_RUNNING');
        const decision = decideSourceHead(input.coverage, input.observedAt, currentHead?.observedAt);
        const { acceptedAsHead, headStatus } = decision;
        Object.assign(run, {
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
            if (currentHead) {
                const previous = this.runs.get(currentHead.runId);
                if (previous?.headStatus === 'CURRENT')
                    previous.headStatus = 'STALE';
            }
            this.heads.set(run.sourceId, {
                sourceId: run.sourceId,
                runId: run.runId,
                observedAt: input.observedAt,
                acceptedAt: input.completedAt,
                checkpoint: copy(input.checkpoint),
                coverage: copy(input.coverage)
            });
        }
        return {
            acceptedAsHead,
            headRunId: acceptedAsHead ? run.runId : currentHead?.runId ?? null
        };
    }
    async failRun(input) {
        const run = this.runs.get(input.runId);
        if (!run)
            throw new Error(`Source run not found: ${input.runId}`);
        if (run.status !== 'RUNNING')
            return;
        Object.assign(run, { status: 'FAILED', completedAt: input.completedAt, error: input.error });
    }
    async getRun(runId) { return copy(this.runs.get(runId) ?? null); }
    async getSourceHead(sourceId) { return copy(this.heads.get(sourceId) ?? null); }
    async listRaw(runId) {
        return copy([...this.raw.values()].filter((x) => x.runId === runId));
    }
    async listCandidates(runId) {
        return copy([...this.candidates.values()].filter((x) => x.runId === runId));
    }
    async listLineage(runId) {
        return copy([...this.lineage.values()].filter((x) => x.runId === runId));
    }
    async getCandidate(candidateId) {
        return copy(this.candidates.get(candidateId) ?? null);
    }
    async listCandidatesBySource(sourceId) {
        return copy([...this.candidates.values()].filter((x) => x.sourceId === sourceId));
    }
}

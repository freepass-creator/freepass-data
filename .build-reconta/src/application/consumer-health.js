import { readConsumerRuntimeEvidence } from './consumer-runtime-evidence.js';
import { readSheetConsumerHealth } from './sheet-consumer-health.js';
import { CONSUMER_SWITCH_REGISTRY } from '../domain/consumer-cutover.js';
export const CONSUMER_HEALTH_CONTRACT_VERSION = 'consumer-health-v1';
export const CONSUMER_HEALTH_SCHEMA_VERSION = '1.0.0';
function statusOf(values) {
    if (values.includes('BLOCKED'))
        return 'BLOCKED';
    if (values.includes('DEGRADED'))
        return 'DEGRADED';
    return 'HEALTHY';
}
function registrationMap() {
    return new Map(CONSUMER_SWITCH_REGISTRY.map((registration) => [
        registration.consumerId,
        registration
    ]));
}
function nonSheetStatus(entry) {
    if (entry.runtime.state !== 'SUCCEEDED')
        return 'BLOCKED';
    if (entry.stage === 'FREEPASS_DATA_READ') {
        return entry.effectiveEvidence.productionReadbackVerified
            ? 'HEALTHY'
            : 'BLOCKED';
    }
    return entry.nextTransition?.allowed ? 'DEGRADED' : 'BLOCKED';
}
function runtimeSource(entry) {
    switch (entry.runtime.source) {
        case 'GATEWAY':
            return 'GATEWAY_RUNTIME';
        case 'WHITELABEL_AGGREGATE':
            return 'WHITELABEL_AGGREGATE';
        case 'NOT_IMPLEMENTED':
            return 'NOT_IMPLEMENTED';
        case 'SHEET_DELIVERY_EVIDENCE':
            return 'SHEET_DELIVERY';
    }
}
function runtimeEvidenceSummary(entry) {
    return {
        source: runtimeSource(entry),
        state: entry.runtime.state,
        observedAt: entry.runtime.occurredAt,
        ageMs: entry.runtime.ageMs,
        eventId: entry.runtime.eventId,
        receiptId: null,
        releaseAuthority: entry.runtime.approvedRelease ? 'CANONICAL_ACTIVE' : null,
        projectionId: entry.runtime.approvedRelease?.projectionId ?? null,
        releaseId: entry.runtime.approvedRelease?.releaseId ?? null,
        manifestId: entry.runtime.approvedRelease?.manifestId ?? null,
        authenticated: entry.effectiveEvidence.authenticationVerified,
        freepassReadVerified: entry.effectiveEvidence.freepassReadVerified,
        productionReadbackVerified: entry.effectiveEvidence.productionReadbackVerified,
        parityVerified: entry.effectiveEvidence.parityVerified,
        fallbackVerified: entry.effectiveEvidence.fallbackVerified
    };
}
function sheetEvidenceSummary(entry, registration) {
    const observedAt = entry.evidence.publicationCompletedAt ??
        entry.evidence.recordedAt;
    return {
        source: 'SHEET_DELIVERY',
        state: entry.evidence.freshness?.status ?? 'UNOBSERVED',
        observedAt,
        ageMs: entry.evidence.freshness?.readbackAgeMs ?? null,
        eventId: null,
        receiptId: entry.evidence.receiptId,
        releaseAuthority: entry.evidence.releaseAuthority,
        projectionId: entry.evidence.projectionId,
        releaseId: entry.evidence.releaseId,
        manifestId: entry.evidence.manifestId,
        authenticated: registration.evidence.authenticationVerified,
        freepassReadVerified: entry.evidence.freepassReadVerified,
        productionReadbackVerified: entry.evidence.productionReadbackVerified,
        parityVerified: registration.evidence.parityVerified,
        fallbackVerified: registration.evidence.fallbackVerified
    };
}
function mergeBlockers(...groups) {
    return [...new Set(groups.flat())];
}
function commonFields(registration, status, evidence, nextTransition, blockers) {
    return {
        consumerId: registration.consumerId,
        project: registration.project,
        repository: registration.repository,
        domains: [...registration.domains],
        status,
        currentStage: registration.stage,
        nextStage: nextTransition?.to ?? null,
        activeReadOwner: registration.activeReadOwner,
        targetReadOwner: registration.targetReadOwner,
        switchKey: registration.switchKey,
        evidence,
        nextTransition: nextTransition ? structuredClone(nextTransition) : null,
        blockers,
        staticHoldReasons: [...registration.holdReasons]
    };
}
export async function readConsumerHealth(accessEvents, sheetStore, policy) {
    const eventLimit = policy.eventLimit ?? 1000;
    const [runtime, sheets] = await Promise.all([
        readConsumerRuntimeEvidence(accessEvents, policy),
        readSheetConsumerHealth(sheetStore, policy)
    ]);
    const registrations = registrationMap();
    const sheetById = new Map(sheets.consumers.map((entry) => [entry.consumerId, entry]));
    const consumers = runtime.consumers.map((entry) => {
        const registration = registrations.get(entry.consumerId);
        if (!registration) {
            throw new Error('CONSUMER_HEALTH_REGISTRATION_MISSING');
        }
        const sheet = sheetById.get(entry.consumerId);
        if (sheet) {
            const evidence = sheetEvidenceSummary(sheet, registration);
            const blockers = mergeBlockers(sheet.blockers, sheet.nextTransition?.blockers ?? []);
            return commonFields(registration, sheet.status, evidence, sheet.nextTransition, blockers);
        }
        const evidence = runtimeEvidenceSummary(entry);
        const blockers = mergeBlockers(entry.runtime.blockers, entry.nextTransition?.blockers ?? []);
        return commonFields(registration, nonSheetStatus(entry), evidence, entry.nextTransition, blockers);
    });
    if (consumers.length !== CONSUMER_SWITCH_REGISTRY.length) {
        throw new Error('CONSUMER_HEALTH_COVERAGE_MISMATCH');
    }
    return {
        contractVersion: CONSUMER_HEALTH_CONTRACT_VERSION,
        schemaVersion: CONSUMER_HEALTH_SCHEMA_VERSION,
        generatedAt: policy.assessedAt,
        status: statusOf(consumers.map((entry) => entry.status)),
        policy: {
            maxAgeMs: policy.maxAgeMs,
            maxFutureSkewMs: policy.maxFutureSkewMs ?? 0,
            eventLimit
        },
        consumers
    };
}

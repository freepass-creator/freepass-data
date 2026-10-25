import { stableDigest } from '../shared/stable-digest.js';
const expectedConsumer = (workbook) => workbook === 'F01' ? 'google-sheets-f01' : 'google-sheets-f86';
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
export const hashSheetPublicationHandoff = (value) => stableDigest(value);
/** One digest domain shared by the producer, validator and fixtures.
 * Snapshot identity/timestamps are covered by handoffHash, not the data digest.
 */
export function hashSheetPublicationData(snapshot) {
    return stableDigest({
        products: snapshot.products,
        policies: snapshot.policies,
        partners: snapshot.partners,
        inventory: snapshot.inventory
    });
}
export function validateSheetPublicationHandoff(handoff) {
    const violations = [];
    if (handoff.contractVersion !== 'freepass-sheet-handoff-v1') {
        violations.push('UNSUPPORTED_HANDOFF_CONTRACT');
    }
    if (handoff.consumerId !== expectedConsumer(handoff.workbook)) {
        violations.push('CONSUMER_WORKBOOK_MISMATCH');
    }
    if (!Number.isFinite(Date.parse(handoff.generatedAt))) {
        violations.push('INVALID_GENERATED_AT');
    }
    const isBridgeProjection = handoff.approvedRelease?.projectionId === 'sheet-publication-bridge';
    if ((handoff.releaseAuthority === 'LEGACY_VERIFIED_BRIDGE' && !isBridgeProjection) ||
        (handoff.releaseAuthority === 'CANONICAL_ACTIVE' && isBridgeProjection)) {
        violations.push('RELEASE_AUTHORITY_PROJECTION_MISMATCH');
    }
    const releaseFields = [
        'projectionId',
        'releaseId',
        'manifestId',
        'inputDigest',
        'dataDigest',
        'observedAt'
    ];
    if (releaseFields.some((key) => !nonEmpty(handoff.approvedRelease?.[key])) ||
        !Number.isFinite(Date.parse(handoff.approvedRelease?.observedAt))) {
        violations.push('INCOMPLETE_APPROVED_RELEASE');
    }
    if (handoff.snapshot.version !== 1 ||
        !nonEmpty(handoff.snapshot.snapshotId) ||
        !Number.isFinite(Date.parse(handoff.snapshot.capturedAt)) ||
        !Array.isArray(handoff.snapshot.products) ||
        !Array.isArray(handoff.snapshot.policies) ||
        !Array.isArray(handoff.snapshot.partners)) {
        violations.push('INCOMPLETE_SNAPSHOT');
    }
    const inventory = handoff.snapshot.inventory;
    const counters = [
        inventory.registered,
        inventory.unavailable,
        inventory.open,
        inventory.listableDrift,
        inventory.statusKindDrift,
        inventory.sourceIdentityViolations,
        inventory.deletedMarkerViolations,
        inventory.blankPlateViolations,
        inventory.invalidPlateViolations,
        inventory.duplicatePlateViolations,
        inventory.depositRuleViolations
    ];
    if (counters.some((value) => !Number.isInteger(value) || value < 0)) {
        violations.push('INVALID_INVENTORY_COUNTER');
    }
    else {
        if (inventory.registered !== handoff.snapshot.products.length) {
            violations.push('REGISTERED_PRODUCT_COUNT_MISMATCH');
        }
        if (inventory.open + inventory.unavailable !== inventory.registered) {
            violations.push('INVENTORY_TOTAL_MISMATCH');
        }
        const byStatusTotal = Object.values(inventory.byStatus)
            .reduce((sum, value) => sum + value, 0);
        if (Object.values(inventory.byStatus)
            .some((value) => !Number.isInteger(value) || value < 0) ||
            byStatusTotal !== inventory.registered) {
            violations.push('INVENTORY_STATUS_TOTAL_MISMATCH');
        }
    }
    const manifest = handoff.manifest;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return { status: 'HOLD', violations: [...violations, 'MANIFEST_EVIDENCE_MISMATCH'] };
    }
    if (manifest.contractVersion !== 'freepass-sheet-manifest-v1' ||
        manifest.manifestId !== handoff.approvedRelease.manifestId ||
        manifest.releaseId !== handoff.approvedRelease.releaseId ||
        manifest.projectionId !== handoff.approvedRelease.projectionId ||
        manifest.releaseAuthority !== handoff.releaseAuthority ||
        manifest.sourceCaptureDigest !== handoff.approvedRelease.inputDigest ||
        manifest.dataDigest !== handoff.approvedRelease.dataDigest ||
        manifest.productCount !== handoff.snapshot.products.length ||
        manifest.policyCount !== handoff.snapshot.policies.length ||
        manifest.partnerCount !== handoff.snapshot.partners.length ||
        !Number.isFinite(Date.parse(manifest.sourceReadTime)) ||
        !Number.isFinite(Date.parse(manifest.generatedAt))) {
        violations.push('MANIFEST_EVIDENCE_MISMATCH');
    }
    if (manifest.sourceReadTime !== handoff.approvedRelease.observedAt ||
        handoff.snapshot.snapshotId !== handoff.approvedRelease.releaseId) {
        violations.push('RELEASE_LINEAGE_MISMATCH');
    }
    const snapshotDataDigest = hashSheetPublicationData(handoff.snapshot);
    if (snapshotDataDigest !== handoff.approvedRelease.dataDigest) {
        violations.push('SNAPSHOT_DATA_DIGEST_MISMATCH');
    }
    const { handoffHash, ...unsigned } = handoff;
    if (!/^[a-f0-9]{64}$/.test(handoffHash) ||
        hashSheetPublicationHandoff(unsigned) !== handoffHash) {
        violations.push('HANDOFF_HASH_MISMATCH');
    }
    return {
        status: violations.length ? 'HOLD' : 'PASS',
        violations
    };
}

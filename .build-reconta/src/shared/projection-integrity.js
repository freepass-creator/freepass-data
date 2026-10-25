import { stableDigest, stableRecordSetDigest } from './stable-digest.js';
function projectionCounts(release) {
    if (release.projectionId === 'erp-public') {
        const rows = release.data;
        if (rows.some((row) => !Array.isArray(row?.offers))) {
            return { products: rows.length, offers: 0, supported: false };
        }
        return {
            products: rows.length,
            offers: rows.reduce((sum, product) => sum + product.offers.length, 0),
            supported: true
        };
    }
    if (release.projectionId === 'admin-catalog') {
        const rows = release.data;
        if (rows.some((row) => !Array.isArray(row?.offers))) {
            return { products: rows.length, offers: 0, supported: false };
        }
        return {
            products: rows.length,
            offers: rows.reduce((sum, product) => sum + product.offers.length, 0),
            supported: true
        };
    }
    if (release.projectionId === 'estimate-newcar-master') {
        const rows = release.data;
        if (rows.some((row) => !row || typeof row.productId !== 'string' || !['ACTIVE', 'HOLD'].includes(row.status))) {
            return { products: rows.length, offers: 0, supported: false };
        }
        return { products: rows.length, offers: 0, supported: true };
    }
    return { products: release.data.length, offers: 0, supported: false };
}
export function verifyProjectionReleaseIntegrity(release, manifest, lineage) {
    const failures = [];
    const recomputedDataDigest = stableDigest(release.data);
    const recomputedCanonicalInputDigest = stableDigest(manifest.canonicalInputs);
    const recomputedLineageDigest = stableRecordSetDigest(lineage);
    const payloadCounts = projectionCounts(release);
    const offerCount = payloadCounts.offers;
    if (!payloadCounts.supported)
        failures.push('PROJECTION_PAYLOAD_SHAPE_UNSUPPORTED');
    const canonicalRevision = Math.max(0, ...manifest.canonicalInputs.map((item) => item.revision));
    if (recomputedDataDigest !== release.dataDigest) {
        failures.push('RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH');
    }
    if (manifest.dataDigest !== release.dataDigest) {
        failures.push('MANIFEST_DATA_DIGEST_MISMATCH');
    }
    if (recomputedCanonicalInputDigest !== manifest.inputDigest) {
        failures.push('MANIFEST_CANONICAL_INPUT_DIGEST_MISMATCH');
    }
    if (manifest.inputDigest !== release.inputDigest) {
        failures.push('RELEASE_INPUT_DIGEST_MISMATCH');
    }
    if (manifest.manifestId !== release.manifestId) {
        failures.push('MANIFEST_ID_MISMATCH');
    }
    if (manifest.releaseId !== release.releaseId) {
        failures.push('RELEASE_ID_MISMATCH');
    }
    if (manifest.projectionId !== release.projectionId) {
        failures.push('PROJECTION_ID_MISMATCH');
    }
    if (manifest.schemaVersion !== release.schemaVersion) {
        failures.push('SCHEMA_VERSION_MISMATCH');
    }
    if (manifest.productCount !== payloadCounts.products) {
        failures.push('PRODUCT_COUNT_MISMATCH');
    }
    if (manifest.offerCount !== offerCount) {
        failures.push('OFFER_COUNT_MISMATCH');
    }
    if (release.canonicalRevision !== canonicalRevision) {
        failures.push('CANONICAL_REVISION_MISMATCH');
    }
    if (manifest.fieldEvidenceCount !== lineage.length) {
        failures.push('EVIDENCE_COUNT_MISMATCH');
    }
    if (lineage.some((item) => item.releaseId !== release.releaseId)) {
        failures.push('EVIDENCE_RELEASE_ID_MISMATCH');
    }
    if (lineage.some((item) => item.projectionId !== release.projectionId)) {
        failures.push('EVIDENCE_PROJECTION_ID_MISMATCH');
    }
    if (lineage.some((item) => item.stage !== 'CANONICAL_TO_PROJECTION')) {
        failures.push('EVIDENCE_STAGE_MISMATCH');
    }
    if (new Set(lineage.map((item) => item.lineageRecordId)).size !== lineage.length) {
        failures.push('EVIDENCE_RECORD_ID_DUPLICATE');
    }
    if (!manifest.fieldEvidenceDigest) {
        failures.push('EVIDENCE_DIGEST_MISSING');
    }
    else if (manifest.fieldEvidenceDigest !== recomputedLineageDigest) {
        failures.push('EVIDENCE_DIGEST_MISMATCH');
    }
    return {
        valid: failures.length === 0,
        failures,
        dataDigest: {
            stored: release.dataDigest,
            manifest: manifest.dataDigest,
            recomputed: recomputedDataDigest
        },
        canonicalInputDigest: {
            stored: release.inputDigest,
            manifest: manifest.inputDigest,
            recomputed: recomputedCanonicalInputDigest
        },
        lineageDigest: {
            stored: manifest.fieldEvidenceDigest ?? null,
            recomputed: recomputedLineageDigest
        },
        counts: {
            products: payloadCounts.products,
            offers: offerCount,
            evidence: lineage.length
        },
        canonicalRevision
    };
}
export class ProjectionIntegrityError extends Error {
    failures;
    constructor(failures) {
        super(`Projection release integrity failed: ${failures.join(', ')}`);
        this.failures = failures;
    }
}
export function assertProjectionReleaseIntegrity(release, manifest, lineage) {
    const result = verifyProjectionReleaseIntegrity(release, manifest, lineage);
    if (!result.valid) {
        throw new ProjectionIntegrityError(result.failures);
    }
    return result;
}

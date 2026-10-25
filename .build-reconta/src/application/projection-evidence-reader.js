export async function readActiveProjectionEvidence(projections, projectionId) {
    if (typeof projections.getActiveEvidenceSnapshot === 'function') {
        const snapshot = await projections.getActiveEvidenceSnapshot(projectionId);
        return snapshot;
    }
    const release = await projections.getActive(projectionId);
    if (!release) {
        return {
            projectionId,
            release: null,
            manifest: null,
            lineage: [],
            consistency: 'PARTIAL_MULTI_READ'
        };
    }
    const [manifest, lineage] = await Promise.all([
        projections.getManifest(release.releaseId),
        projections.listProjectionLineage(release.releaseId)
    ]);
    return {
        projectionId,
        release,
        manifest,
        lineage,
        consistency: 'PARTIAL_MULTI_READ'
    };
}

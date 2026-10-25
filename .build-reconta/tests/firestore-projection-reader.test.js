import { describe, expect, it } from 'vitest';
import { projectionReader } from '../src/infra/firestore-projection-reader.js';
function fakeDb(documents) {
    const reads = [];
    const snapshot = (key) => ({
        exists: Object.hasOwn(documents, key),
        data: () => documents[key],
        get: (field) => documents[key]?.[field]
    });
    const querySnapshot = (collection, field, value) => ({
        docs: Object.entries(documents)
            .filter(([key, data]) => key.startsWith(collection + '/') && data[field] === value)
            .map(([key]) => ({ data: () => documents[key] }))
    });
    const collection = (name) => ({
        doc: (id) => ({
            kind: 'doc',
            key: name + '/' + id,
            get: async () => {
                const key = name + '/' + id;
                reads.push(key);
                return snapshot(key);
            }
        }),
        where: (field, _op, value) => ({
            kind: 'query',
            name,
            field,
            value,
            get: async () => {
                reads.push(name + '?' + field + '==' + String(value));
                return querySnapshot(name, field, value);
            }
        })
    });
    const db = {
        collection,
        runTransaction: async (fn) => fn({
            get: async (ref) => {
                if (ref.kind === 'doc') {
                    reads.push(ref.key);
                    return snapshot(ref.key);
                }
                reads.push(ref.name + '?' + ref.field + '==' + String(ref.value));
                return querySnapshot(ref.name, ref.field, ref.value);
            }
        })
    };
    return { db: db, reads };
}
describe('Firestore projection read boundary', () => {
    it('reads only the requested active release and its evidence', async () => {
        const fixture = fakeDb({
            'projection_active/erp-public': { releaseId: 'rel_test' },
            'projection_releases/rel_test': { releaseId: 'rel_test', projectionId: 'erp-public' },
            'projection_release_manifests/rel_test': { releaseId: 'rel_test' },
        });
        const reader = projectionReader(fixture.db);
        expect(Object.keys(reader).sort()).toEqual([
            'getActive',
            'getActiveEvidenceSnapshot',
            'getManifest',
            'listProjectionLineage'
        ]);
        expect((await reader.getActive('erp-public'))?.releaseId).toBe('rel_test');
        expect((await reader.getManifest('rel_test'))?.releaseId).toBe('rel_test');
        expect(await reader.listProjectionLineage('rel_test')).toEqual([]);
        expect(await reader.getActiveEvidenceSnapshot('erp-public')).toMatchObject({
            projectionId: 'erp-public',
            release: { releaseId: 'rel_test' },
            manifest: { releaseId: 'rel_test' },
            lineage: [],
            consistency: 'ATOMIC'
        });
        expect(fixture.reads).toEqual([
            'projection_active/erp-public',
            'projection_releases/rel_test',
            'projection_release_manifests/rel_test',
            'projection_field_lineage?releaseId==rel_test',
            'projection_active/erp-public',
            'projection_releases/rel_test',
            'projection_release_manifests/rel_test',
            'projection_field_lineage?releaseId==rel_test'
        ]);
    });
    it('does not create a release when no pointer exists', async () => {
        const fixture = fakeDb({});
        expect(await projectionReader(fixture.db).getActive('erp-public')).toBeNull();
        expect(fixture.reads).toEqual(['projection_active/erp-public']);
    });
    it('rejects path injection and a pointer that misidentifies its release', async () => {
        const badPath = fakeDb({ 'projection_active/erp-public': { releaseId: '../private/path' } });
        await expect(projectionReader(badPath.db).getActive('erp-public')).rejects.toThrow('Invalid release identity');
        expect(badPath.reads).toHaveLength(1);
        const mismatch = fakeDb({
            'projection_active/erp-public': { releaseId: 'rel_expected' },
            'projection_releases/rel_expected': { releaseId: 'rel_other' },
        });
        await expect(projectionReader(mismatch.db).getActive('erp-public')).rejects.toThrow('identity mismatch');
    });
});

import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import schema from '../contracts/data-access-event.v1.schema.json' with { type: 'json' };
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import firebaseAuthority from '../contracts/firebase-access-authority.v1.json' with { type: 'json' };
const addFormats = (typeof addFormatsModule === 'function'
    ? addFormatsModule
    : addFormatsModule.default);
describe('data-access-event-v1 contract', () => {
    it('validates events emitted by the gateway', async () => {
        const store = new MemoryDataAccessLogStore();
        let id = 0;
        const access = new DataAccessGateway(store, () => '2026-09-25T12:00:00.000Z', () => `event_${++id}`);
        await access.read({
            context: {
                actor: { id: 'service:contract-test', kind: 'SERVICE' },
                clientId: 'test-contract',
                purpose: 'validate access event schema'
            },
            operation: 'READ_CATALOG',
            resource: {
                kind: 'PROJECTION',
                name: 'erp-public',
                projectionId: 'erp-public'
            },
            summarize: () => ({
                count: 1,
                digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
            })
        }, async () => ({ ok: true }));
        const ajv = new Ajv2020({ strict: false });
        addFormats(ajv);
        const validate = ajv.compile(schema);
        expect(store.events).toHaveLength(2);
        for (const event of store.events) {
            expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
        }
    });
    it('rejects raw error text and unversioned event shapes by schema', () => {
        const ajv = new Ajv2020({ strict: false });
        addFormats(ajv);
        const validate = ajv.compile(schema);
        expect(validate({
            eventId: 'event',
            operationId: 'operation',
            mode: 'READ',
            phase: 'FAILED',
            operation: 'READ_CATALOG',
            actor: { id: 'service:test', kind: 'SERVICE' },
            clientId: 'test',
            purpose: 'test',
            resource: { kind: 'PROJECTION', name: 'erp-public' },
            reasonCode: 'FAILED',
            errorMessage: 'private backend detail',
            startedAt: '2026-09-25T12:00:00.000Z',
            occurredAt: '2026-09-25T12:00:00.000Z'
        })).toBe(false);
    });
});
describe('firebase access authority', () => {
    it('keeps Data write authority and denies unprofiled consumers while describing an approved server read', () => {
        expect(firebaseAuthority.authority.owner).toBe('freepass-data');
        expect(firebaseAuthority.authority.rule).toBe('FREEPASS_DATA_WRITE_AUTHORITY_WITH_EXPLICIT_SERVER_READ_PROFILES');
        expect(firebaseAuthority.authority.defaultConsumerRule).toBe('NO_FIREBASE_BUSINESS_ACCESS_WITHOUT_AN_APPROVED_PROFILE');
        expect(firebaseAuthority.authority.firebaseAuthException).toBe('CONSUMERS_MAY_USE_FIREBASE_AUTH_FOR_IDENTITY_ONLY');
        expect(firebaseAuthority.prohibitedOutsideFreePassData).toEqual(expect.arrayContaining([
            expect.stringContaining('firebase/firestore'),
            expect.stringContaining('firebase/database'),
            expect.stringContaining('firebase/storage'),
            expect.stringContaining('service-account')
        ]));
        expect(firebaseAuthority.completionCriteria).toEqual(expect.arrayContaining([
            expect.stringContaining('no unapproved consumer or browser runtime holds Firebase business-data credentials'),
            expect.stringContaining('every read/write has consumer identity capability and purpose')
        ]));
    });
    // Test-local shape assertions describe policy boundaries, not a runtime authorizer or an IAM grant.
    const codeSha = '28b58768b109c664bcce34d3c95b36005c800f52';
    const profile = firebaseAuthority.serverReadProfiles[0];
    const invariantSchema = {
        type: 'object',
        properties: {
            id: { const: 'erp5-production-catalog-server-read' }, consumer: { const: 'freepasserp5' }, environment: { const: 'production' },
            executionBoundary: { const: 'SERVER_ONLY' }, operation: { const: 'READ_ONLY' },
            contractEffect: { const: 'POLICY_DESCRIPTION_ONLY_NOT_PERMISSION_GRANT' }, effectiveGrant: { const: false },
            target: { type: 'object', properties: { project: { const: 'freepasserp5' }, database: { const: '(default)' }, callerSelectedTargetAllowed: { const: false } },
                required: ['project', 'database', 'callerSelectedTargetAllowed'] },
            identity: { type: 'object', properties: { mode: { const: 'WIF' }, audience: { const: '//iam.googleapis.com/projects/110304297079/locations/global/workloadIdentityPools/erp5-production/providers/erp5-production' },
                    serviceAccount: { const: 'erp5-firestore-reader@freepasserp5.iam.gserviceaccount.com' },
                    oidcIssuer: { const: 'https://oidc.vercel.com/freepass-projects' }, oidcAudience: { const: 'https://vercel.com/freepass-projects' },
                    oidcSubject: { const: 'owner:freepass-projects:project:freepasserp5:environment:production' },
                    browserCredentialsAllowed: { const: false }, automaticCredentialFallbackAllowed: { const: false }, unexpiredClaimsRequired: { const: true } },
                required: ['mode', 'audience', 'serviceAccount', 'oidcIssuer', 'oidcAudience', 'oidcSubject', 'browserCredentialsAllowed', 'automaticCredentialFallbackAllowed', 'unexpiredClaimsRequired'] },
            readScope: { type: 'object', properties: { readerOperation: { const: 'getCatalogSnapshot' }, collections: { const: ['products', 'policy', 'partner'] },
                    fieldMaskExport: { const: 'CATALOG_FIELDS' }, fieldMaskAuthority: { const: 'codeEvidence.references.readMask' },
                    classification: { const: 'SERVER_READ_MASK_NOT_PUBLIC_RESPONSE_SCHEMA' }, publicResponseAllowlistRequired: { const: true },
                    readOnlyTransactionRequired: { const: true }, arbitraryCollectionsAllowed: { const: false }, catalogOffersAllowed: { const: false },
                    firestoreWritesAllowed: { const: false }, rtdbAllowed: { const: false }, storageAccessAllowed: { const: false } },
                required: ['readerOperation', 'collections', 'fieldMaskExport', 'fieldMaskAuthority', 'classification', 'publicResponseAllowlistRequired', 'readOnlyTransactionRequired', 'arbitraryCollectionsAllowed', 'catalogOffersAllowed', 'firestoreWritesAllowed', 'rtdbAllowed', 'storageAccessAllowed'] },
            feeAuthorization: { type: 'object', properties: { includedInCatalogProfile: { const: false }, separateHumanOrganizationFieldAuthorizationRequired: { const: true }, exactOfferIdTermKeyRevisionRequired: { const: true } },
                required: ['includedInCatalogProfile', 'separateHumanOrganizationFieldAuthorizationRequired', 'exactOfferIdTermKeyRevisionRequired'] },
            photoAccess: { type: 'object', properties: { mode: { const: 'SEPARATE_DATA_PHOTOS_CAPABILITY' }, consumerId: { const: 'erp5-public-media' }, capabilities: { const: ['photos'] }, directStorageOrSupplierCredentialsAllowed: { const: false } },
                required: ['mode', 'consumerId', 'capabilities', 'directStorageOrSupplierCredentialsAllowed'] },
            runtimeEvidence: { type: 'object', properties: { appliedIamGrant: { const: 'UNKNOWN' }, liveIdentityAndReadMaskEnforcement: { const: 'UNKNOWN' }, productionAccessVerified: { const: false }, newPermissionsGranted: { const: false } },
                required: ['appliedIamGrant', 'liveIdentityAndReadMaskEnforcement', 'productionAccessVerified', 'newPermissionsGranted'] },
        },
        required: ['id', 'consumer', 'environment', 'executionBoundary', 'operation', 'contractEffect', 'effectiveGrant', 'target', 'identity', 'readScope', 'feeAuthorization', 'photoAccess', 'runtimeEvidence'],
    };
    const validateProfile = new Ajv2020({ strict: false }).compile(invariantSchema);
    it('pins one description-only ERP5 profile to reviewed code rather than duplicating masks or granting IAM', () => {
        expect(firebaseAuthority.serverReadProfiles).toHaveLength(1);
        expect(validateProfile(profile), JSON.stringify(validateProfile.errors)).toBe(true);
        expect(profile.codeEvidence.state).toBe('CODE_CONFIRMED');
        expect(profile.codeEvidence.revision).toBe(codeSha);
        expect(Object.values(profile.codeEvidence.references)).toEqual(['firestore-config.mjs', 'firestore-auth.mjs', 'firestore-catalog-fields.mjs', 'firestore-reader.mjs']
            .map(file => `https://github.com/freepass-creator/freepasserp5/blob/${codeSha}/lib/${file}`));
        expect(profile.runtimeEvidence.iamBoundary).toBe('DATABASE_SCOPE_IS_NOT_COLLECTION_FIELD_OR_FEE_AUTHORIZATION');
        expect(profile.identity.audience).toBe('//iam.googleapis.com/projects/110304297079/locations/global/workloadIdentityPools/erp5-production/providers/erp5-production');
        expect(profile.requiredServerReadFlow).not.toContain('Data Access Gateway');
        expect(firebaseAuthority.requiredConsumerFlow).toContain('Data Access Gateway');
    });
    it.each(['missing-profile', 'consumer', 'preview', 'browser', 'project', 'database', 'identity', 'wif-audience', 'oidc-subject', 'caller-target', 'empty-mask', 'wildcard-mask', 'public-mask-bypass', 'offers', 'write', 'rtdb', 'storage', 'fee-human-org-field', 'fee-exact', 'photo', 'implicit-grant', 'iam-pass', 'new-permission', 'iam-evidence-pass'])('rejects unsafe policy description %s', scenario => {
        const altered = structuredClone(profile);
        if (scenario === 'missing-profile') {
            expect(validateProfile({})).toBe(false);
            return;
        }
        if (scenario === 'consumer')
            altered.consumer = 'unapproved-consumer';
        if (scenario === 'preview')
            altered.environment = 'preview';
        if (scenario === 'browser')
            altered.identity.browserCredentialsAllowed = true;
        if (scenario === 'project')
            altered.target.project = 'another-project';
        if (scenario === 'database')
            altered.target.database = 'another-database';
        if (scenario === 'identity')
            altered.identity.serviceAccount = 'unapproved@freepasserp5.iam.gserviceaccount.com';
        if (scenario === 'wif-audience')
            altered.identity.audience = 'unapproved-wif';
        if (scenario === 'oidc-subject')
            altered.identity.oidcSubject = 'owner:freepass-projects:project:freepasserp5:environment:preview';
        if (scenario === 'caller-target')
            altered.target.callerSelectedTargetAllowed = true;
        if (scenario === 'empty-mask')
            altered.readScope.fieldMaskAuthority = '';
        if (scenario === 'wildcard-mask')
            altered.readScope.collections = ['*'];
        if (scenario === 'public-mask-bypass')
            altered.readScope.publicResponseAllowlistRequired = false;
        if (scenario === 'offers')
            altered.readScope.catalogOffersAllowed = true;
        if (scenario === 'write')
            altered.readScope.firestoreWritesAllowed = true;
        if (scenario === 'rtdb')
            altered.readScope.rtdbAllowed = true;
        if (scenario === 'storage')
            altered.readScope.storageAccessAllowed = true;
        if (scenario === 'fee-human-org-field')
            altered.feeAuthorization.separateHumanOrganizationFieldAuthorizationRequired = false;
        if (scenario === 'fee-exact')
            altered.feeAuthorization.exactOfferIdTermKeyRevisionRequired = false;
        if (scenario === 'photo')
            altered.photoAccess.directStorageOrSupplierCredentialsAllowed = true;
        if (scenario === 'implicit-grant')
            altered.effectiveGrant = true;
        if (scenario === 'iam-pass')
            altered.runtimeEvidence.productionAccessVerified = true;
        if (scenario === 'new-permission')
            altered.runtimeEvidence.newPermissionsGranted = true;
        if (scenario === 'iam-evidence-pass')
            altered.runtimeEvidence.appliedIamGrant = 'PASS';
        expect(validateProfile(altered)).toBe(false);
    });
});

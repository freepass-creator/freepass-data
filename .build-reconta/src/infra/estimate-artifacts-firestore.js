import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { QUOTE_READ_RECEIPT_CONTRACT, QUOTE_WRITE_RECEIPT_CONTRACT, SHARE_ENVELOPE_READ_RECEIPT_CONTRACT, SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT, assertIssuedQuoteV2, assertShareEnvelopeV1, estimateArtifactDigest, quoteIdempotencyKey, shareEnvelopeIdempotencyKey, } from '../domain/estimate-artifacts.js';
const C = FIRESTORE_COLLECTIONS.estimateArtifacts;
function coded(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}
const quoteVersionId = (quoteId, version) => `${quoteId}__v${version}`;
const envelopeVersionId = (envelopeId, version) => `${envelopeId}__v${version}`;
function sameQuoteIdentity(a, b) {
    const { createdAt: _storedCreatedAt, ...storedIdentity } = a;
    const { createdAt: _retryCreatedAt, ...retryIdentity } = b;
    return estimateArtifactDigest(storedIdentity) === estimateArtifactDigest(retryIdentity);
}
function sameEnvelopeIdentity(a, b) {
    const { createdAt: _storedCreatedAt, ...storedIdentity } = a;
    const { createdAt: _retryCreatedAt, ...retryIdentity } = b;
    return estimateArtifactDigest(storedIdentity) === estimateArtifactDigest(retryIdentity);
}
export function estimateArtifactStore(db) {
    return {
        async putIssuedQuote(quote, idempotencyKey) {
            assertIssuedQuoteV2(quote);
            const expectedKey = quoteIdempotencyKey(quote);
            if (idempotencyKey !== expectedKey)
                throw coded('QUOTE_REPOSITORY_CONFLICT');
            const versionRef = db.collection(C.issuedQuotes).doc(quoteVersionId(quote.quoteId, quote.quoteVersion));
            const headRef = db.collection(C.issuedQuoteHeads).doc(quote.quoteId);
            return db.runTransaction(async (tx) => {
                const existing = await tx.get(versionRef);
                const head = await tx.get(headRef);
                if (existing.exists) {
                    const stored = existing.data();
                    assertIssuedQuoteV2(stored.quote);
                    if (stored.quoteId !== quote.quoteId ||
                        stored.quoteVersion !== quote.quoteVersion ||
                        stored.snapshotHash !== quote.snapshotHash ||
                        stored.idempotencyKey !== expectedKey ||
                        !sameQuoteIdentity(stored.quote, quote)) {
                        throw coded('QUOTE_REPOSITORY_CONFLICT');
                    }
                    return {
                        contract: QUOTE_WRITE_RECEIPT_CONTRACT,
                        status: 'EXISTING',
                        quoteId: quote.quoteId,
                        quoteVersion: quote.quoteVersion,
                        snapshotHash: quote.snapshotHash,
                        idempotencyKey: expectedKey,
                        persistedAt: stored.createdAt,
                    };
                }
                const currentHead = head.exists ? head.data() : null;
                if (quote.quoteVersion === 1) {
                    if (currentHead)
                        throw coded('QUOTE_REPOSITORY_CONFLICT');
                }
                else {
                    if (!currentHead || currentHead.latestVersion !== quote.quoteVersion - 1) {
                        throw coded('QUOTE_REVISION_INVALID');
                    }
                    const previousRef = db.collection(C.issuedQuotes)
                        .doc(quoteVersionId(quote.quoteId, quote.quoteVersion - 1));
                    const previous = await tx.get(previousRef);
                    if (!previous.exists)
                        throw coded('QUOTE_REVISION_INVALID');
                    const previousStored = previous.data();
                    const revision = quote.revision;
                    if (revision.previousQuoteVersion !== previousStored.quoteVersion ||
                        revision.previousSnapshotHash !== previousStored.snapshotHash ||
                        (revision.previousRevisionHash ?? null) !== (previousStored.quote.revisionHash ?? null)) {
                        throw coded('QUOTE_REVISION_INVALID');
                    }
                }
                const persistedAt = new Date().toISOString();
                const stored = {
                    quoteId: quote.quoteId,
                    quoteVersion: quote.quoteVersion,
                    snapshotHash: quote.snapshotHash,
                    idempotencyKey: expectedKey,
                    quote: structuredClone(quote),
                    createdAt: persistedAt,
                };
                const nextHead = {
                    quoteId: quote.quoteId,
                    latestVersion: quote.quoteVersion,
                    snapshotHash: quote.snapshotHash,
                    revisionHash: typeof quote.revisionHash === 'string' ? quote.revisionHash : null,
                    updatedAt: persistedAt,
                };
                tx.create(versionRef, stored);
                tx.set(headRef, nextHead);
                return {
                    contract: QUOTE_WRITE_RECEIPT_CONTRACT,
                    status: 'CREATED',
                    quoteId: quote.quoteId,
                    quoteVersion: quote.quoteVersion,
                    snapshotHash: quote.snapshotHash,
                    idempotencyKey: expectedKey,
                    persistedAt,
                };
            });
        },
        async getIssuedQuote(quoteId, quoteVersion = null) {
            let version = quoteVersion ?? null;
            if (version === null) {
                const head = await db.collection(C.issuedQuoteHeads).doc(quoteId).get();
                if (!head.exists) {
                    return {
                        contract: QUOTE_READ_RECEIPT_CONTRACT,
                        status: 'NOT_FOUND',
                        quoteId,
                        quoteVersion: null,
                    };
                }
                version = head.data().latestVersion;
            }
            const snap = await db.collection(C.issuedQuotes).doc(quoteVersionId(quoteId, version)).get();
            if (!snap.exists) {
                return {
                    contract: QUOTE_READ_RECEIPT_CONTRACT,
                    status: 'NOT_FOUND',
                    quoteId,
                    quoteVersion: version,
                };
            }
            const stored = snap.data();
            assertIssuedQuoteV2(stored.quote);
            if (stored.quoteId !== quoteId ||
                stored.quoteVersion !== version ||
                stored.snapshotHash !== stored.quote.snapshotHash) {
                throw coded('QUOTE_REPOSITORY_CONFLICT');
            }
            return {
                contract: QUOTE_READ_RECEIPT_CONTRACT,
                status: 'FOUND',
                quoteId,
                quoteVersion: version,
                snapshotHash: stored.snapshotHash,
                quote: stored.quote,
            };
        },
        async putShareEnvelope(envelope, idempotencyKey) {
            assertShareEnvelopeV1(envelope);
            const expectedKey = shareEnvelopeIdempotencyKey(envelope);
            if (idempotencyKey !== expectedKey)
                throw coded('SHARE_ENVELOPE_CONFLICT');
            const versionRef = db.collection(C.shareEnvelopes)
                .doc(envelopeVersionId(envelope.envelopeId, envelope.envelopeVersion));
            const headRef = db.collection(C.shareEnvelopeHeads).doc(envelope.envelopeId);
            return db.runTransaction(async (tx) => {
                const existing = await tx.get(versionRef);
                const head = await tx.get(headRef);
                if (existing.exists) {
                    const stored = existing.data();
                    assertShareEnvelopeV1(stored.envelope);
                    if (stored.envelopeId !== envelope.envelopeId ||
                        stored.envelopeVersion !== envelope.envelopeVersion ||
                        stored.snapshotHash !== envelope.snapshotHash ||
                        stored.idempotencyKey !== expectedKey ||
                        !sameEnvelopeIdentity(stored.envelope, envelope)) {
                        throw coded('SHARE_ENVELOPE_CONFLICT');
                    }
                    return {
                        contract: SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT,
                        status: 'EXISTING',
                        envelopeId: envelope.envelopeId,
                        envelopeVersion: envelope.envelopeVersion,
                        snapshotHash: envelope.snapshotHash,
                        idempotencyKey: expectedKey,
                        persistedAt: stored.createdAt,
                    };
                }
                const currentHead = head.exists ? head.data() : null;
                if (envelope.envelopeVersion === 1) {
                    if (currentHead)
                        throw coded('SHARE_ENVELOPE_CONFLICT');
                }
                else if (!currentHead || currentHead.latestVersion !== envelope.envelopeVersion - 1) {
                    throw coded('SHARE_ENVELOPE_CONFLICT');
                }
                for (const ref of envelope.quoteRefs) {
                    const quoteSnap = await tx.get(db.collection(C.issuedQuotes).doc(quoteVersionId(ref.quoteId, ref.quoteVersion)));
                    if (!quoteSnap.exists)
                        throw coded('SHARE_ENVELOPE_QUOTE_NOT_PERSISTED');
                    const quoteStored = quoteSnap.data();
                    if (quoteStored.snapshotHash !== ref.snapshotHash) {
                        throw coded('SHARE_ENVELOPE_QUOTE_RECEIPT_MISMATCH');
                    }
                }
                const persistedAt = new Date().toISOString();
                const stored = {
                    envelopeId: envelope.envelopeId,
                    envelopeVersion: envelope.envelopeVersion,
                    snapshotHash: envelope.snapshotHash,
                    idempotencyKey: expectedKey,
                    envelope: structuredClone(envelope),
                    createdAt: persistedAt,
                };
                const nextHead = {
                    envelopeId: envelope.envelopeId,
                    latestVersion: envelope.envelopeVersion,
                    snapshotHash: envelope.snapshotHash,
                    updatedAt: persistedAt,
                };
                tx.create(versionRef, stored);
                tx.set(headRef, nextHead);
                return {
                    contract: SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT,
                    status: 'CREATED',
                    envelopeId: envelope.envelopeId,
                    envelopeVersion: envelope.envelopeVersion,
                    snapshotHash: envelope.snapshotHash,
                    idempotencyKey: expectedKey,
                    persistedAt,
                };
            });
        },
        async getShareEnvelope(envelopeId, envelopeVersion = null) {
            let version = envelopeVersion ?? null;
            if (version === null) {
                const head = await db.collection(C.shareEnvelopeHeads).doc(envelopeId).get();
                if (!head.exists) {
                    return {
                        contract: SHARE_ENVELOPE_READ_RECEIPT_CONTRACT,
                        status: 'NOT_FOUND',
                        envelopeId,
                        envelopeVersion: null,
                    };
                }
                version = head.data().latestVersion;
            }
            const snap = await db.collection(C.shareEnvelopes)
                .doc(envelopeVersionId(envelopeId, version))
                .get();
            if (!snap.exists) {
                return {
                    contract: SHARE_ENVELOPE_READ_RECEIPT_CONTRACT,
                    status: 'NOT_FOUND',
                    envelopeId,
                    envelopeVersion: version,
                };
            }
            const stored = snap.data();
            assertShareEnvelopeV1(stored.envelope);
            if (stored.envelopeId !== envelopeId ||
                stored.envelopeVersion !== version ||
                stored.snapshotHash !== stored.envelope.snapshotHash) {
                throw coded('SHARE_ENVELOPE_CONFLICT');
            }
            return {
                contract: SHARE_ENVELOPE_READ_RECEIPT_CONTRACT,
                status: 'FOUND',
                envelopeId,
                envelopeVersion: version,
                snapshotHash: stored.snapshotHash,
                envelope: stored.envelope,
            };
        },
    };
}
export function createFirestoreEstimateArtifactStore() {
    return estimateArtifactStore(getFirestore(getTargetFirebaseApp()));
}

import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import type { EstimateArtifactStore } from '../ports/estimate-artifacts.js';
import {
  QUOTE_READ_RECEIPT_CONTRACT,
  QUOTE_WRITE_RECEIPT_CONTRACT,
  SHARE_ENVELOPE_READ_RECEIPT_CONTRACT,
  SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT,
  assertIssuedQuoteV2,
  assertShareEnvelopeV1,
  estimateArtifactDigest,
  quoteIdempotencyKey,
  shareEnvelopeIdempotencyKey,
  type IssuedQuoteV2,
  type ShareEnvelopeV1,
} from '../domain/estimate-artifacts.js';

const C = FIRESTORE_COLLECTIONS.estimateArtifacts;

function coded(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

const quoteVersionId = (quoteId: string, version: number) => `${quoteId}__v${version}`;
const envelopeVersionId = (envelopeId: string, version: number) => `${envelopeId}__v${version}`;

type QuoteStored = {
  quoteId: string;
  quoteVersion: number;
  snapshotHash: string;
  idempotencyKey: string;
  quote: IssuedQuoteV2;
  createdAt: string;
};

type QuoteHead = {
  quoteId: string;
  latestVersion: number;
  snapshotHash: string;
  revisionHash: string | null;
  updatedAt: string;
};

type EnvelopeStored = {
  envelopeId: string;
  envelopeVersion: number;
  snapshotHash: string;
  idempotencyKey: string;
  envelope: ShareEnvelopeV1;
  createdAt: string;
};

type EnvelopeHead = {
  envelopeId: string;
  latestVersion: number;
  snapshotHash: string;
  updatedAt: string;
};

function sameQuoteIdentity(a: IssuedQuoteV2, b: IssuedQuoteV2) {
  const { createdAt: _storedCreatedAt, ...storedIdentity } = a;
  const { createdAt: _retryCreatedAt, ...retryIdentity } = b;
  return estimateArtifactDigest(storedIdentity) === estimateArtifactDigest(retryIdentity);
}

function sameEnvelopeIdentity(a: ShareEnvelopeV1, b: ShareEnvelopeV1) {
  const { createdAt: _storedCreatedAt, ...storedIdentity } = a;
  const { createdAt: _retryCreatedAt, ...retryIdentity } = b;
  return estimateArtifactDigest(storedIdentity) === estimateArtifactDigest(retryIdentity);
}

export function estimateArtifactStore(db: Firestore): EstimateArtifactStore {
  return {
    async putIssuedQuote(quote, idempotencyKey) {
      assertIssuedQuoteV2(quote);
      const expectedKey = quoteIdempotencyKey(quote);
      if (idempotencyKey !== expectedKey) throw coded('QUOTE_REPOSITORY_CONFLICT');

      const versionRef = db.collection(C.issuedQuotes).doc(quoteVersionId(quote.quoteId, quote.quoteVersion));
      const headRef = db.collection(C.issuedQuoteHeads).doc(quote.quoteId);

      return db.runTransaction(async (tx) => {
        const existing = await tx.get(versionRef);
        const head = await tx.get(headRef);

        if (existing.exists) {
          const stored = existing.data() as QuoteStored;
          assertIssuedQuoteV2(stored.quote);
          if (
            stored.quoteId !== quote.quoteId ||
            stored.quoteVersion !== quote.quoteVersion ||
            stored.snapshotHash !== quote.snapshotHash ||
            stored.idempotencyKey !== expectedKey ||
            !sameQuoteIdentity(stored.quote, quote)
          ) {
            throw coded('QUOTE_REPOSITORY_CONFLICT');
          }
          return {
            contract: QUOTE_WRITE_RECEIPT_CONTRACT,
            status: 'EXISTING' as const,
            quoteId: quote.quoteId,
            quoteVersion: quote.quoteVersion,
            snapshotHash: quote.snapshotHash,
            idempotencyKey: expectedKey,
            persistedAt: stored.createdAt,
          };
        }

        const currentHead = head.exists ? head.data() as QuoteHead : null;
        if (quote.quoteVersion === 1) {
          if (currentHead) throw coded('QUOTE_REPOSITORY_CONFLICT');
        } else {
          if (!currentHead || currentHead.latestVersion !== quote.quoteVersion - 1) {
            throw coded('QUOTE_REVISION_INVALID');
          }
          const previousRef = db.collection(C.issuedQuotes)
            .doc(quoteVersionId(quote.quoteId, quote.quoteVersion - 1));
          const previous = await tx.get(previousRef);
          if (!previous.exists) throw coded('QUOTE_REVISION_INVALID');
          const previousStored = previous.data() as QuoteStored;
          const revision = quote.revision as Record<string, unknown>;
          if (
            revision.previousQuoteVersion !== previousStored.quoteVersion ||
            revision.previousSnapshotHash !== previousStored.snapshotHash ||
            (revision.previousRevisionHash ?? null) !== (previousStored.quote.revisionHash ?? null)
          ) {
            throw coded('QUOTE_REVISION_INVALID');
          }
        }

        const persistedAt = new Date().toISOString();
        const stored: QuoteStored = {
          quoteId: quote.quoteId,
          quoteVersion: quote.quoteVersion,
          snapshotHash: quote.snapshotHash,
          idempotencyKey: expectedKey,
          quote: structuredClone(quote),
          createdAt: persistedAt,
        };
        const nextHead: QuoteHead = {
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
          status: 'CREATED' as const,
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
            status: 'NOT_FOUND' as const,
            quoteId,
            quoteVersion: null,
          };
        }
        version = (head.data() as QuoteHead).latestVersion;
      }

      const snap = await db.collection(C.issuedQuotes).doc(quoteVersionId(quoteId, version)).get();
      if (!snap.exists) {
        return {
          contract: QUOTE_READ_RECEIPT_CONTRACT,
          status: 'NOT_FOUND' as const,
          quoteId,
          quoteVersion: version,
        };
      }

      const stored = snap.data() as QuoteStored;
      assertIssuedQuoteV2(stored.quote);
      if (
        stored.quoteId !== quoteId ||
        stored.quoteVersion !== version ||
        stored.snapshotHash !== stored.quote.snapshotHash
      ) {
        throw coded('QUOTE_REPOSITORY_CONFLICT');
      }
      return {
        contract: QUOTE_READ_RECEIPT_CONTRACT,
        status: 'FOUND' as const,
        quoteId,
        quoteVersion: version,
        snapshotHash: stored.snapshotHash,
        quote: stored.quote,
      };
    },

    async putShareEnvelope(envelope, idempotencyKey) {
      assertShareEnvelopeV1(envelope);
      const expectedKey = shareEnvelopeIdempotencyKey(envelope);
      if (idempotencyKey !== expectedKey) throw coded('SHARE_ENVELOPE_CONFLICT');

      const versionRef = db.collection(C.shareEnvelopes)
        .doc(envelopeVersionId(envelope.envelopeId, envelope.envelopeVersion));
      const headRef = db.collection(C.shareEnvelopeHeads).doc(envelope.envelopeId);

      return db.runTransaction(async (tx) => {
        const existing = await tx.get(versionRef);
        const head = await tx.get(headRef);

        if (existing.exists) {
          const stored = existing.data() as EnvelopeStored;
          assertShareEnvelopeV1(stored.envelope);
          if (
            stored.envelopeId !== envelope.envelopeId ||
            stored.envelopeVersion !== envelope.envelopeVersion ||
            stored.snapshotHash !== envelope.snapshotHash ||
            stored.idempotencyKey !== expectedKey ||
            !sameEnvelopeIdentity(stored.envelope, envelope)
          ) {
            throw coded('SHARE_ENVELOPE_CONFLICT');
          }
          return {
            contract: SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT,
            status: 'EXISTING' as const,
            envelopeId: envelope.envelopeId,
            envelopeVersion: envelope.envelopeVersion,
            snapshotHash: envelope.snapshotHash,
            idempotencyKey: expectedKey,
            persistedAt: stored.createdAt,
          };
        }

        const currentHead = head.exists ? head.data() as EnvelopeHead : null;
        if (envelope.envelopeVersion === 1) {
          if (currentHead) throw coded('SHARE_ENVELOPE_CONFLICT');
        } else if (!currentHead || currentHead.latestVersion !== envelope.envelopeVersion - 1) {
          throw coded('SHARE_ENVELOPE_CONFLICT');
        }

        for (const ref of envelope.quoteRefs) {
          const quoteSnap = await tx.get(
            db.collection(C.issuedQuotes).doc(quoteVersionId(ref.quoteId, ref.quoteVersion))
          );
          if (!quoteSnap.exists) throw coded('SHARE_ENVELOPE_QUOTE_NOT_PERSISTED');
          const quoteStored = quoteSnap.data() as QuoteStored;
          if (quoteStored.snapshotHash !== ref.snapshotHash) {
            throw coded('SHARE_ENVELOPE_QUOTE_RECEIPT_MISMATCH');
          }
        }

        const persistedAt = new Date().toISOString();
        const stored: EnvelopeStored = {
          envelopeId: envelope.envelopeId,
          envelopeVersion: envelope.envelopeVersion,
          snapshotHash: envelope.snapshotHash,
          idempotencyKey: expectedKey,
          envelope: structuredClone(envelope),
          createdAt: persistedAt,
        };
        const nextHead: EnvelopeHead = {
          envelopeId: envelope.envelopeId,
          latestVersion: envelope.envelopeVersion,
          snapshotHash: envelope.snapshotHash,
          updatedAt: persistedAt,
        };
        tx.create(versionRef, stored);
        tx.set(headRef, nextHead);

        return {
          contract: SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT,
          status: 'CREATED' as const,
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
            status: 'NOT_FOUND' as const,
            envelopeId,
            envelopeVersion: null,
          };
        }
        version = (head.data() as EnvelopeHead).latestVersion;
      }

      const snap = await db.collection(C.shareEnvelopes)
        .doc(envelopeVersionId(envelopeId, version))
        .get();
      if (!snap.exists) {
        return {
          contract: SHARE_ENVELOPE_READ_RECEIPT_CONTRACT,
          status: 'NOT_FOUND' as const,
          envelopeId,
          envelopeVersion: version,
        };
      }

      const stored = snap.data() as EnvelopeStored;
      assertShareEnvelopeV1(stored.envelope);
      if (
        stored.envelopeId !== envelopeId ||
        stored.envelopeVersion !== version ||
        stored.snapshotHash !== stored.envelope.snapshotHash
      ) {
        throw coded('SHARE_ENVELOPE_CONFLICT');
      }
      return {
        contract: SHARE_ENVELOPE_READ_RECEIPT_CONTRACT,
        status: 'FOUND' as const,
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

export function decodeFirestoreDocument(snap) {
    return snap.exists ? snap.data() : null;
}
export function decodeFirestoreIdentityDocument(snap, identityField) {
    if (!snap.exists)
        return null;
    const stored = snap.data();
    const payloadIdentity = stored[identityField];
    if (payloadIdentity !== undefined && payloadIdentity !== snap.id) {
        throw new Error(`Firestore document identity mismatch in ${snap.ref.parent.id}`);
    }
    return {
        ...stored,
        [identityField]: snap.id
    };
}

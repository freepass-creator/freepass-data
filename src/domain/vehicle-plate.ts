/**
 * One vehicle-number identity for every adapter: trim, drop all whitespace, upper-case.
 * Punctuation is kept on purpose — `12가-3456` and `12가3456` are not merged by identity.
 * Non-string input has no identity and yields ''.
 */
export const plateIdentityKey = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, '').toUpperCase() : '';

/** A supplier placeholder such as 「신차」·「미정」 carries no digit and must never identify a vehicle. */
export const isAssignedPlate = (value: unknown): boolean => /\d/.test(plateIdentityKey(value));

/** Strict Korean plate shape (optional region prefix, no inner whitespace). */
export const isStrictKoreanPlate = (value: unknown): boolean =>
  /^(?:[가-힣]{2})?\d{2,3}[가-힣]\d{4}$/.test(String(value ?? ''));

/**
 * Firestore-key safe form used only for sheet/document keys. It also strips `. $ # [ ] / -`,
 * so it must not be used to decide whether two records are the same vehicle.
 */
export const firestoreSafePlateKey = (value: unknown): string =>
  String(value ?? '').trim().replace(/[\s.$#[\]/-]/g, '');

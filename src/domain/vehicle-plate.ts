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

/**
 * 원천 엔진 시트 원천(공통 시트 F05·아이카)의 문서 ID 로 쓸 수 있는 번호: 공백을 뺀 값이 번호 모양(선택적 지역 두 글자 + 12가3456)이어야 한다.
 * `isAssignedPlate` 는 숫자만 있으면 참이라 «신차(11/5)» 같은 안내 글도 번호로 통과했다 — 공용 판정은 그대로 두고 이 원천들만 이 엄격 판정을 쓴다.
 */
export const isValidSheetPlate = (value: unknown): boolean =>
  isAssignedPlate(value) && isStrictKoreanPlate(plateIdentityKey(value));

/** 공급사 시트(공통 시트 F05·아이카·오토플러스) 월 대여료 칸의 공통 규칙(대표 2026-10-14 «데이터만큼은 정확하게 갖고 와야 된다»).
 * 한 곳에서만 정한다: 시트마다 «가격 없음» 낱말·범위가 달라 같은 칸 글자가 원천마다 다르게 읽히던 결함을 막는다. */
/** 월 대여료 타당 범위(원). 범위 밖 숫자는 단위 착오(«65» = 65만원을 숫자로 적음)나 오타일 수 있어 추정(×10000)하지 않고 확인 필요로 보류한다. */
export const MONTHLY_RENT_MIN = 100_000;
export const MONTHLY_RENT_MAX = 50_000_000;
export const isPlausibleMonthlyRent = (value) => Number.isSafeInteger(value) && value >= MONTHLY_RENT_MIN && value <= MONTHLY_RENT_MAX;
/** «이 기간은 가격 제안이 없다» 는 표시(그 기간만 빠지고 다른 기간에 가격이 있으면 차는 그대로 판매 가능). 대소문자·앞뒤 공백 무시. */
export const NO_PRICE_TEXTS = Object.freeze(['', '-', '--', '—', '–', '불가', 'X', '없음', 'N/A', '협의', '문의']);
const NO_PRICE = new Set(NO_PRICE_TEXTS);
export const isNoPriceText = (value) => value === null || value === undefined || (typeof value === 'string' && NO_PRICE.has(value.trim().toUpperCase()));

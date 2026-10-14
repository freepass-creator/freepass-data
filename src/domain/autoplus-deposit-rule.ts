/** 오토플러스(RP023) 보증금 규칙 — 대표 2026-10-14 «오토플러스는 구글 시트를 활용하고 보증금 칸이 있는 게 아니라 보증금을 구하는 방식(곱하기 계산 규칙)이
 * 시트에 있어. 그 참고를 오토플러스 홈페이지가 보라고. 시트를 메인으로 하되 홈페이지를 참고.»
 * 규칙: 보증금 = 월 대여료 × 2(국산) / × 3(수입). 공급사가 적은 금액이 아니라 «계산값»이다(문서에 deposit_source=CALCULATED 로 구분).
 * 국산/수입은 차명(제조사·차종·모델명) 낱말을 명시 목록과 맞춰 정한다. 어느 쪽에도 없거나 양쪽 다 걸리면 UNKNOWN(추측하지 않는다).
 * 쉐보레(GM 한국사업장)는 국내 생산·수입 모델이 섞여 있어 목록으로 가르지 않는다 → UNKNOWN(결정필요). */

export type AutoplusVehicleOrigin = 'DOMESTIC' | 'IMPORT';
export type AutoplusDepositRuleCode = 'AUTOPLUS_RENT_X2_DOMESTIC' | 'AUTOPLUS_RENT_X3_IMPORT';
export const AUTOPLUS_DEPOSIT_RULES: Readonly<Record<AutoplusDepositRuleCode, { origin: AutoplusVehicleOrigin; multiplier: number; label: string }>> = Object.freeze({
  AUTOPLUS_RENT_X2_DOMESTIC: { origin: 'DOMESTIC', multiplier: 2, label: '오토플러스 시트 규칙: 국산 월 대여료×2' },
  AUTOPLUS_RENT_X3_IMPORT: { origin: 'IMPORT', multiplier: 3, label: '오토플러스 시트 규칙: 수입 월 대여료×3' },
});
export const isAutoplusDepositRuleCode = (v: unknown): v is AutoplusDepositRuleCode =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(AUTOPLUS_DEPOSIT_RULES, v);

const DOMESTIC = [
  // 제조사
  '현대', '기아', '제네시스', '르노코리아', '르노삼성', 'KG모빌리티', 'KGM', '쌍용', 'HYUNDAI', 'KIA', 'GENESIS',
  // 현대
  '아반떼', '쏘나타', '그랜저', '코나', '투싼', '싼타페', '팰리세이드', '캐스퍼', '아이오닉', '스타리아', '포터', '베뉴', '넥쏘', 'IONIQ',
  // 기아
  '모닝', '레이', 'K3', 'K5', 'K8', 'K9', '셀토스', '스포티지', '쏘렌토', '카니발', '니로', 'EV3', 'EV4', 'EV5', 'EV6', 'EV9', '모하비', '봉고', '스팅어',
  // 제네시스
  'G70', 'G80', 'G90', 'GV60', 'GV70', 'GV80',
  // 르노코리아
  'QM6', 'XM3', '아르카나', 'SM6', '그랑콜레오스',
  // KG모빌리티
  '토레스', '티볼리', '코란도', '렉스턴', '액티언', '무쏘',
];
const IMPORT = [
  // 제조사
  'BMW', '벤츠', '메르세데스', 'MERCEDES', 'BENZ', '아우디', 'AUDI', '폭스바겐', 'VOLKSWAGEN', '볼보', 'VOLVO', '테슬라', 'TESLA',
  '미니', 'MINI', '렉서스', 'LEXUS', '토요타', '도요타', 'TOYOTA', '혼다', 'HONDA', '포르쉐', 'PORSCHE', '랜드로버', 'LANDROVER',
  '레인지로버', 'RANGEROVER', '지프', 'JEEP', '폴스타', 'POLESTAR', '푸조', 'PEUGEOT', '링컨', 'LINCOLN', '캐딜락', 'CADILLAC',
  '포드', 'FORD', '닛산', 'NISSAN', '인피니티', 'INFINITI', '마세라티', 'MASERATI',
  // 테슬라
  '모델3', '모델Y', '모델S', '모델X', 'MODEL3', 'MODELY', 'MODELS', 'MODELX',
  // BMW
  '1시리즈', '2시리즈', '3시리즈', '4시리즈', '5시리즈', '6시리즈', '7시리즈', '8시리즈', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'IX', 'IX1', 'IX3', 'I4', 'I5', 'I7',
  // 벤츠
  'A클래스', 'C클래스', 'E클래스', 'S클래스', 'GLA', 'GLB', 'GLC', 'GLE', 'GLS', 'CLA', 'CLS', 'EQA', 'EQB', 'EQE', 'EQS',
  // 아우디
  'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'Q2', 'Q3', 'Q4', 'Q5', 'Q7', 'Q8', 'ETRON',
  // 폭스바겐·볼보·미니
  '티구안', '골프', '아테온', '제타', '투아렉', 'ID4', 'XC40', 'XC60', 'XC90', 'S60', 'S90', 'V60', 'EX30', '쿠퍼', '컨트리맨',
  // 일본·기타
  '캠리', 'RAV4', '라브4', '프리우스', '시에나', '어코드', 'CRV', '오딧세이', '카이엔', '마칸', '파나메라', '타이칸',
  '디스커버리', '디펜더', '이보크', '벨라', '랭글러', '그랜드체로키', '체로키', '컴패스', '레니게이드',
  '노틸러스', '에비에이터', '네비게이터', '코세어', '에스컬레이드', '리릭', '익스플로러', '머스탱', '브롱코',
];
/** 국산·수입 섞임 → 목록으로 가르지 않는다(UNKNOWN). */
const AMBIGUOUS = ['쉐보레', '시보레', 'CHEVROLET', '트레일블레이저', '트랙스', '말리부', '스파크', '이쿼녹스', '콜로라도', '타호', '트래버스', '볼트'];

/** 대문자화 + 낱말 안의 하이픈·점 제거(E-클래스 → E클래스, ID.4 → ID4, MERCEDES-BENZ → MERCEDESBENZ). 낱말 경계는 공백·괄호·쉼표·슬래시. */
const tokensOf = (text: string): string[] => text.toUpperCase().replace(/[-.·_]/g, '').split(/[\s()[\]{},/+&]+/).filter(Boolean);
/** 한국어 차명 앞머리(더 뉴·디 올 뉴·올뉴 등)를 떼어 낸 변형도 본다: «더뉴아반떼» → «아반떼». */
const stripLead = (t: string) => t.replace(/^(?:THE|ALL|NEW|더|디|올|뉴)+/, '');
const isAscii = (s: string) => /^[A-Z0-9]+$/.test(s);
/** 항목 뒤에 붙어도 같은 차로 보는 한글 꼬리(파워트레인·차체). 그 밖의 한글 꼬리는 다른 이름이다(미니밴 ≠ 미니, 레이스 ≠ 레이). */
const KOREAN_TAILS = ['하이브리드', '일렉트릭', '전기', '가솔린', '디젤', '터보', '리무진', '왜건', '쿠페', '스포츠', '프리미엄', '플러그인', '플레이그라운드'];
/** 낱말이 항목과 같거나 «항목 + 허용 꼬리»인가(Codex #642 ③: 앞부분만 같다고 같은 차가 아니다).
 * 꼬리는 영문·숫자 세대·형식 기호(CN7·DN8·HEV)이거나 허용 한글 꼬리여야 하고, 영문·숫자 항목 바로 뒤의 숫자는 다른 차다(X3 ≠ X35, K3 ≠ K30). */
const startsWithEntry = (token: string, entry: string): boolean => {
  if (token === entry) return true;
  if (!token.startsWith(entry)) return false;
  const tail = token.slice(entry.length);
  if (isAscii(entry) && /^[0-9]/.test(tail)) return false;
  if (/^[A-Z0-9]+$/.test(tail)) return !isAscii(entry) || /^[A-Z]/.test(tail);   // 아반떼CN7, 쏘나타DN8, 그랜저GN7 / K5DL3
  return KOREAN_TAILS.includes(tail);
};
const matches = (list: readonly string[], tokens: readonly string[]): string[] => {
  const entries = list.map(e => e.toUpperCase());
  const candidates = new Set<string>();
  tokens.forEach((t, i) => {
    candidates.add(t); candidates.add(stripLead(t));
    // 두 낱말로 쓰는 이름(Model 3·레인지 로버·E 클래스)
    if (tokens[i + 1]) { const pair = t + tokens[i + 1]; candidates.add(pair); candidates.add(stripLead(pair)); }
  });
  return entries.filter(e => [...candidates].some(c => c && startsWithEntry(c, e)));
};

export type AutoplusOriginDecision =
  | { origin: AutoplusVehicleOrigin; matched: string[] }
  | { origin: 'UNKNOWN'; reason: 'NO_MATCH' | 'BOTH_MATCHED' | 'AMBIGUOUS_BRAND'; matched: string[] };

/** 차명 문구들(제조사·차종·모델명)에서 국산/수입을 판정한다. 근거가 없거나 서로 부딪히면 UNKNOWN. */
export function classifyAutoplusVehicleOrigin(...texts: ReadonlyArray<string | null | undefined>): AutoplusOriginDecision {
  const tokens = tokensOf(texts.filter((t): t is string => typeof t === 'string').join(' '));
  const ambiguous = matches(AMBIGUOUS, tokens);
  if (ambiguous.length) return { origin: 'UNKNOWN', reason: 'AMBIGUOUS_BRAND', matched: ambiguous };
  const domestic = matches(DOMESTIC, tokens), imported = matches(IMPORT, tokens);
  if (domestic.length && imported.length) return { origin: 'UNKNOWN', reason: 'BOTH_MATCHED', matched: [...domestic, ...imported] };
  if (domestic.length) return { origin: 'DOMESTIC', matched: domestic };
  if (imported.length) return { origin: 'IMPORT', matched: imported };
  return { origin: 'UNKNOWN', reason: 'NO_MATCH', matched: [] };
}

export const autoplusDepositRuleFor = (origin: AutoplusVehicleOrigin): AutoplusDepositRuleCode =>
  origin === 'DOMESTIC' ? 'AUTOPLUS_RENT_X2_DOMESTIC' : 'AUTOPLUS_RENT_X3_IMPORT';

/** 규칙 계산값. 대여료가 양의 정수가 아니면 null(ZERO 는 규칙에서 나오지 않는다). */
export function autoplusRuleDeposit(code: AutoplusDepositRuleCode, monthlyRent: unknown): number | null {
  if (!Number.isSafeInteger(monthlyRent) || (monthlyRent as number) <= 0) return null;
  const amount = (monthlyRent as number) * AUTOPLUS_DEPOSIT_RULES[code].multiplier;
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

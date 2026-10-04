/**
 * F03 세부트림 표시명 = 엔카 경로의 끝 이름에서 파워트레인 표시(배기량·연료·엔진 방식·구동)만 뗀 등급 이름
 * (대표 2026-10-04 확정 「배기량을 뺀 LT · TCe 인스파이어 · 기본형」). 뗀 뒤 남는 것이 없으면 「기본형」.
 * 엔진·연료·구동은 공통 시트 배기량·연료 칸이 맡는다. 인승(「9인승 노블레스」)은 등급 이름의 일부라 남긴다.
 * 예외: 모델 번호가 곧 등급인 수입차(520d · C300 4MATIC · S350 d 4MATIC · xDrive20i · B5 …)는 떼지 않는다.
 *
 * 떼는 낱말은 이 파일 하나로 고정한다 — 세션마다 다르게 떼지 않는다. 판단이 갈리는 낱말은
 * TRIM_UNDECIDED_TOKENS 에 두고 떼지 않는다(결정되면 이 파일을 고친다).
 */

/** 정확히 이 낱말(대소문자 무시)이면 뗀다. */
export const TRIM_POWERTRAIN_WORDS: readonly string[] = Object.freeze([
  // 연료
  '가솔린', '디젤', 'LPG', 'LPi', '하이브리드', 'HEV', 'PHEV', '전기', '바이퓨얼',
  // 엔진 방식
  'T-GDi', 'GDi', 'MPi', 'CRDi', 'VVT', 'CVVT', 'V6', 'V8',
  // 구동
  '2WD', '4WD', 'AWD', 'RWD', 'FWD',
]);

/** 모양으로 떼는 배기량 표시: 1.6 · 2.0T · 1.6T · 1600cc. */
export const TRIM_DISPLACEMENT_PATTERNS: readonly RegExp[] = Object.freeze([/^\d\.\dT?$/i, /^\d{3,4}cc$/i]);

/**
 * 엔진 이름이기도 하고 등급처럼 쓰이기도 해서 판단이 갈리는 낱말 — 떼지 않고 표시만 한다.
 * TCe 는 대표 예시(「TCe 인스파이어」)로 남긴다는 것이 확정이다. 나머지는 결정 대기.
 */
export const TRIM_UNDECIDED_TOKENS: readonly string[] = Object.freeze(['dCi', 'LPe', 'LPLI', 'VGT', 'e-VGT', '터보', 'TSI', 'TDI', '에코부스트', 'S/C']);
export const TRIM_KEPT_ENGINE_NAMES: readonly string[] = Object.freeze(['TCe']);

/** 수입차 트림 첫 낱말이 모델 번호이면(520d · C300 · M135i · AMG · xDrive20i · B5 · T5) 트림 전체를 그대로 둔다. */
const MODEL_DESIGNATION = /^(?:AMG|xDrive\d{0,2}[a-z]?|sDrive\d{0,2}[a-z]?|[A-Z]{0,2}\d{1,3}[A-Za-z]{0,3}\+?)$/;

export type TrimOrigin = '국산' | '수입';

export interface TrimDisplayName {
  readonly name: string;
  readonly removed: readonly string[];
  readonly undecided: readonly string[];
  readonly modelDesignation: boolean;
}

// NFKC 는 쓰지 않는다 — 엔카 글자(플래티넘Ⅰ·포터 Ⅱ 같은 로마 숫자 글자)를 그대로 지킨다.
const text = (value: string) => value.trim().replace(/\s+/g, ' ');
const lower = (values: readonly string[]) => new Set(values.map((value) => value.toLowerCase()));
const POWERTRAIN = lower(TRIM_POWERTRAIN_WORDS);
const UNDECIDED = lower(TRIM_UNDECIDED_TOKENS);

export function isTrimPowertrainToken(token: string): boolean {
  // 엔카는 「3.5 구조변경 (바이퓨얼)」처럼 연료를 괄호로 싸기도 한다 — 괄호 안 낱말로 판단한다.
  const bare = /^\((.+)\)$/.exec(token)?.[1] ?? token;
  return POWERTRAIN.has(bare.toLowerCase()) || TRIM_DISPLACEMENT_PATTERNS.some((pattern) => pattern.test(bare));
}

/** Encar end-level trim name → F03 세부트림 display name. */
export function trimDisplayName(value: string, origin: TrimOrigin): TrimDisplayName {
  // 「구조변경(LPG)」처럼 붙은 괄호도 파워트레인이면 떼어 낸다. 「트렌디(렌터카)」 같은 용도 괄호는 그대로.
  const spaced = text(value).replace(/\(([^()]+)\)/g, (whole, inner: string) => (isTrimPowertrainToken(inner) ? ` (${inner}) ` : whole));
  const tokens = spaced.split(' ').filter(Boolean);
  if (origin === '수입' && tokens.length > 0 && MODEL_DESIGNATION.test(tokens[0]!)) {
    return { name: tokens.join(' '), removed: [], undecided: [], modelDesignation: true };
  }
  const removed = tokens.filter(isTrimPowertrainToken);
  const kept = tokens.filter((token) => !isTrimPowertrainToken(token));
  return {
    name: kept.length ? kept.join(' ') : '기본형',
    removed,
    undecided: kept.filter((token) => UNDECIDED.has(token.toLowerCase())),
    modelDesignation: false,
  };
}

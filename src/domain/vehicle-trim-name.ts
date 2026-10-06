/**
 * 차종은 «모델 → 세부모델 → 파워트레인 → 세부트림» 4단이다(대표 2026-10-04 최종). 파워트레인(「1.6 GDI」 = 배기량 + 엔진,
 * 가솔린이냐 등)은 이미 제원 칸에 있으니 차종 마스터에 통째로 쓰지 않는다 — 차종 마스터는 모델·세부모델·세부트림뿐이다.
 * 엔카 «등급» 이름 = 파워트레인 + 세부트림이고, 이 함수는 그 파워트레인 부분을 통째로 버린다.
 * - 엔카에 세부등급이 있으면 그 글자 그대로가 세부트림이다(세부등급 글자 안의 TCe·GT-Line 같은 말도 엔카 글자라 그대로).
 * - 세부등급이 없으면 등급 이름에서 파워트레인 부분을 버린 나머지(「1.4 VVT 스타일」 → 「스타일」, 「M16 GDI 프리미어」 →
 *   「프리미어」, 「1.8 TCe 인스파이어」 → 「인스파이어」). 남는 게 없으면 「기본형」.
 * - 예외: 모델 번호가 곧 등급인 수입차(520d M 스포츠 · C300 4MATIC · S350 d 4MATIC · 40 TDI 콰트로 프리미엄 · B5 …)는 그대로.
 * 인승(「9인승 노블레스」의 9인승)은 제원 칸이라 뗀다(2026-10-04). 용도 괄호(「트렌디(렌터카)」)는 세부트림의 일부라 남긴다.
 * 제조사 공식 표기 낱말(기아 X Line → X-Line · BMW X Line → xLine · 현대 H Pick → H-Pick)은 엔카 대신 그 표기로 쓴다(TRIM_OFFICIAL_SPELLINGS, 제조사 필요).
 *
 * 아래 낱말 목록은 «파워트레인 부분»을 알아보는 수단일 뿐이다 — 정의는 위 4단 구조다. 목록은 이 파일 하나로 고정해
 * 세션마다 다르게 고르지 않는다. 새로 판단이 갈리는 낱말은 TRIM_UNDECIDED_TOKENS 에 두고 떼지 않는다.
 */

/**
 * 정확히 이 낱말(대소문자 무시)이면 뗀다.
 * 연료(HEV·PHEV·전기·바이퓨얼은 연료의 다른 표기, LPe·LPLI 는 LPG 표시) · 구동(RWD·FWD 는 구동의 다른 표기) ·
 * 엔진 이름(TCe·dCi·TSI·TDI·VGT·터보·에코부스트·S/C·GDi·T-GDi·CRDi·MPi·VVT·CVVT·V6·V8·M16 — 대표 최신 지적으로
 * 2026-10-04 「남김」에서 「뗌」으로 바뀜).
 */
export const TRIM_POWERTRAIN_WORDS: readonly string[] = Object.freeze([
  // 연료 — E-TECH(르노 하이브리드)·EV(쉐보레 볼트 「EV LT」)도 연료 표시
  '가솔린', '디젤', 'LPG', 'LPi', 'LPe', 'LPLI', '하이브리드', 'HEV', 'PHEV', '전기', '바이퓨얼', 'E-TECH', 'EV',
  // 구동 — ALL4 는 미니 사륜(AWD). 숫자 모델번호가 아니라 수입차 모델번호 예외에 걸리지 않는다
  '2WD', '4WD', 'AWD', 'RWD', 'FWD', 'ALL4',
  // 엔진 이름 — GTe·GDe 는 르노 엔진 이름
  'TCe', 'GTe', 'GDe', 'dCi', 'TSI', 'TDI', 'VGT', 'e-VGT', '터보', '에코부스트', 'S/C', 'e-S/C',
  'GDi', 'T-GDi', 'CRDi', 'MPi', 'VVT', 'CVVT', 'V6', 'V8', 'M16',
  // 앞 글자가 잘린 채 F03 에 남아 있던 옛 표기(E-TECH → 「ECH」, TCe → 「Ce」) — 엔카 원문에는 없고 F03 정비 때만 만난다
  'ECH', 'Ce',
]);

/** 모양으로 떼는 배기량 표시: 1.6 · 2.0T · 1.6T · 1600cc · LPG 배기량 L3.5(스타리아·스타렉스). */
export const TRIM_DISPLACEMENT_PATTERNS: readonly RegExp[] = Object.freeze([/^\d\.\dT?$/i, /^\d{3,4}cc$/i, /^L\d\.\d$/]);

/** 인승(7인승·9인승·11인승)은 제원 칸이라 세부트림에서 뗀다 — 엔카가 «9인승 노블레스»로 나눠도 세부트림은 «노블레스»(대표 2026-10-04 「인승 같은 건 제원」). */
const SEATS = /^\d{1,2}인승$/;

/**
 * 제조사 공식 표기 낱말 — 엔카를 따라 하지 않는 것(기준 한 장 2절 6번, 대표 2026-10-04). 목록은 대표가 정하고 그 장에만 둔다.
 * 같은 엔카 낱말도 제조사마다 공식 표기가 다르다(기아 「X-Line」 · BMW 「xLine」) — 그래서 제조사(F03 표시명)를 받아야 바꾼다.
 * 제조사를 모르면 바꾸지 않는다(틀린 표기로 바꾸지 않게). 이 목록은 수입차 모델 번호 예외보다 앞선다(BMW 「xDrive20i X Line」 → 「xDrive20i xLine」).
 */
export interface TrimOfficialSpelling {
  readonly maker: string;
  readonly encar: string;
  readonly ours: string;
}

export const TRIM_OFFICIAL_SPELLINGS: readonly TrimOfficialSpelling[] = Object.freeze([
  { maker: '기아', encar: 'X Line', ours: 'X-Line' },
  { maker: 'BMW', encar: 'X Line', ours: 'xLine' },
  { maker: '현대', encar: 'H Pick', ours: 'H-Pick' },
]);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const officialSpelling = (name: string, maker: string | undefined) =>
  TRIM_OFFICIAL_SPELLINGS.filter((entry) => entry.maker === maker)
    .reduce((acc, { encar, ours }) => acc.replace(new RegExp(`(^| )${escapeRegExp(encar)}(?= |$)`, 'g'), `$1${ours}`), name);

/** 판단이 갈리는 낱말 — 떼지 않고 표시만 한다(지금은 없음). 새로 생기면 여기에 두고 결정되면 위 목록으로 옮긴다. */
export const TRIM_UNDECIDED_TOKENS: readonly string[] = Object.freeze([]);

/** 수입차 트림 첫 낱말이 모델 번호이면(520d · C300 · M135i · AMG · xDrive20i · B5 · T5 · 40) 트림 전체를 그대로 둔다. */
const MODEL_DESIGNATION = /^(?:AMG|xDrive\d{0,2}[a-z]?|sDrive\d{0,2}[a-z]?|[A-Z]{0,2}\d{1,3}[A-Za-z]{0,3}\+?)$/;

export type TrimOrigin = '국산' | '수입';

export interface TrimDisplayName {
  readonly name: string;
  readonly removed: readonly string[];
  readonly undecided: readonly string[];
  readonly modelDesignation: boolean;
}

export interface TrimDisplayOptions {
  /** 값이 엔카 «세부등급» 칸이면 true — 그 글자 그대로 쓴다. */
  readonly isSubGrade?: boolean;
  /** F03 제조사 표시명(기아·BMW·현대 …) — 제조사 공식 표기 낱말을 고를 때 쓴다. 없으면 공식 표기를 대지 않는다. */
  readonly maker?: string;
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

/** Encar trim (세부등급, or 등급 when there is no 세부등급) → F03 세부트림 display name. */
export function trimDisplayName(value: string, origin: TrimOrigin, options: TrimDisplayOptions = {}): TrimDisplayName {
  if (options.isSubGrade) {
    const all = text(value).split(' ').filter(Boolean);
    const removed = all.filter((token) => SEATS.test(token));
    const name = all.filter((token) => !SEATS.test(token)).join(' ');
    return { name: name ? officialSpelling(name, options.maker) : '기본형', removed, undecided: [], modelDesignation: false };
  }
  // 「구조변경(LPG)」처럼 붙은 괄호도 파워트레인이면 떼어 낸다. 「트렌디(렌터카)」 같은 용도 괄호는 그대로.
  const spaced = text(value).replace(/\(([^()]+)\)/g, (whole, inner: string) => (isTrimPowertrainToken(inner) ? ` (${inner}) ` : whole));
  // 「1.6T-GDi」·「2.0T-GDi」처럼 배기량이 엔진 이름에 붙어 있으면 앞의 배기량을 떼어 낸다(→ 「1.6」 + 「T-GDi」).
  // 통째로 배기량 모양인 「2.5T」는 그대로 한 낱말이다.
  const tokens = spaced.split(' ').filter(Boolean).flatMap((token) => {
    const m = /^(\d\.\d)([A-Za-z].*)$/.exec(token);
    return m && !TRIM_DISPLACEMENT_PATTERNS.some((pattern) => pattern.test(token)) ? [m[1]!, m[2]!] : [token];
  });
  if (origin === '수입' && tokens.length > 0 && MODEL_DESIGNATION.test(tokens[0]!)) {
    // 모델 번호 등급은 엔카 글자 전체 그대로(2절 5번 예외) — 단 공식 표기 목록(6번)은 이 예외보다 앞선다.
    return { name: officialSpelling(tokens.join(' '), options.maker), removed: [], undecided: [], modelDesignation: true };
  }
  // 배기량 숫자 바로 뒤 「T」·디젤 표시 「D」(「2.2D」)도 배기량 표기의 일부로 같이 뗀다(「터보」는 위 목록에서 뗀다).
  // 옵션 이름 「터보 패키지」(「GT 마스터즈 터보 패키지」)의 「터보」만 파워트레인이 아니다 — 이 한 묶음만 남긴다.
  const drop = tokens.map((token, i) =>
    (isTrimPowertrainToken(token) && !(token === '터보' && tokens[i + 1] === '패키지'))
    || (/^(?:T|D)$/i.test(token) && i > 0 && /^\d\.\d$/.test(tokens[i - 1]!))
    || SEATS.test(token));
  const removed = tokens.filter((_, i) => drop[i]);
  const kept = tokens.filter((_, i) => !drop[i]);
  return {
    name: kept.length ? officialSpelling(kept.join(' '), options.maker) : '기본형',
    removed,
    undecided: kept.filter((token) => UNDECIDED.has(token.toLowerCase())),
    modelDesignation: false,
  };
}

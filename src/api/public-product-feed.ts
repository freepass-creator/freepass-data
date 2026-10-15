import type { CatalogCompatibilitySnapshot } from '../infra/erp5-compat-catalog-reader.js';
import { approvedPhotoCount, parsePhotoCopySuppliers } from '../domain/consumer-output-contract.js';

type Rec = Record<string, unknown>;

export type PublicDepositState = 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';

export type PublicProductFeedQuery = {
  p?: string | undefined;
  wl?: string | undefined;
};

export type PublicProductFeed = {
  contractVersion: '1.0';
  count: number;
  products: PublicProduct[];
  brand: string;
};

export type PublicProductQuote = {
  product: PublicProduct;
};

export type PublicProduct = {
  publicProductKey: string;
  _key: string;
  product_code: string;
  car_number: string | null;
  maker: string | null;
  model: string | null;
  sub_model: string | null;
  trim_name: string | null;
  trim_extra: string | null;
  variant: string | null;
  vehicle_class: string | null;
  fuel_type: string | null;
  engine_type: string | null;
  drive_type: string | null;
  transmission: string | null;
  usage: string | null;
  ext_color: string | null;
  int_color: string | null;
  accident_history: string | null;
  cert_car_name: string | null;
  location: string | null;
  provider_name: string | null;
  year: number | null;
  engine_cc: number | null;
  seats: number | null;
  mileage: number | null;
  battery_capacity: number | null;
  annual_mileage: number | null;
  first_registration_date: string | null;
  note: string | null;
  options: string | null;
  deposit_note: string | null;
  product_type: 'NEW_SUBSCRIPTION' | 'USED_SUBSCRIPTION' | 'RENTAL' | 'LEASE' | 'UNKNOWN_PUBLIC_TYPE' | null;
  vehicle_status: 'AVAILABLE' | 'CONSULT_REQUIRED' | 'CONTRACTING' | 'UNAVAILABLE' | 'UNKNOWN' | null;
  insurance_included: boolean | null;
  price: Record<string, { rent: number | null; deposit: number | null; depositState: PublicDepositState }>;
  image_url: string | null;
  image_urls: string[];
  photo_link: string | null;
  /** 사본 서빙이 보장된 승인 사진 수(이안카 압축 사본 refs 가 검증됐을 때만 > 0). 소비처는 이 값이 > 0 일 때만 사진 주소를 만든다. */
  photo_approved_count: number;
  /** 옵션(대표 2026-10-16 «손오공은 유상옵션이 있다»). 운영 변수 FREEPASS_DATA_PUBLIC_OPTIONS=1 일 때만 나가고 목록(list) 모드에서는 나가지 않는다. 값은 손오공 API 의 분류 후 이름뿐이며
   * 금액 꼴·번호 꼴 이름은 개별로 버린다(피드 전체를 던지지 않는다). option_state: PRESENT(옵션 있음)·NONE(원천이 옵션 없음이라 함)·UNKNOWN(미확인 — 원천에 옵션 필드 없음 포함). */
  /** 2트랙(대표 2026-10-16): 공급사 원문 표기(읽기 전용 파생·표시용)와 정제 상태. 정제 칸 값이 있으면 항상 그 값이 이기고, 비어 있고 PENDING 이면 원문을 «정제 대기»와 함께 쓴다.
   * FREEPASS_DATA_PUBLIC_SOURCE_RAW=1 일 때만 나간다(기본 꺼짐 — Codex #692: 원문에는 개인정보가 섞일 수 있어 켜기 전에 DRY 집계로 확인). */
  source_raw_name?: string | null;
  refine_state?: 'REFINED' | 'PENDING';
  refine_missing?: Array<'maker' | 'model' | 'sub_model'>;
  option_state?: 'PRESENT' | 'NONE' | 'UNKNOWN';
  option_basic?: string[];
  /** 유상 옵션. amount_krw 가 null 이면 «금액 확인 중». 가격 계산에는 쓰지 않는다(표시 전용). */
  option_paid?: Array<{ name: string; amount_krw: number | null }>;
  _policy: PublicPolicy | null;
};

type PublicPolicy = Record<string, string | number | boolean | null>;

const PUBLIC_TEXT_FIELDS = [
  'car_number', 'maker', 'model', 'sub_model', 'trim_name', 'trim_extra', 'variant',
  'vehicle_class', 'fuel_type', 'engine_type', 'drive_type', 'transmission', 'usage',
  'ext_color', 'int_color', 'accident_history', 'cert_car_name', 'location', 'provider_name',
] as const;

const PUBLIC_LONG_TEXT_FIELDS = ['note', 'options', 'deposit_note'] as const;
const PUBLIC_NUMBER_FIELDS = ['year', 'engine_cc', 'seats', 'mileage', 'battery_capacity', 'annual_mileage'] as const;
const PUBLIC_POLICY_ENUM_FIELDS = [
  'policy_name', 'policy_type', 'payment_method', 'payment_timing', 'penalty_condition',
  'rental_region', 'screening_criteria', 'basic_driver_age', 'driver_age_lowering',
  'driver_age_upper_limit', 'license_period', 'personal_driver_scope', 'business_driver_scope',
  'maintenance_service', 'credit_grade', 'uninsured_damage', 'own_damage_repair_ratio',
  'own_damage_compensation_rate',
] as const;
const PUBLIC_POLICY_BOOLEAN_FIELDS = [
  'insurance_included', 'deposit_installment', 'deposit_card_payment', 'rental_card_payment',
  'roadside_assistance',
] as const;
const PUBLIC_POLICY_NUMBER_FIELDS = [
  'injury_compensation_limit', 'injury_deductible', 'property_compensation_limit',
  'property_deductible', 'self_body_accident', 'self_body_deductible',
  'personal_injury_compensation_limit', 'personal_injury_deductible',
  'uninsured_compensation_limit', 'uninsured_deductible', 'own_damage_compensation',
  'own_damage_min_deductible', 'own_damage_max_deductible', 'annual_roadside_assistance',
  'annual_mileage', 'max_annual_mileage', 'mileage_upcharge_per_10000km', 'age_lowering_cost',
  'additional_driver_allowance_count', 'additional_driver_cost', 'deposit_return_days',
  'buyout_notice_days',
] as const;

const BLOCKED_TEXT = /(수수료|청구|지급|마진|commission|payout|\d[\d,]*(원|만원|%|KRW)|%)/i;
const BLOCKED_PUBLIC_VALUE = /(?:^|[^A-HJ-NPR-Z0-9])[A-HJ-NPR-Z0-9]{17}(?=$|[^A-HJ-NPR-Z0-9])|va_[A-Za-z0-9]{8,}/i;
const CONTROL_OR_PRIVATE = /[\u0000-\u001f\u007f]|<[^>]*>|https?:\/\/|(?:^|\/)(?:products|policy|partner|user)\/|@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|AIza[0-9A-Za-z_-]|ya29\./i;
const PUBLIC_KEY = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣_-]{0,79}$/;
const PRICE_KEY = /^[0-9]{1,3}(_[A-Za-z0-9가-힣.-]{1,20})?$/;
const DATE = /^\d{4}-\d{2}(?:-\d{2})?$/;

const OPTION_NAME_MAX = 80, OPTION_LIST_MAX = 300;
/** 옵션 이름 하나: 길이·금액 꼴·번호 꼴·제어/내부 값이 걸리면 null(그 항목만 버린다). */
/** 옵션 이름이 공개돼도 되는가(Codex #687): 전화번호·개인정보 낱말·금액(단위 앞 공백 포함)·수수료류 금지어(글자 사이 공백·기호로 쪼갠 꼴 포함)·번호 꼴·내부 값을 개별로 거른다. */
// «휴대폰 무선충전»·«블루투스 핸즈프리 전화» 같은 정상 옵션을 과차단하지 않도록 전화·휴대폰·핸드폰·문의 낱말 단독은 개인정보로 보지 않는다(번호는 OPTION_PHONE 이 막는다, Codex #687 ①).
const OPTION_PERSONAL_WORDS = /(고객|담당자?|연락처|연락주|연락요|계좌|주민|이메일|성명|실명|카톡\s?ID|카톡아이디)/;
const OPTION_PHONE = /(?<!\d)\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/;
// 숫자와 단위 사이 공백·하이픈·점·괄호, 통화기호 뒤 괄호까지 허용해 막는다(₩(50,000)·50,000-원, Codex #687 (a)).
const OPTION_MONEY = /\d[\d,.]*[\s\-–—.·)\]]*[(\[]?\s*(원|만(?!\s?(?:km|㎞|킬로|년|개월))|천(?!\s?(?:km|㎞|킬로|년|개월))|억|KRW|WON)|(?:[₩￦$€¥£]|KRW|WON|USD)[\s(\[]*\d/i;
// «50,000(원)»·«썬팅 50만»(원 생략)은 막고, «자외선 99% 차단»(퍼센트는 금액이 아님)·«20만km 보증»(거리·기간 단위)은 통과시킨다(Codex #687 잔여).
// 보이지 않는 문자 전체: 제어·서식(Cf: 제로폭·방향 제어·소프트 하이픈)·결합/변형 선택자(Mn: U+FE00·U+E0100 포함)·줄/문단 구분·사설 영역(Codex #687).
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Mn}\p{Zl}\p{Zp}\p{Co}]/gu;
const OPTION_BLOCKED_WORDS = /(수수료|청구|지급|마진|할인|commission|payout)/i;
const OPTION_FORBIDDEN_COMPACT =/(수수료|청구|지급|마진|원가|정산|commission|payout|billing|margin)/i;
const safeOptionName = (value: unknown, maxLength: number = OPTION_NAME_MAX, allowPercent = true): string | null => {
  if (typeof value !== 'string') return null;
  // 보이지 않는 문자(제로폭·방향 제어·소프트 하이픈 등)는 먼저 지운다 — «고​객»·«010​-1234» 우회 방지(Codex #687 (b)).
  const text = value.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > maxLength) return null;
  // 원문 표기 플래그가 꺼진 응답에서는 옵션 검증이 종전(#687)과 같아야 한다: «%» 가 든 이름은 공용 금지값 검사에서 걸리므로 미리 개별로 버린다(피드 전체를 던지지 않게).
  if (!allowPercent && /%/.test(text)) return null;
  const compact = text.replace(/[\s\p{P}\p{S}_]+/gu, '');
  // 공용 BLOCKED_TEXT 는 «%» 도 막아 «자외선 99% 차단» 같은 정상 옵션이 사라진다 — 옵션 이름은 금액 꼴(OPTION_MONEY)·금지어(할인 포함)로 따로 본다(Codex #687 잔여).
  if (OPTION_BLOCKED_WORDS.test(text) || BLOCKED_PUBLIC_VALUE.test(text) || CONTROL_OR_PRIVATE.test(text)) return null;
  // 개인정보 낱말·금지어는 «공백·기호를 지운 꼴»에서도 본다(고 객 홍길동·수 수 료, Codex #687 ②).
  if (OPTION_PHONE.test(text) || OPTION_MONEY.test(text) || OPTION_PERSONAL_WORDS.test(text) || OPTION_PERSONAL_WORDS.test(compact) || OPTION_FORBIDDEN_COMPACT.test(compact)) return null;
  // 차량번호 꼴은 구분기호(공백·하이픈·점·가운뎃점·밑줄)를 지운 꼴에서도 본다(«12가-3456», Codex #692 (a)).
  const plateCompact = text.replace(/[^0-9가-힣]+/gu, '');   // 숫자·한글만 남긴다(구분기호·슬래시·괄호 전부 — Codex #692 ①)
  if (/\d{2,3}\s?[가-힣]\s?\d{4}/.test(text) || /\d{2,3}[가-힣]\d{4}/.test(plateCompact) || /\d{7,}/.test(compact)) return null;
  return text;
};
const RAW_NAME_MAX = 120;
// 원문 차명에 섞인 사람 이름 꼴(Codex #692 (b)): 성씨 + 두 글자로 된 «세 글자 한글 낱말»은 인명일 수 있어 원문 표기를 내보내지 않는다(null — 소비처는 «차량 정보 확인 중»).
// 차명 낱말과 겹치는 흔한 세 글자 낱말은 허용 목록으로 둔다. 과차단은 안전한 쪽(원문 숨김)이다.
const PERSON_SURNAMES = '김이박최정강조윤장임한오서신권황안송류홍전고문양손배백허유남심노하곽성차주우구민나진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예경봉사부황';
const PERSON_NAME_ALLOW = new Set(['임팔라', '한정판', '신형차', '신차급', '정통파', '오토캠', '고급형', '전기차', '주행거리', '전용차', '장기차', '유니크', '모하비', '소렌토', '소나타', '마티즈', '마스터', '마이티', '마칸', '고스트', '우라칸', '도요타', '마즈다', '마쯔다', '유콘', '선루프', '박스카', '진주색', '연두색', '주황색', '하늘색', '고동색', '구형', '서비스',
  // 두 글자 낱말(성씨와 겹치는 흔한 차명·등급·색 낱말) — 두 글자 이름 꼴(«김철»)도 막기 위해 허용 목록으로만 예외를 둔다(Codex #692 ②).
  '현대', '기아', '한국', '신형', '신차', '전기', '전륜', '후륜', '고급', '주행', '오토', '하이', '모던', '소형', '한정', '장기', '단기', '특별', '정품', '수입', '국산',
  '구동', '연료', '모닝', '소울', '마크', '백색', '은색', '남색', '금색', '황색', '흑색', '회색', '갈색', '적색', '청색', '검정', '주황', '진주', '하늘', '전체', '선택',
  '차단', '차량', '주차', '정비', '보증', '운전', '안전', '전방', '후방', '고속', '자동', '강화', '통풍', '열선', '성능', '연비', '유리', '도어', '주문', '오너', '신품', '구입']);
const HONORIFIC = '님|씨|고객님?|대표님?|사장님?|기사님?|과장님?|부장님?|팀장님?|선생님?|사모님?|양|군';
const HONORIFIC_TOKEN = new RegExp(`^(?:${HONORIFIC})$`);
const NAME_WITH_HONORIFIC = new RegExp(`^([가-힣]{2,3}?)(?:${HONORIFIC})$`);
const isSurnameName = (token: string, lengths: number[]): boolean =>
  lengths.includes(token.length) && /^[가-힣]+$/.test(token) && PERSON_SURNAMES.includes(token.charAt(0)) && !PERSON_NAME_ALLOW.has(token);
/** 인명 꼴(Codex #692 ②): 성씨로 시작하는 두·세 글자 한글 낱말은 허용 목록에 없으면 이름으로 보고 제외한다(과차단은 안전한 쪽).
 * 호칭(님·씨·고객 등)이 붙은 이름·괄호 안 한글 이름 꼴도 제외. */
const looksLikePersonName = (text: string): boolean => {
  const tokens = text.split(/\s+/).map(token => token.replace(/^[(\[{<"'‘“]+|[)\]}>"'’”,.:;]+$/g, ''));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isSurnameName(token, [2, 3])) return true;
    const withTitle = NAME_WITH_HONORIFIC.exec(token);
    if (withTitle && isSurnameName(withTitle[1]!, [2, 3])) return true;
    if (HONORIFIC_TOKEN.test(token) && i > 0 && isSurnameName(tokens[i - 1]!, [2, 3])) return true;
  }
  for (const m of text.matchAll(/[(\[{<]\s*([가-힣]{2,4})\s*[)\]}>]/g)) if (isSurnameName(m[1]!, [2, 3, 4])) return true;
  return false;
};
const refineText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
/** 공급사 원문 표기(표시용 읽기 전용 파생): 문서 car_name → 없으면 원문.차명. 밑줄 구분을 공백으로, 보이지 않는 문자·연속 공백 정리, 120자 상한.
 * 옵션 이름과 같은 안전 필터(전화·번호·금액 꼴·개인정보·금지어)에 걸리면 null. 문서·원문은 바꾸지 않는다. */
export const sourceRawName = (product: Rec): string | null => {
  const original = product['원문'] && typeof product['원문'] === 'object' ? product['원문'] as Rec : {};
  const raw = refineText(product.car_name) || refineText(original['차명']);
  if (!raw) return null;
  let text = raw.replace(INVISIBLE, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > RAW_NAME_MAX) text = `${text.slice(0, RAW_NAME_MAX - 1)}…`;
  // 공급사 시트에 제조사 열이 있으나 차명에는 빠지는 경우(아이카): 원문 보존 칸의 source_maker 가 있으면 읽기 전용 접두로만 붙인다.
  const source = (product.raw && typeof product.raw === 'object' ? product.raw : original['source'] && typeof original['source'] === 'object' ? original['source'] : {}) as Rec;
  // 제조사: 손오공 raw.source_maker, 아이카 시트 원본 칸(raw.original['제조사'] 또는 headers/cells 의 «제조사» 열). 문서에 값을 새로 쓰지 않는다.
  const headers = Array.isArray(source.headers) ? source.headers : [], cells = Array.isArray(source.cells) ? source.cells : [];
  const headerAt = headers.findIndex(h => typeof h === 'string' && h.trim() === '제조사');
  const originalRow = source.original && typeof source.original === 'object' ? source.original as Rec : {};
  const maker = refineText(source.source_maker) || refineText(originalRow['제조사']) || (headerAt >= 0 ? refineText(cells[headerAt]) : '');
  if (maker && maker.length <= 20 && !text.replace(/\s+/g, '').startsWith(maker.replace(/\s+/g, ''))) text = `${maker} ${text}`;
  if (looksLikePersonName(text)) return null;
  return safeOptionName(text, RAW_NAME_MAX + 16);
};
/** 정제 상태(커맨드 센터·B3Q 집계 반영): «실제 값» 기준이다 — 제조사·모델·세부모델 중 빈 칸, 세부모델에 밑줄(«원문 형태»),
 * 엔진 임시 표식이 있고 세부모델이 원문 차명 그대로인 문서(표식만 남은 정제 완료 문서는 REFINED)는 PENDING. «확인 중» 은 저장된 문자열이 아니라
 * 소비처가 네 칸이 비었을 때 보여 주는 값이므로 문자열 매칭하지 않는다. 문서 값만 본다(마스터 재대조 없음). */
export const refineState = (product: Rec): Required<Pick<PublicProduct, 'refine_state' | 'refine_missing'>> => {
  const missing = (['maker', 'model', 'sub_model'] as const).filter(field => !refineText(product[field]));
  const squash = (value: string): string => value.normalize('NFKC').replace(/[\s_]+/g, '').toLowerCase();
  const sub = refineText(product.sub_model);
  const original = product['원문'] && typeof product['원문'] === 'object' ? product['원문'] as Rec : {};
  const rawText = refineText(product.car_name) || refineText(original['차명']);
  const markerEquals = (product.vehicle_title_source === 'RAW_VEHICLE_TEXT' || product.vehicle_review_required === true) && !!sub && !!rawText && squash(sub) === squash(rawText);
  const rawShape = sub.includes('_');
  return { refine_state: missing.length > 0 || rawShape || markerEquals ? 'PENDING' : 'REFINED', refine_missing: [...missing] };
};
export const publicOptions = (product: Rec, allowPercent = true): Pick<PublicProduct, 'option_state' | 'option_basic' | 'option_paid'> => {
  const state = product.api_options_state;
  if (state !== 'PRESENT' && state !== 'NONE') return { option_state: 'UNKNOWN', option_basic: [], option_paid: [] };
  const seen = new Set<string>();
  const basic: string[] = [];
  for (const item of Array.isArray(product.api_options_basic) ? product.api_options_basic : []) {
    const name = safeOptionName(item && typeof item === 'object' ? (item as Rec).name : null, OPTION_NAME_MAX, allowPercent);
    if (name && !seen.has(name) && basic.length < OPTION_LIST_MAX) { seen.add(name); basic.push(name); }
  }
  const paid: Array<{ name: string; amount_krw: number | null }> = [];
  const paidSeen = new Set<string>();
  for (const item of Array.isArray(product.api_options_paid) ? product.api_options_paid : []) {
    const rec = item && typeof item === 'object' ? item as Rec : {};
    const name = safeOptionName(rec.name, OPTION_NAME_MAX, allowPercent);
    if (!name || paidSeen.has(name) || paid.length >= OPTION_LIST_MAX) continue;
    paidSeen.add(name);
    const amount = rec.amount_state === 'KNOWN' && typeof rec.amount_krw === 'number' && Number.isSafeInteger(rec.amount_krw) && rec.amount_krw > 0 ? rec.amount_krw : null;
    paid.push({ name, amount_krw: amount });
  }
  return { option_state: state, option_basic: basic, option_paid: paid };
};

const cleanText = (value: unknown, maxLength: number, field: string): string | null => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error(`PUBLIC_FIELD_INVALID:${field}`);
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > maxLength || BLOCKED_TEXT.test(text) || BLOCKED_PUBLIC_VALUE.test(text) || CONTROL_OR_PRIVATE.test(text)) {
    throw new Error(`PUBLIC_FIELD_FORBIDDEN:${field}`);
  }
  return text;
};

const cleanKey = (value: unknown): string => {
  const key = cleanText(value, 80, 'publicProductKey');
  if (!key || !PUBLIC_KEY.test(key) || key.startsWith('va_')) throw new Error('PUBLIC_KEY_INVALID');
  return key;
};

const cleanNumber = (value: unknown, field: string): number | null => {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`PUBLIC_NUMBER_INVALID:${field}`);
  return Math.round(value * 10) / 10;
};

const cleanBoolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;

const cleanUrl = (value: unknown): string | null => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('PUBLIC_URL_INVALID');
  const text = value.trim();
  if (!/^https:\/\/[^\s]{1,492}$/.test(text)) throw new Error('PUBLIC_URL_INVALID');
  if (BLOCKED_PUBLIC_VALUE.test(text)) throw new Error('PUBLIC_URL_FORBIDDEN');
  return text;
};

const normalizeProductType = (value: unknown): PublicProduct['product_type'] => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (['NEW_SUBSCRIPTION', 'USED_SUBSCRIPTION', 'RENTAL', 'LEASE'].includes(text)) return text as PublicProduct['product_type'];
  if (text.includes('신차') || text.includes('픽업')) return 'NEW_SUBSCRIPTION';
  if (text.includes('중고')) return 'USED_SUBSCRIPTION';
  if (text.includes('렌트')) return 'RENTAL';
  if (text.includes('리스')) return 'LEASE';
  return text ? 'UNKNOWN_PUBLIC_TYPE' : null;
};

const normalizeVehicleStatus = (value: unknown): PublicProduct['vehicle_status'] => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (['AVAILABLE', 'CONSULT_REQUIRED', 'CONTRACTING', 'UNAVAILABLE', 'UNKNOWN'].includes(text)) return text as PublicProduct['vehicle_status'];
  if (['가용', '출고가능', '가능'].includes(text)) return 'AVAILABLE';
  if (['선점', '계약중'].includes(text)) return 'CONTRACTING';
  if (['출고협의', '협의'].includes(text)) return 'CONSULT_REQUIRED';
  if (['출고불가', '불가'].includes(text)) return 'UNAVAILABLE';
  return text ? 'UNKNOWN' : null;
};

const normalizeDepositState = (value: unknown): PublicDepositState => {
  if (value === 'AMOUNT' || value === 'KNOWN') return 'KNOWN';
  if (value === 'VERIFIED_NO_DEPOSIT' || value === 'ZERO') return 'ZERO';
  if (value === 'NOT_APPLICABLE') return 'NOT_APPLICABLE';
  return 'UNKNOWN';
};

const cleanImages = (product: Rec): string[] => {
  const raw = [
    ...(Array.isArray(product.image_urls) ? product.image_urls : []),
    ...(Array.isArray(product.images) ? product.images : []),
    ...(Array.isArray(product.photos) ? product.photos : []),
    ...(Array.isArray(product.photo_cache) ? product.photo_cache : []),
    // 실제 저장 모양은 {src, urls:[...]} 맵이다(드라이브 썸네일). 배열만 보면 이 사진들이 목록에서 빠진다.
    ...(product.photo_cache && typeof product.photo_cache === 'object' && !Array.isArray(product.photo_cache)
      && Array.isArray((product.photo_cache as Rec).urls) ? (product.photo_cache as Rec).urls as unknown[] : []),
    product.image_url,
    product.photo_link,
  ];
  const urls: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!/^https:\/\/[^\s]{1,492}$/.test(text)) continue;
    if (BLOCKED_PUBLIC_VALUE.test(text)) throw new Error('PUBLIC_URL_FORBIDDEN');
    if (!urls.includes(text)) urls.push(text);
    if (urls.length > 200) throw new Error('PUBLIC_IMAGES_LIMIT');
  }
  return urls;
};

const publicPrice = (product: Rec): PublicProduct['price'] => {
  if (!product.price || typeof product.price !== 'object' || Array.isArray(product.price)) return {};
  const result: PublicProduct['price'] = {};
  for (const [key, value] of Object.entries(product.price as Rec)) {
    if (!PRICE_KEY.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Rec;
    const rent = cleanNumber(row.rent, `price.${key}.rent`);
    const depositState = normalizeDepositState(row.depositState);
    const deposit = cleanNumber(row.deposit, `price.${key}.deposit`);
    result[key] = {
      rent,
      deposit: depositState === 'ZERO' ? 0 : depositState === 'KNOWN' ? deposit : null,
      depositState,
    };
  }
  return result;
};

const publicPolicy = (policy: Rec | undefined): PublicPolicy | null => {
  if (!policy) return null;
  const result: PublicPolicy = {};
  for (const field of PUBLIC_POLICY_ENUM_FIELDS) {
    result[field] = cleanText(policy[field], 80, `_policy.${field}`);
  }
  for (const field of PUBLIC_POLICY_BOOLEAN_FIELDS) {
    result[field] = cleanBoolean(policy[field]);
  }
  for (const field of PUBLIC_POLICY_NUMBER_FIELDS) {
    result[field] = cleanNumber(policy[field], `_policy.${field}`);
  }
  return result;
};

const channelMatches = (product: Rec, wl: string | undefined): boolean => {
  if (!wl) return true;
  const normalized = wl.toLowerCase();
  const candidates = [product.wl, product.whitelabel, product.channel, product.public_channel];
  const arrays = [product.wls, product.whitelabels, product.channels, product.public_channels];
  if (candidates.some((value) => typeof value === 'string' && value.toLowerCase() === normalized)) return true;
  if (arrays.some((value) => Array.isArray(value) && value.some((item) => typeof item === 'string' && item.toLowerCase() === normalized))) return true;
  return !candidates.some(Boolean) && !arrays.some((value) => Array.isArray(value) && value.length);
};

const providerMatches = (product: Rec, provider: string | undefined): boolean => {
  if (!provider) return true;
  return [product.provider_company_code, product.partner_code].some((value) => typeof value === 'string' && value === provider);
};

const buildPublicProduct = (product: Rec, policies: Record<string, Rec>, listMode: boolean): PublicProduct => {
  const key = cleanKey(product.publicProductKey ?? product.product_code ?? product._key);
  const policyId = typeof product.policy_id === 'string' ? product.policy_id : typeof product.policy_code === 'string' ? product.policy_code : undefined;
  const images = cleanImages(product);
  const result: PublicProduct = {
    publicProductKey: key,
    _key: cleanKey(product._key ?? key),
    product_code: cleanKey(product.product_code ?? key),
    car_number: null,
    maker: null,
    model: null,
    sub_model: null,
    trim_name: null,
    trim_extra: null,
    variant: null,
    vehicle_class: null,
    fuel_type: null,
    engine_type: null,
    drive_type: null,
    transmission: null,
    usage: null,
    ext_color: null,
    int_color: null,
    accident_history: null,
    cert_car_name: null,
    location: null,
    provider_name: null,
    year: null,
    engine_cc: null,
    seats: null,
    mileage: null,
    battery_capacity: null,
    annual_mileage: null,
    first_registration_date: null,
    note: null,
    options: null,
    deposit_note: null,
    product_type: normalizeProductType(product.product_type),
    vehicle_status: normalizeVehicleStatus(product.vehicle_status ?? product.status_kind),
    insurance_included: cleanBoolean(product.insurance_included),
    price: publicPrice(product),
    image_url: images[0] ?? null,
    image_urls: listMode ? [] : images,
    photo_link: cleanUrl(product.photo_link),
    // 공급사 공통(허용표 FREEPASS_DATA_PHOTO_COPY_SUPPLIERS, 기본 이안카): 서빙 reader 와 같은 허용표를 써서 «세어 놓고 못 서빙하는» 일이 없다.
    photo_approved_count: approvedPhotoCount(product, parsePhotoCopySuppliers(process.env.FREEPASS_DATA_PHOTO_COPY_SUPPLIERS)),
    _policy: publicPolicy(policyId ? policies[policyId] : undefined),
  };
  for (const field of PUBLIC_TEXT_FIELDS) {
    result[field] = cleanText(product[field], 80, field);
  }
  for (const field of PUBLIC_LONG_TEXT_FIELDS) {
    result[field] = cleanText(product[field], 300, field);
  }
  for (const field of PUBLIC_NUMBER_FIELDS) {
    result[field] = cleanNumber(product[field], field);
  }
  const registration = cleanText(product.first_registration_date, 10, 'first_registration_date');
  result.first_registration_date = registration && DATE.test(registration) ? registration : null;
  const sourceRawOn = process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW === '1';
  if (process.env.FREEPASS_DATA_PUBLIC_OPTIONS === '1' && !listMode) Object.assign(result, publicOptions(product, sourceRawOn));
  if (sourceRawOn) Object.assign(result, { source_raw_name: sourceRawName(product), ...refineState(product) });
  // 옵션·원문 표기는 자기 안전 필터(safeOptionName)로 이미 거른다 — 공용 BLOCKED_TEXT 는 «%» 도 막아 «자외선 99% 차단» 같은 정상 값 하나로 피드 전체를 던지게 하므로 여기서는 뺀다.
  // 원문 표기 플래그가 켜진 응답에서만 옵션·원문 표기를 공용 검사에서 뺀다(자체 필터로 이미 거름). 꺼져 있으면 옵션 검증은 종전과 같다.
  if (sourceRawOn) {
    const { option_basic: _ob, option_paid: _op, source_raw_name: _sr, ...checked } = result;
    assertNoForbiddenValue(checked);
  } else assertNoForbiddenValue(result);
  return result;
};

const assertNoForbiddenValue = (value: unknown): void => {
  if (typeof value === 'string') {
    if (BLOCKED_TEXT.test(value) || BLOCKED_PUBLIC_VALUE.test(value)) throw new Error('PUBLIC_FORBIDDEN_TEXT');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenValue(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Rec)) {
      if (/vin|fee|commission|payout|billing|margin|source|sheet|raw|provenance|audit|collection/i.test(key)) {
        throw new Error(`PUBLIC_FORBIDDEN_FIELD:${key}`);
      }
      assertNoForbiddenValue(item);
    }
  }
};

const productsFromSnapshot = (snapshot: CatalogCompatibilitySnapshot, query: PublicProductFeedQuery, listMode: boolean): PublicProduct[] =>
  Object.values(snapshot.data.products)
    .filter((product) => product.listable !== false && providerMatches(product, query.p) && channelMatches(product, query.wl))
    .map((product) => buildPublicProduct(product, snapshot.data.policies, listMode));

export const publicConsumerIdFromWhitelabel = (wl: unknown): string => {
  if (typeof wl !== 'string' || !wl.trim()) return 'erp-com';
  const key = wl.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) throw new Error('PUBLIC_WL_INVALID');
  return `whitelabel-${key}`;
};

export const buildPublicProductFeed = (snapshot: CatalogCompatibilitySnapshot, query: PublicProductFeedQuery): PublicProductFeed => {
  const products = productsFromSnapshot(snapshot, query, true);
  const names = [...new Set(products.map((item) => item.provider_name).filter((name): name is string => !!name))];
  const brand = query.p && names.length === 1 ? names[0]! : '';
  return { contractVersion: '1.0', count: products.length, products, brand };
};

// ERP4 product-share compatibility: whole key, FNV-1a token, then final-hyphen fallback.
export const publicProductShareToken = (raw: string): string => {
  const value = raw.trim();
  if (!value) return '';
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  let token = '';
  for (let i = 0; i < 10; i++) {
    token = alphabet[Number(hash % BigInt(alphabet.length))]! + token;
    hash /= BigInt(alphabet.length);
  }
  return token;
};

export const buildPublicProductQuote = (snapshot: CatalogCompatibilitySnapshot, code: unknown, query: PublicProductFeedQuery): PublicProductQuote | null => {
  const target = cleanText(code, 120, 'code');
  if (!target) throw new Error('PUBLIC_QUOTE_CODE_REQUIRED');
  const products = productsFromSnapshot(snapshot, query, false);
  const find = (segment: string): PublicProduct | null | undefined => {
    const candidates = segment.startsWith('veh_') ? [segment] : [segment, `veh_${segment}`];
    const publicKeys = products.filter((item) => item.publicProductKey === segment);
    if (publicKeys.length) return publicKeys.length === 1 ? publicKeys[0] : null;
    const aliases = products.filter((item) => candidates.includes(item.publicProductKey) || candidates.includes(item.product_code) || candidates.includes(item._key));
    if (aliases.length) return aliases.length === 1 ? aliases[0] : null;
    if (!/^[2-9a-z]{10}$/.test(segment)) return undefined;
    const matches = products.filter((item) => publicProductShareToken(item.product_code || item._key) === segment || publicProductShareToken(item._key) === segment);
    return matches.length > 1 ? null : matches[0];
  };
  const split = target.lastIndexOf('-');
  const whole = find(target);
  const product = whole === undefined && split > 0 && split < target.length - 1 ? find(target.slice(0, split)) : whole;
  return product ? { product } : null;
};

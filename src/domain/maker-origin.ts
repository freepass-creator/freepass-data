/** 제조사 원산지 구분(대표 2026-10-16 «원산지도 있어야 한다»): 국산 | 수입 | null(확인 필요). 읽기 전용 파생값 — 문서에 쓰지 않는다.
 * 표기는 제조사 정본 표기(vehicle-maker-name: 도요타·쉐보레·르노·KGM)와 별칭을 따른다. 표에 없는 제조사는 추정하지 않고 null.
 * 한계: 제조사 단위 파생이다. 국내/수입이 섞인 제조사의 알려진 혼재 모델은 확정하지 않고 null로 남긴다. */
import { canonicalVehicleMakerName } from './vehicle-maker-name.js';

export type VehicleOrigin = '국산' | '수입';

const DOMESTIC = ['현대', '기아', '제네시스', 'KGM', '르노', '쉐보레', '대우'];
const IMPORTED = ['BMW', '벤츠', '아우디', '폭스바겐', '볼보', '도요타', '렉서스', '혼다', '닛산', '포드', '링컨', '지프', '미니', '푸조', '테슬라', '포르쉐', '랜드로버',
  '재규어', 'BYD', '폴스타', '캐딜락', '마세라티', '페라리', '람보르기니', '벤틀리', '롤스로이스', '인피니티', '크라이슬러', '시트로엥', '스바루', '마쯔다', '닷지', '로터스',
  '맥라렌', '애스턴마틴', '이네오스', '스마트', '푸조시트로엥', '알파로메오', '피아트', '쿠프라', '미쓰비시', '스즈키'];
/** 엔카 표기와 다른 흔한 별칭(정본 표기로 모은다). */
const EXTRA_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  메르세데스벤츠: '벤츠', '메르세데스-벤츠': '벤츠', 벤츠: '벤츠', 메르세데스: '벤츠', MERCEDESBENZ: '벤츠', 비엠더블유: 'BMW', 폭스바겐: '폭스바겐', 폭스바겐코리아: '폭스바겐',
  마즈다: '마쯔다', 한국GM: '쉐보레', 지엠대우: '쉐보레', 제네시스: '제네시스', 랜드로바: '랜드로버',
});
const key = (v: string): string => v.normalize('NFKC').replace(/[\s·()-]+/g, '').toUpperCase();
const TABLE = new Map<string, VehicleOrigin>();
for (const name of DOMESTIC) TABLE.set(key(name), '국산');
for (const name of IMPORTED) TABLE.set(key(name), '수입');

// Safety exclusions only: these names never establish a vehicle's country or an imported classification.
const MIXED_MODELS: Record<string, readonly string[]> = {
  쉐보레: ['볼트EV','볼트EUV','트래버스','타호','콜로라도','이쿼녹스','블레이저','카마로','임팔라'],
  르노: ['마스터','조에','캡처','QM3','클리오'],
};
export function originOfMaker(maker: unknown, model?: unknown): VehicleOrigin | null {
  if (typeof maker !== 'string' || !maker.trim()) return null;
  const canonical = canonicalVehicleMakerName(maker);
  const aliased = EXTRA_ALIASES[key(maker)] ?? Object.entries(EXTRA_ALIASES).find(([from]) => key(from) === key(maker))?.[1];
  const resolved = TABLE.has(key(canonical)) ? canonical : aliased;
  if (!resolved) return null;
  const mixed = MIXED_MODELS[resolved];
  if (mixed && (typeof model !== 'string' || !model.trim() || mixed.some(name => key(model).includes(key(name))))) return null;
  return TABLE.get(key(resolved)) ?? null;
}

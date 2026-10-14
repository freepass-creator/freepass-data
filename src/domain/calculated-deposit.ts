/** 보증금 계산값(커맨드 센터 2026-10-14 확정): 원천이 보증금을 주지 않을 때 «국산 월 대여료 × 2 · 수입 × 3» 을 계산값으로 채우고 deposit_source=CALCULATED 로 표시한다.
 * 원천 값이 오면 원천이 이긴다(교체). 제조사를 알 수 없으면 계산하지 않는다(추정 금지). */
const DOMESTIC = new Set(['현대', '기아', '제네시스', '쉐보레', '한국GM', 'GM대우', '대우', '르노코리아', '르노삼성', '르노', 'KGM', '쌍용', 'KG모빌리티', '케이지엠']);
const IMPORT = new Set(['벤츠', '메르세데스벤츠', '메르세데스', 'BMW', '아우디', '폭스바겐', '볼보', '테슬라', '토요타', '도요타', '렉서스', '혼다', '닛산', '인피니티',
  '포르쉐', '미니', 'MINI', '랜드로버', '재규어', '지프', '크라이슬러', '포드', '링컨', '캐딜락', '푸조', '시트로엥', '마세라티', '페라리', '람보르기니',
  '벤틀리', '롤스로이스', '폴스타', '스바루', '마쯔다', '마즈다', 'BYD', '비야디', '로터스', '맥라렌', '애스턴마틴', '혼다코리아']);
const key = (v: string) => v.normalize('NFKC').replace(/[\s\-_.·]/g, '').toUpperCase();
const domesticKeys = new Set([...DOMESTIC].map(key)), importKeys = new Set([...IMPORT].map(key));

export type MakerOrigin = 'DOMESTIC' | 'IMPORT';
export function makerOrigin(maker: unknown): MakerOrigin | null {
  if (typeof maker !== 'string') return null;
  const k = key(maker);
  if (!k) return null;
  if (domesticKeys.has(k)) return 'DOMESTIC';
  if (importKeys.has(k)) return 'IMPORT';
  // «현대자동차»·«기아자동차» 같은 접미사 표기
  const trimmed = k.replace(/(자동차|코리아|모터스|모빌리티)$/u, '');
  if (trimmed !== k && trimmed) { if (domesticKeys.has(trimmed)) return 'DOMESTIC'; if (importKeys.has(trimmed)) return 'IMPORT'; }
  return null;
}

/** 월 대여료와 제조사 → 보증금 계산값(원). 대여료가 양의 정수가 아니거나 제조사를 모르면 null. */
export function calculatedDeposit(monthlyRent: unknown, maker: unknown): number | null {
  if (typeof monthlyRent !== 'number' || !Number.isSafeInteger(monthlyRent) || monthlyRent <= 0) return null;
  const origin = makerOrigin(maker);
  return origin === null ? null : monthlyRent * (origin === 'DOMESTIC' ? 2 : 3);
}

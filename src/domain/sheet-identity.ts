/** F05 공통시트의 «제조사·모델·세부모델·세부트림» 4칸(차종 기준 한 장대로 채워진 값)을 원천 기록에 «후보»로 싣는 순수 로직(대표 2026-10-22 승인).
 *  후보일 뿐 권위가 아니다: 차종 마스터 행과 «정확히» 일치하고 원문과 모순되지 않을 때만 정제기가 쓴다(domain/identity-promotion-plan matchSheetIdentity). */
export type SheetIdentity = { maker: string; model: string; sub_model: string; trim_name: string };
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').normalize('NFKC').replace(/\s+/g, ' ').trim();
/** 헤더 이름으로 4칸을 읽는다. 제조사·모델·세부모델 중 하나라도 비면 후보 없음(undefined). 세부트림은 비어도 된다. */
export function sheetIdentityOf(headers: readonly unknown[] | undefined, cells: readonly unknown[] | undefined): SheetIdentity | undefined {
  if (!Array.isArray(headers) || !Array.isArray(cells)) return undefined;
  const at = (name: string) => text(cells[headers.findIndex(h => text(h) === name)]);
  const id = { maker: at('제조사'), model: at('모델'), sub_model: at('세부모델'), trim_name: at('세부트림') };
  return id.maker && id.model && id.sub_model ? id : undefined;
}
/** 저장된/전달된 raw.sheet_identity 를 검증해 되돌린다(모양이 틀리면 undefined). */
export function validSheetIdentity(v: unknown): SheetIdentity | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const id = { maker: text(o.maker), model: text(o.model), sub_model: text(o.sub_model), trim_name: text(o.trim_name) };
  return id.maker && id.model && id.sub_model ? id : undefined;
}

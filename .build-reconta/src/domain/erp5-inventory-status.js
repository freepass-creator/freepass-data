/** Reviewed ERP5 `vehicle_status` values and the `status_kind` each one implies. */
export const ERP5_INVENTORY_STATUS_KINDS = Object.freeze({
    즉시출고: '가용',
    출고가능: '가용',
    출고협의: '협의',
    상품화중: '준비',
    차량검수: '준비',
    계약중: '선점',
    출고불가: '불가',
});
/** 원천의 «계약중» 계열 표기(대표 2026-10-14 «계약중이라고 되어 있는 거는 연동해서 계약중으로, 출고불가만 안 올린다»).
 * 이 값들은 모든 원천에서 원문을 «계약중» 으로 통일해 노출(선점)한다. 공급사 표기는 raw.provider_status 에 남긴다.
 * 뜻이 갈리는 표기(출고대기 등)는 넣지 않는다 — 모르는 값은 계속 보류(STATUS_UNKNOWN). */
export const CONTRACTED_STATUS_SYNONYMS = new Set(['계약중', '계약진행', '계약진행중', '계약대기', '상담중', '예약', '예약중', '선점', 'RESERVED']);
export const isContractedStatus = (value) => typeof value === 'string' && CONTRACTED_STATUS_SYNONYMS.has(value.trim());
/** Only `출고불가` closes a product; it is a status change, never a deletion. */
export const ERP5_UNAVAILABLE_STATUS = '출고불가';
export function resolveErp5InventoryStatus(value) {
    if (typeof value !== 'string' || !Object.hasOwn(ERP5_INVENTORY_STATUS_KINDS, value))
        return { known: false };
    const status = value;
    return { known: true, status, statusKind: ERP5_INVENTORY_STATUS_KINDS[status], listable: status !== ERP5_UNAVAILABLE_STATUS };
}
/** 공급사 입력 시트가 쓰는 검토된 배차상태 표기. 판매 가능으로 읽고 status_kind 는 «가용» 이다(대표 규칙: 출고불가만 명시 정지).
 * 이 목록에 없는 새 값은 판매 가능으로 추정하지 않고 보류한다(fail-closed). */
export const PROVIDER_AVAILABLE_STATUS_LABELS = new Set(['배차중', '배차가능']);

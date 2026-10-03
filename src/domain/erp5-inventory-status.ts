/** Reviewed ERP5 `vehicle_status` values and the `status_kind` each one implies. */
export const ERP5_INVENTORY_STATUS_KINDS = Object.freeze({
  즉시출고: '가용',
  출고가능: '가용',
  출고협의: '협의',
  상품화중: '준비',
  차량검수: '준비',
  계약중: '선점',
  출고불가: '불가',
} as const);

export type Erp5InventoryStatus = keyof typeof ERP5_INVENTORY_STATUS_KINDS;
export type Erp5InventoryStatusKind = (typeof ERP5_INVENTORY_STATUS_KINDS)[Erp5InventoryStatus];

/** Only `출고불가` closes a product; it is a status change, never a deletion. */
export const ERP5_UNAVAILABLE_STATUS: Erp5InventoryStatus = '출고불가';

export type Erp5InventoryStatusResolution =
  | { known: true; status: Erp5InventoryStatus; statusKind: Erp5InventoryStatusKind; listable: boolean }
  | { known: false };

export function resolveErp5InventoryStatus(value: unknown): Erp5InventoryStatusResolution {
  if (typeof value !== 'string' || !Object.hasOwn(ERP5_INVENTORY_STATUS_KINDS, value)) return { known: false };
  const status = value as Erp5InventoryStatus;
  return { known: true, status, statusKind: ERP5_INVENTORY_STATUS_KINDS[status], listable: status !== ERP5_UNAVAILABLE_STATUS };
}

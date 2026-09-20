# Legacy Catalog Source Map — confirmed 2026-09-20

Source repository: freepass-creator/freepasserp4  
Firebase binding: freepasserp3

## Confirmed Firestore source

Collection: products

The current ERP4 finder subscribes to Firestore products.

Legacy document identity is not adopted as the new Canonical identity. Existing code comments indicate that the legacy document key can be vehicle-number-oriented; FreePass Data stores it as sourceRecordId.

## Confirmed legacy product facts

Representative fields include:

- product_code
- car_number
- maker
- model
- sub_model
- trim_name
- vehicle_class
- year
- fuel_type
- mileage
- drive_type
- seats
- origin
- provider_company_code
- policy_code
- vehicle_status
- product_type
- image_urls / photos
- supplier_vehicle_name / supplier_options

Private/internal legacy facts include:

- vehicle_price
- vin
- account_number
- price fee / commission / fee_memo

Public Projection must never expose private/internal facts by default.

## Legacy product type vocabulary

Confirmed values:

- 신차렌트
- 중고렌트
- 신차구독
- 중고구독
- 픽업구독

FreePass Data maps these to commercialType and does not collapse 픽업구독 into 중고구독.

## Legacy price structure

Confirmed comment contract:

price = { "24" | "24_3만": { rent, deposit, fee | commission, fee_memo } }

Therefore a PriceTerm is not uniquely identified by termMonths alone.

Catalog V1 uses a stable termKey plus normalized termMonths/mileage fields.

Example:

- source price key: 24_3만
- termKey: source:24_3만
- termMonths: 24
- mileageLimitKmPerYear: 30000

The exact normalization rule will be finalized from live samples before writer cutover.

## RTDB

ERP4 still contains RTDB compatibility code. Target architecture treats RTDB as migration debt, not a new writer/source contract.

No new FreePass Data code may create a production RTDB writer.

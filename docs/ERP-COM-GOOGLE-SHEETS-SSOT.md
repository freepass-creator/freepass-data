# ERP.com · Google Sheets SSOT Operating Map

Status: **ACTIVE / CONTROL-PLANE BASELINE**  
Date: **2026-09-21 KST**  
Official owner: **프리패스 데이터 / FreePass Data**

## 1. Authority order

The operational authority order is:

```
Source
  -> immutable RAW
  -> Normalized Candidate
  -> Canonical SSOT
  -> validated Projection Release
  -> ERP.com / Google Sheets / other consumers
```

Google Sheets and ERP.com are not allowed to silently become a second Canonical SSOT.

## 2. Current Google Sheets

### F01 — 프리패스 상품리스트

Spreadsheet ID: `1Y1Mx1EcEpAuNer0y50Dq4eK92CpVjThO_suZLmo2vVs`

Current visible snapshots verified on 2026-09-21:

- `상품리스트 09.19 23`
- `픽업구독 09.19 23`
- `오플구독 09.19 23`
- `오공구독 09.19 23`

Role:

- operational/export projection
- human-readable shared view
- supplier-specific period/deposit/rate semantics must be preserved
- not Canonical write authority

A visible `SSOT 운영기준` tab records this boundary and the observed freshness.

### F03 — 차종마스터 신규

Spreadsheet ID: `1oMB9eoNnQFxUyRK4CSxYh_hKrtCf7s_79xLs-GYwXCE`

Current working tabs:

- `차종마스터`
- `제원마스터`
- `전기차배터리마스터`
- `시트 규격`

Role:

- reviewed source/reference for vehicle hierarchy/spec facts
- model/submodel/trim row keys and atom IDs are lineage evidence
- direct live Canonical writes are prohibited

A visible `SSOT 운영기준` tab records this boundary.

The workbook named `[구버전·폐기 2026-09-26] 프리패스 차종마스터 원천대장` is not a new Canonical authority.

## 3. ERP.com current and target reads

Current production boundary observed in `freepasserp4`:

- public catalog reads ERP5 Firestore
- fallback to legacy RTDB is prohibited
- existing ERP5 public reader remains active until parity evidence exists

Target boundary:

```
ERP5 current read
  + FreePass Data erp-public projection shadow read
  -> compare
  -> PARITY_VERIFIED
  -> FreePass Data read cutover
```

Read cutover must not be combined with writer cutover.

## 4. Shadow parity minimum

ERP.com may move from ERP5 direct read to FreePass Data only after evidence covers at least:

- listable product count
- vehicle/product identity
- supplier/offer identity
- monthly rent by term
- deposit state and amount
- mileage limit
- listability/status
- freshness/release metadata
- missing/extra records

A mismatch must not silently fall back to a different source.

## 5. Freshness rule

A dated Sheet tab is evidence of the snapshot time, not proof that source data is current.

As of this baseline, F01's active visible tabs are labeled `09.19 23`. Therefore the sheet must be treated as a 2026-09-19 23h snapshot until a new projection refresh is verified.

FreePass Data releases expose release/revision/digest/generated/activated evidence. Consumers should prefer that evidence instead of inferring freshness from UI timestamps.

## 6. Write rule

Google Sheet edits do not directly overwrite Canonical data.

Preferred path:

```
source change
  -> immutable evidence
  -> review/canonicalization command
  -> expected revision / validation
  -> audit + lineage + receipt
  -> new projection release
  -> Sheet / ERP.com refresh
```

RTDB has no new authority. Existing RTDB traces are migration debt only.

## 7. Current action state

Completed in this work packet:

- F01 `SSOT 운영기준` tab added and verified.
- F03 `SSOT 운영기준` tab added and verified.
- current F01 snapshot age is explicitly recorded instead of being relabeled as fresh.
- ERP.com migration is constrained to Shadow Read first; existing production ERP5 reader is not cut over by this document.

Next operational evidence required:

1. production FreePass Data binding/IAM
2. real Catalog ingestion into FreePass Data
3. ERP.com shadow parity measurements
4. F01 projection regeneration from the same accepted release
5. only then, read cutover

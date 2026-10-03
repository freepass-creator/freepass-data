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

- 2026-10-03 대표 오더(「엔카와 똑같이 맞춰라」, 경영지원실 전달)로 1회 정정: `차종마스터` 미확정 53행 판정, 이름 수정 16행(더 뉴 카니발 YP→더 뉴 카니발 13, 볼트 Volt→볼트(Volt) 1, 포터 II→포터 Ⅱ 1, 셀토스 SP2 고유 트림 1행을 셀토스로), 셀토스 SP2 중복 3행 「통합→셀토스」 표시(행 보존), 8행 추가(S-클래스 W222·EQ900·캐딜락 XT6·A-클래스 W176·셀토스 2세대 4). 기록 위치: 각 행 `클로드 엔카대조` 칸(이전 값 `←` 표기), 정정 전 파일 사본 `1AQSLgMOPh1CVg0hZEOrl001zua_4_yYREkTcWERBPhg`(1차 반영 직후 사본 — 1차 이전 값은 각 행 칸에 남김). 평소에는 위 직접 쓰기 금지가 그대로다.
- 제조사 표시는 엔카 표기(도요타·쉐보레(GM대우)·르노코리아(삼성)·KG모빌리티(쌍용))로 바꾼다. 옛 이름은 `src/domain/vehicle-maker-name.ts` 별칭으로 계속 인식되며, F03 이름 변경은 이 별칭이 main에 들어간 뒤에 한다.

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

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
- 제조사 표시는 정본 표기(도요타·쉐보레·르노·KGM, 괄호 없음 — 대표 2026-10-04 최종)로 바꾼다. 옛 이름은 `src/domain/vehicle-maker-name.ts` 별칭으로 계속 인식되며, F03 이름 변경은 이 별칭이 main에 들어간 뒤에 한다.
- 2026-10-04 대표 승인으로 2차 반영: 백업 사본 `1Qeu3g-I5ZB_bH91QN4jwIZVjHByCb-j43bTF7dpzkZE` → 제조사 표시명 380행 엔카 표기로 변경 → 보류 2종 추가(올 뉴 카니발 럭셔리, 더 넥스트 스파크 LT) → `별칭` 탭 신설 → 되읽기(의도 밖 변경 0, 기존 행 불변 ID 그대로, 원자ID 1,678/1,678·중복 0). 이후 `별칭` 탭을 원문 근거 기준으로 다시 점검해 조건 없는 추정 1줄을 「확인 필요」로 내리고 11줄에 원문 연료·연식 조건을 붙였다.

#### F03 차종마스터 운영 규칙 (대표 결정 2026-10-03~04)

- **기준과 단계**: 엔카 공개 화면 표기를 그대로 쓴다. 단계는 엔카와 같은 4단계 `제조사 → 모델 → 세부모델 → 세부트림`(+생산시작·생산종료). 화물·특장은 엔카 화물·특장 메뉴 표기를 쓴다.
- **기아 예외**: 엔카가 세부모델에 `N세대`를 붙인 자리에만 기아 개발명을 쓴다(`K5 3세대` → `K5 DL3`). 엔카에 세대 표기가 없으면 엔카 이름 그대로(`더 뉴 카니발`, `올 뉴 카니발`). 개발명은 기아 공식 발표로 확인하고, 확인되지 않으면 엔카 표기를 쓰고 「개발명 확인 필요」로 표시한다(예: `셀토스 2세대`). 기아 외 제조사는 엔카 세대 표기 그대로(`RAV4 5세대`).
- **제조사 표시명**: 엔카 표기. 옛 이름은 Data 별칭(`vehicle-maker-name.ts`)과 F03 `별칭` 탭에 남긴다.
- **범위**: 우리 취급 차종만 둔다. 공급사·공동 시트에 F03에 없는 차가 나오면 그 차만 엔카 공개 화면에서 확인해 추가한다. 엔카 목록을 통째로 수집하지 않는다(`api.encar.com` robots.txt 전체 Disallow, www도 `/catalog/`·`/cars/` 금지). 공개 화면을 사람처럼 한 화면씩 간격을 두고 열람하며 로그인·접근 제한 우회는 하지 않는다.
- **불변 ID**: `모델행키`·`세부모델행키`·`세부트림행키`·`원자ID`는 이름이 바뀌어도 바꾸지 않는다. 신규 행만 계산한다 — `vmm_`=sha256(`원산지|제조사|모델`), `vms_`=sha256(`원산지|제조사|모델|세부모델`), `vmt_`=`vm_`=sha256(`원산지|제조사|모델|세부모델|세부트림`(빈칸은 `기본형`)), 각 hex 앞 24자(ERP4 `lib/domain/erp5-vehicle-master-ssot.ts` `stableEntryId`). 같은 모델에 행을 추가할 때는 그 모델 기존 행이 키를 만든 당시의 제조사 이름으로 계산해 `모델행키`가 기존과 일치하는지 확인한다(제조사 표시명 변경 전에 추가하거나, 기존 모델행키를 그대로 쓴다).
- **중복·폐지 행**: 행을 지우지 않는다. 같은 차종의 중복 행은 `클로드 엔카대조` 칸에 `통합→<세부모델>`로 표시해 보존하고, 공동 시트 드롭다운 등 소비처는 이 행을 목록에서 뺀다.
- **`별칭` 탭**: `구분 | 옛 이름(원본·이전 표기) | 모델 | F03 표시명 | F03 세부모델행키 | 조건 | 근거 | 등록`. 원문만으로 한 행에 특정될 때만 조건 없이 둔다. 같은 옛 이름이 둘 이상에 걸리면 원문의 연료·연식·최초등록·차명(쿠페·칸 등) 칸으로 가르는 조건을 적고, 원문으로도 특정되지 않으면 `F03 표시명`을 「확인 필요」로 두고 후보만 근거에 적는다(억지로 특정하지 않는다).
- **신규 행 추가 절차**: (1) 공급사·공동 시트 원문과 차량번호·최초등록일로 차종을 특정 (2) 엔카 공개 화면에서 세부모델·트림·연도 확인 (3) 파일 사본 백업 + 바꾸는 범위 전체 값 저장 (4) `A~G` 이름·기간, `I`(클로드 엔카대조)에 근거와 이전 값(`←`), `N~O` 검수 상태, `P~S` 불변 ID 기록 (5) 전체 되읽기로 의도 밖 변경 0·원자ID 중복 0 확인. 원문으로 특정되지 않는 차는 추가하지 않고 확인 동선(ai-ops `docs/확인-동선.md`)으로 공급사에 묻는다.
- **직접 쓰기 금지와 예외**: 위 「direct live Canonical writes are prohibited」는 평소 규칙이다. 대표가 명시적으로 승인한 정정만 예외로 하며, 예외는 이 절에 날짜·내용·백업 위치를 한 줄로 남긴다.
- **코드 별칭(2026-10-04 대표 지적 「쏘나타 DN8인데 세부모델 안 적었다」)**: `별칭` 탭 구분 `코드` 줄은 세대·개발 코드 토큰(DN8·CN7·NQ5·KA4·GL3·LX2·SP2·W222 등)으로 같은 제조사·모델 안의 F03 세부모델을 가리킨다. 출처는 F03 세부모델 이름 속 코드와, 이미 검토한 공급사 원본 정제명의 코드다. 코드가 한 세부모델에만 걸리면 조건 없이, 페이스리프트 전후·연료별로 여러 세부모델에 걸리면 `생산기간으로 가름`(F03 생산기간 vs 원문 연식·최초등록)과 `원문 연료` 조건을 적는다. 연료 조건은 세부모델 이름이 아니라 차종의 실제 연료로 적는다(예: 니로는 하이브리드 차종). 원문으로 가르지 못하면 채우지 않는다. 코드는 그 모델 안에서만 적용한다.

#### F03 검증 기록

- **2026-10-04 엔카 일치 독립 검증(모델·세부모델 단계)** — 표본: 씨앗값 `f03-encar-verify-20261004`, 제조사별 층 `max(4, round(150×제조사행수/1,678))`개를 `sha256(seed|원자ID)` 오름차순으로 + 그날 변경·추가 63행 전부 = 225행(세부모델 ID 121개). 증거: 엔카 공개 화면 검색 패널 「제조사/모델/등급」 원문(모델 그룹 82개, 한 화면씩 약 7초 간격, 로그인·API 직접 호출 없음, 관측 시각 2026-10-03T16:29~16:42Z UTC). 판정: Codex `gpt-6-astra` read-only가 표본과 증거만으로 글자 단위 판정(Claude는 판정에 관여하지 않음).
  - 결과: 제조사 같음 222/225(다름 3 — 화물 메뉴 표기 `기아(아시아)`·`쉐보레`), 모델 같음 221(화물 메뉴는 모델 그룹 없음 4). 세부모델 글자까지 같음 171/225(76.0%), 기아 개발명 허용 포함 180/225(80.0%). 다름 43 중 39는 엔카가 코드를 괄호로 쓰는 표기 차이(`코나 (SX2)`·`쏘나타 디 엣지(DN8)`·`5시리즈 (G30)`·`A6 (C9)`·`체로키(KL)` vs F03 `코나 SX2` 등), 3은 보존 중인 `통합→셀토스` 행, 1은 봉고(엔카 `봉고Ⅲ` 등 4종 중 특정 불가). 증거 없음 2(라보 — 화물 메뉴 미관측).
  - 한계(Codex): 층화·의도 포함 표본이라 가중치 없이 전체 일치율·신뢰구간을 낼 수 없다. 무작위 162행 일치 112/162(69.1%), 변경·추가 63행 59/63(93.7%). 표본에 명백한 글자 불일치가 있으므로 「F03 세부모델 전부 엔카와 글자 일치」는 성립하지 않는다.
  - 세부트림 구조(엔카 공개 화면 확인): 엔카 트림은 `연료·배기량 → 등급 → 세부등급` 단계다. 수입(BMW 5시리즈 (G30): `가솔린 2WD → 520i 럭셔리`, 세부등급 없음; RAV4 5세대: `가솔린 2WD → 2.5 2WD`)은 F03 세부트림 = 엔카 **등급**. 국산(K5 3세대: `LPG 2000cc → 2.0 LPI → 프레스티지·노블레스·시그니처`)은 F03 세부트림 = 엔카 **세부등급**만이고 등급(엔진) 단계가 빠져 같은 세부등급 이름이 여러 등급에 겹친다. 구조가 국산·수입에서 다르며 「엔카 그대로」와 어긋난다 — 고칠지·어떻게 합칠지는 결정 대기. 세부트림 글자 대조(변경·추가 63행 + 무작위 30행)는 구조 결정 뒤 진행.
  - 불일치는 고치지 않았다(AI 상황실 결정 대기).

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

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

Spreadsheet ID: `F01 시트(ID는 비공개 ai-ops 문서)`

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

Spreadsheet ID: `F03 차종마스터 시트(ID는 비공개 ai-ops 문서)`

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

- 2026-10-03 대표 오더(「엔카와 똑같이 맞춰라」, 경영지원실 전달)로 1회 정정: `차종마스터` 미확정 53행 판정, 이름 수정 16행(더 뉴 카니발 YP→더 뉴 카니발 13, 볼트 Volt→볼트(Volt) 1, 포터 II→포터 Ⅱ 1, 셀토스 SP2 고유 트림 1행을 셀토스로), 셀토스 SP2 중복 3행 「통합→셀토스」 표시(행 보존), 8행 추가(S-클래스 W222·EQ900·캐딜락 XT6·A-클래스 W176·셀토스 2세대 4). 기록 위치: 각 행 `클로드 엔카대조` 칸(이전 값 `←` 표기), 정정 전 파일 사본 `ERP-COM-GOOGLE-SHEETS-SSOT 백업 06(ID는 비공개 ai-ops 문서)`(1차 반영 직후 사본 — 1차 이전 값은 각 행 칸에 남김). 평소에는 위 직접 쓰기 금지가 그대로다.
- 제조사 표시는 정본 표기(도요타·쉐보레·르노·KGM, 괄호 없음 — 대표 2026-10-04 최종)로 바꾼다. 옛 이름은 `src/domain/vehicle-maker-name.ts` 별칭으로 계속 인식되며, F03 이름 변경은 이 별칭이 main에 들어간 뒤에 한다.
- 2026-10-04 대표 승인으로 2차 반영: 백업 사본 `ERP-COM-GOOGLE-SHEETS-SSOT 백업 07(ID는 비공개 ai-ops 문서)` → 제조사 표시명 380행 엔카 표기로 변경 → 보류 2종 추가(올 뉴 카니발 럭셔리, 더 넥스트 스파크 LT) → `별칭` 탭 신설 → 되읽기(의도 밖 변경 0, 기존 행 불변 ID 그대로, 원자ID 1,678/1,678·중복 0). 이후 `별칭` 탭을 원문 근거 기준으로 다시 점검해 조건 없는 추정 1줄을 「확인 필요」로 내리고 11줄에 원문 연료·연식 조건을 붙였다.
- 2026-10-04 대표 최종 규칙 3차 반영(AI 상황실 오더): 백업 사본 `ERP-COM-GOOGLE-SHEETS-SSOT 백업 08(ID는 비공개 ai-ops 문서)`(두 탭 원본과 같음 확인) → 쓰기 직전 두 탭 전체 재조회가 검토한 스냅샷과 같음 확인 → RAW 쓰기 → 되읽기. 바꾼 것: 597행·1,307칸 — 제조사 371행(`KG모빌리티(쌍용)` 140 → `KGM`, `르노코리아(삼성)` 132 → `르노`, `쉐보레(GM대우)` 99 → `쉐보레`), 세부모델=모델 338행(62그룹) → `기본형`, `볼트(Volt)` → `볼트 Volt` 1행(모델), 각 행 `클로드 엔카대조` 칸에 `10-04 최종규칙: … ← 이전값`. `별칭` 탭 26줄 수정(제조사 줄은 옛 괄호 이름 → 짧은 이름으로, 표시명이 모델 이름이던 세부모델·코드 줄은 `기본형`) + 69줄 추가(제조사 5, 세부모델 63 — 셀토스는 세부모델행키가 둘이라 키마다 한 줄씩 원문 세부트림 조건, 모델 1). 되읽기: 기대값과 다른 행 0, `P~S` 불변 ID 그대로, 원자ID 1,678/1,678·중복 0, 별칭 235행. 규칙 위반 남은 수: 옛 제조사 0 · 괄호 0 · 세부모델=모델 0 · 기아 `N세대` 4(`셀토스 2세대`, 개발코드 공식 확인 전). 계획은 Codex `gpt-6-astra` read-only 검토(1차 NO-GO: 셀토스 별칭이 세부모델행키 하나만 지정 → 수정 후 GO). 세부트림 「기본형」은 해석 결정 대기라 이번에 넣지 않았다.
  - 2026-10-04 세부트림 규칙 B 4차 반영(급한 분 — 공통 시트 「종합」 203대에 나오는 세부모델 78개 먼저, AI 상황실 오더): 백업 `ERP-COM-GOOGLE-SHEETS-SSOT 백업 09(ID는 비공개 ai-ops 문서)` → 재조회 = 검토본 → RAW 쓰기 → 되읽기(기대값과 다른 행 0, 불변 ID 그대로, 원자ID 1,678·중복 0, 별칭 246행). 그 세부모델들의 F03 행 678개 중 규칙 B로 바뀌는 것은 11행뿐(나머지는 이미 파워트레인 없는 등급 이름): 구조변경 LPG/바이퓨얼 → `구조변경` 5행(더 K9·더 뉴 카니발 KA4·카니발 KA4·G80·G90), `하이리무진 구조변경 LPG` → `하이리무진 구조변경`, SM7 노바 `V6` → `기본형`, EQ900 `3.8 GDI 프레스티지` → `프레스티지`, XT6 `3.6 스포츠` → `스포츠`, 셀토스 2세대 `X-라인` → `시그니처 X Line`, 더 뉴 카니발 `디럭스` → `11인승 디럭스` — 11행 모두 엔카 공개 화면 끝 이름 근거(세부모델 화면 한 번씩, 2026-10-04T00:47~00:56Z). 확인 필요 표시(이름 그대로) 21행: 더 뉴 카니발 KA4 HEV 등급 5행(엔카는 인승으로 가름 — 인승 없는 이름으로 통합 보류), K8 트렌디·스탠다드(엔카는 렌터카·택시형뿐), 더 뉴 카니발 인승 갈림 6행 등. 엑센트 신형은 엔카 세부모델 이름 미확인이라 다음 차례. 별칭 11줄(구분 `세부트림`). Codex `gpt-6-astra` 검토: 1차 NO-GO(카니발 HEV 통합·괄호 연료·증거 없는 행) → 고침 → GO.
  - 2026-10-04 세부트림 규칙 B 5차 반영(엔카 근거가 있는 나머지): 백업 `ERP-COM-GOOGLE-SHEETS-SSOT 백업 10(ID는 비공개 ai-ops 문서)` → 재조회 = 검토본 → RAW 쓰기 → 되읽기(다른 행 0, 불변 ID 그대로, 원자ID 1,678·중복 0, 별칭 280행). 이름 변경 26행(엑센트 신형 6 — 엔카 `엑센트(신형)` `1.4 VVT 모던` → `모던` 등, 더 뉴 SM6 `Ce 인스파이어` → `TCe 인스파이어`, 모델 Y 8 — 구동 표시 뗌, 익스플로러 6세대 5, RAV4 6세대 2 — `XLE`·`리미티드`, RAV4 5세대 4 — `기본형`·`XLE`·`LTD`·`XSE`), 「통합→」 8행(엑센트 `VVT 모던`→`모던` 등, 익스플로러 6세대 배기량만 다른 리미티드·플래티넘·하이브리드, RAV4 5세대 파워트레인만 다른 3행 → `기본형`), 판단 낱말 확인 필요 10행(VGT·S/C·에코부스트·TSI, RAV4 6세대 `XSE`/`GR 스포츠` 갈림), 별칭 34줄. Codex 검토: 전체안 NO-GO(엔카 증거 없는 이름 22·통합 17) → 증거 있는 34행만 GO. 남은 것: 더 뉴 카마로·모델 3·구형 익스플로러·체로키 KL·더 뉴 그랜드 스타렉스(이름 22·통합 17)는 엔카 끝 이름 확인 뒤.
  - 2026-10-04 세부트림 규칙 정정 반영(당시 기록 — 이후 대표 최종 「차종 4단 구조」로 엔진 이름도 파워트레인으로 버림. AI 상황실 독립 Codex 검토 — 떼는 것은 배기량·연료·구동뿐, 엔진 방식 표기 GDi·T-GDi·CRDi·MPi·VVT·CVVT·V6·V8 은 엔진 이름으로 남김): 백업 `ERP-COM-GOOGLE-SHEETS-SSOT 백업 11(ID는 비공개 ai-ops 문서)` → 재조회 = 검토본 → RAW 쓰기 → 되읽기(다른 행 0, 불변 ID 그대로). 앞 규칙으로 엔진 표기를 뗀 행을 고침: 엑센트 신형 `VVT 스타일`·`VVT 스마트`·`VVT 스마트스페셜`·`VVT 밸류 플러스` 원복, `위트 VVT 모던`·`위트 GDI 프리미엄`, `VVT 모던`·`VVT 프리미엄` 「통합→」 취소, SM7 노바 `V6` 원복. G80 `구조변경`(엔카 `3.3 GDI`·`3.3 T-GDI`·`3.8 GDI 구조변경 (LPG)` → `GDI 구조변경`·`T-GDI 구조변경`)·G90 `구조변경`(엔카 `3.3 T AWD 구조변경 (바이퓨얼)` → `T 구조변경`)은 둘로 갈려 종합판정·별칭을 확인 필요로 내림. 엔카 끝 이름으로 정한 행(더 뉴 카니발 `11인승 디럭스`·SM6 `TCe 인스파이어`·RAV4 6세대·셀토스 2세대·EQ900 끝 단 `프레스티지`)과 다른 구조변경 행은 그대로 맞다. 별칭 22칸. Codex 검토 1차 NO-GO(G90 누락·보류 상태 불일치) → 고침 → GO.
  - 2026-10-04 신규 5행(공통 시트에 나온 차 중 F03 행이 없던 것, 지지오토 원문 + 엔카 공개 화면 확인, 각 Codex GO, 백업 `ERP-COM-GOOGLE-SHEETS-SSOT 백업 12(ID는 비공개 ai-ops 문서)`·`ERP-COM-GOOGLE-SHEETS-SSOT 백업 13(ID는 비공개 ai-ops 문서)`, 되읽기 다른 행 0): 현대 아반떼 `아반떼 CN8`/`프리미엄`(엔카 `아반떼 (CN8)` 26년~), `아반떼 MD`/`M16 GDI 프리미어`, 기아 모닝 `뉴모닝`/`고급형 블랙프리미엄`, 제네시스 GV80 `기본형`/`기본형`(엔카 `GV80` 20년~ 하나, 세부등급 없음), 르노 SM7 `SM7 New Art`/`SE 플레져`. 새 세부모델 키는 그 모델 기존 모델행키를 만든 제조사 이름으로 계산했다(SM7 = `르노코리아` — sha256 대조로 확인, `르노코리아(삼성)` 아님). F03 행 없이 확인 필요로 둔 것: 쏘나타 디 엣지 DN8 `비즈니스`(엔카는 `비즈니스 1`·`비즈니스 2`뿐), 엑센트 신형 `디젤 1.6`·더 뉴 스파크 등급 없는 원문(엔카에 등급 없는 끝 이름 없음), G90 RS4 `3.5 터보`(이후 배기량 뒤 `터보`는 같이 뗀다로 결정 — G90 RS4 행 반영은 다음 계획).
  - 2026-10-04 세부트림 규칙 남은 행 반영(정본 `vehicle-trim-name.ts` #312·#314 기준, 엔카 근거가 있는 세부모델 64개만): 백업 `ERP-COM-GOOGLE-SHEETS-SSOT 백업 14(ID는 비공개 ai-ops 문서)` → 재조회 = 검토본 → RAW 쓰기 → 되읽기(다른 행 0, 불변 ID 그대로, 별칭 357행). 이름 변경 51행 — 규칙으로 34(르노 `LPe`·`LPLi`·`LPLI` 연료 표시 뗌, 카마로 `SS V8`, 모델 3 구동 뗌, 제타 `TSI …`, 체로키 KL 배기량·구동 뗌, 엑센트 `위트 VGT …`), 앞 글자가 잘려 있던 옛 이름 복원 17(엔카 끝 이름 중 그 이름으로 끝나는 것이 하나뿐일 때만: 올 뉴 K3 `도어 GT …` → `5도어 GT …`, 스포티지 NQ5 하이브리드 `주년 에디션` → `30주년 에디션`, SM6·더 뉴 SM6 `Ce …` → `TCe …`, SM5 노바 `CE` → `TCE`, G90 RS4 `S/C`·`S/C LWB` → `e-S/C`·`e-S/C LWB`, 더 뉴 카니발 KA4 `프레스티지` → `9인승 프레스티지`). 「통합→」 9행(그랜드 스타렉스 `어린이보호차 LPi`, SM5 노바 `LPLi LE`, 체로키 KL 배기량·연료·구동만 다른 7행 — 대표 행과 생산기간 같음). 확인 필요 9행(엑센트 신형 `모던`·`프리미엄`, 카니발 KA4 인승 갈림 5, PV5 `플러스`, SM6 `LPe PE`). 별칭 60줄. 손대지 않음: 이미 확인 필요 표시 33행, 엔카 세부모델 하나에 대응하지 않는 구형 익스플로러(`기본형` 1991~2019) 12행. Codex 검토 GO. 이어서 백업 `ERP-COM-GOOGLE-SHEETS-SSOT 백업 15(ID는 비공개 ai-ops 문서)` 후 신규 1685행 제네시스 G90 `G90 RS4`/`기본형`(엔카 `가솔린 3.5 터보 2WD` 세부등급 없음, 공통 시트 125호6774)과 GV80 쿠페 `S/C 가솔린` → `e-S/C`(엔카 끝 이름 하나뿐), 별칭 1줄 — Codex GO, 되읽기 다른 행 0. F03 1,684행.
  - 2026-10-04 대표 최종 「차종 4단 구조」(차종 기준 한 장) 최종 적용 — 정본 `vehicle-trim-name.ts` #325, 생성기가 정본 함수를 직접 부름, Codex 최종 검토 NO-GO(차단 4) → 수정 → GO(`final-plan.json` sha256 앞 16자리 `5502b8967dc978a4`, `spec-plan.json` `f4951af0dfa2e8ff`). 적용은 AI 상황실 세션이 실행(이 세션 권한 판정에서 시트 쓰기가 막혀 대표 지시로 넘김): 백업 (비공개 기록) → 재조회 = 검토 스냅샷 → RAW 쓰기 → 되읽기(f03·별칭·제원 기대값과 다른 행 0, 보조 탭 다른 행 0, 원자ID 1,684·빈칸 0, `P~S` 불변 ID 그대로). 바꾼 것: `차종마스터` 262칸(세부트림 E 91 — 이름 변경, `통합→` 표시 57행(행 보존), 확인 필요 해소 20, 셀토스 `셀토스 2세대` → `셀토스 SP3` 4행 D·I, 종합판정 N 2), `별칭` 목표 27행 갱신(D38·D63 `셀토스 SP3` 포함)·151행 추가(세부트림 141·세대 1·구동 9, 359~509행), `제원마스터` 구동방식 `2WD·4WD·AWD` 세 값(B114 RWD → 4WD, `FWD·RWD → 2WD`, `4MATIC·4MATIC+·콰트로·quattro·xDrive·4MOTION·HTRAC → AWD` 별칭)·연료 `플러그인 하이브리드`·`가솔린+LPG` 추가·배기량 실제값 6(1200·1496·1800·1950·2987·6200, Data `engine_cc`·엔카 원문) 추가(116~123행), 새 탭 `파워트레인_보조`(F03 원자ID·제조사·모델·세부모델·세부트림·파워트레인·연료·배기량(cc)·구동·출처·확인일, 2,324행 — 출처 셋: 이번 정비에서 정본 함수가 뗀 낱말 · 엔카 공개 화면 등급 칸 · Data `vehicle_trim_master.powertrain`, 차량번호 없음). 손대지 않음: 세부트림 확인 필요 9행·엔카 근거 없음 12행(옛 익스플로러)과 이전 회차 확인 필요 표시 행(합 63행, HOLD). 재감사(새 조회, 읽기 전용): 활성 행 1,609(통합 75 제외) 세부트림에 파워트레인 낱말 남음 0·세부모델 괄호 0·제조사 긴 이름 0·기아 N세대 0·활성 행 네 칸 중복 0·통합 대상 없음 0·별칭 목표 매달림 0(확인 필요 제외)·구동 목록 = 2WD·4WD·AWD·보조 탭 연료·배기량·구동 목록 밖 0·PHEV 연료 어긋남 0·차량번호 0. 운영 메모: `apply-all.mjs`는 보조 탭 300행 묶음 쓰기에서 Windows 명령줄 길이 한도로 멈췄고(그때까지 백업·탭 생성·F03 일부 써짐), 같은 계획을 40행·8KB 조각으로 이어 썼다(이어 쓰기 전 각 행이 적용 전/후 둘 중 하나인지 확인, 어긋남 0). 큰 값은 gws 인자 대신 조각을 8KB 이하로 둔다.
  - 남음: Data(`vehicle_trim_master`) 표기 차이(X-Line↔X Line, Black↔블랙, TCe LE 등 엔진 접두)는 급한 작업 세션이 Data 쪽에서 고친다. F03 기본형 세부모델 parity HOLD 61은 기존 repair 경로로 Data 이름을 바꿀 때 해소.
  - 2026-10-04 인승 뗌·기아 X-Line 적용(기준 한 장 2절 5·6번, 정본 함수 #331): 계획 `seat-plan.json`(sha256 앞 16 `16b608c3b0d53f6e`, Codex GO). 이 세션의 시트 쓰기가 권한 판정에 막혀 대표 승인으로 AI 상황실이 실행 — 백업 (비공개 기록) → 재조회 = 검토 스냅샷 → RAW → 되읽기(다른 행 0, 불변 ID 그대로). 바꾼 것: 차종마스터 28칸 — 이름 변경 9(기아 `시그니처 X Line` → `시그니처 X-Line` 6, 더 뉴 카니발 `11인승 디럭스` → `디럭스`, 더 뉴 카니발 KA4 `9인승 프레스티지` → `프레스티지`·`HEV X Line` → `X-Line`), `통합→` 5(KA4 `HEV 프레스티지·노블레스·시그니처·그래비티`, `X Line` — 확정 행에 통합, 행 보존), 카니발 계열 확인 필요 해소 11(인승·HEV 를 떼면 엔카 끝 이름 하나), 별칭 목표 3·추가 14(510~523), 파워트레인_보조 E 7. 남은 카니발 확인 필요 5(더 뉴 카니발·KA4 `하이리무진` 3 — 엔카는 하이리무진 아래 세부등급이 있음, 카니발 KA4 2 — 엔카 근거 미수집). 재감사 위반 0(활성 행 인승·비BMW `X Line` 0 포함).
  - 2026-10-04 제조사 공식 표기 BMW `X Line → xLine`·현대 `H Pick → H-Pick` 적용(대표 선택, 기준 한 장 6번 — 목록이 모델 번호 예외보다 앞섬, 정본 함수 #332 제조사별 표기): 계획 `spell-plan.json`(`f7744df2cf7d7988`, Codex GO — 첫 검토 NO-GO 는 실행기 되읽기 실패 처리, 보완 후 GO). AI 상황실 실행 — 백업 (비공개 기록), 되읽기 다른 행 0·`READBACK_OK`. 바꾼 것: 이름 13행(BMW X1 U11 3·X1 F48 3·X4 G02 2, 현대 코나 SX2·코나 하이브리드 SX2·더 뉴 투싼 NX4·하이브리드·싼타페 MX5), 별칭 추가 13(524~536), 파워트레인_보조 E 6. 재감사 위반 0. `M 스포츠 → M 스포츠 패키지`는 대표 «빼기»로 하지 않음.
  - 2026-10-04 행 추가 후보 묶음 적용(급한 작업 세션 판매 중 차 parity 판정에서 나온 것, 계획 `cand-plan.json` `db478ef163c66a26`, Codex GO — 첫 검토 NO-GO 는 실행기 실패 처리·백업 ID 확인·근거 없는 메모 문장, 보완 후 GO): AI 상황실 실행 — 백업 (비공개 기록), 되읽기 다른 행 0·원자ID 1,685·중복 0. 추가: 차종마스터 1686행 `국산|현대|스타렉스|그랜드 스타렉스|CVX 프리미엄|2007|2017`(엔카 공개 화면 `그랜드 스타렉스 (07~17년)` 디젤 2WD » 12인승 왜건 » 세부등급 `CVX 프리미엄`, 공급사 원문 `그랜드스타렉스 디젤 왜건 12인승 CVX Premium AT` — 경로 하나; `프리미엄` 단독은 11인승 왜건 HVX 아래라 별칭 없음), 별칭 세부모델 5(537~541: `더 뉴 토레스 J116/J140`·`쿠퍼 C F66/F65`·`더 뉴 렉스턴 스포츠 칸 Q251/Q261`·`니로 플러스 DE`·`더 뉴 QM6 HZG` → F03 세부모델; `Q261` 단독 코드는 무쏘 쪽이라 이름 전체로만). 행을 추가하지 않은 것(엔카 확인): GV70 FL 세부모델 없음, 테슬라 모델 3·Y 세부모델 하나, 토레스 하이브리드 = `더 뉴 토레스`/`뉴 토레스` 아래 파워트레인(`T5`·`T7`). 재감사 위반 0.
  - 실행기 규칙(이번 회차에서 굳힘): 계획 해시 고정 확인 → 쓰기 직전 재조회 = 검토 스냅샷 → 백업 ID 확인 → RAW 를 UTF-8 8KB 이하 조각으로(Windows 명령줄 길이 한도) → 되읽기 불일치·조회 실패는 exit 2.
  - 후속 HOLD: (1) ERP4 `publish-vehicle-master-to-erp5-firestore`(수동 스크립트, 자동 workflow 없음 — `publish-erp5-ssot.yml`은 수동 감사·쓰기 없음)는 발행 ID를 이름에서 다시 계산하므로 `P~S` 불변 ID를 쓰도록 고치기 전에는 돌리지 않는다. (2) 공동 시트 `차종목록` 드롭다운과 이미 채운 제조사·세부모델 값은 F03 최신본으로 다시 계획해 바꾼다(공급사 원문 값은 일괄 치환하지 않는다). (3) `별칭` 탭 기존 15줄의 `F03 세부모델행키` 칸에 `vmt_`(세부트림행키)가 들어 있다 — 이번에 만들지 않은 기존 정합성 문제, 따로 정리. (4) freepasserp4 `ai-operating-manual.ts` «세대 이름» 줄·`f03-canonical-projection.ts`·`makerForMatch`를 최종본으로 고치는 PR.

#### 차종 4단 구조 — 모델 → 세부모델 → 파워트레인 → 세부트림 (대표 최종 2026-10-04)

- **기준 정본은 ai-ops `docs/차종-기준-한장.md`(AI 상황실, 2ba239a) 한 장이다.** 이 절과 `src/domain/vehicle-trim-name.ts`는 그 장을 구현하는 것이라, 다르면 이쪽을 고친다.

- 대표: 「차종은 세부모델 → 파워트레인 → 세부트림이 있다. 파워트레인 = 1.6 GDI(배기량+엔진, 가솔린이냐 등). 그건 이미 제원에 있으니 1.6만·GDI만 빼는 게 아니라 «1.6 GDI»를 통째로 안 쓴다. 그래서 차종 마스터는 모델·세부모델·세부트림뿐이다. 차종 마스터에 이미 있는 걸 비교해서 갖다 놓는 거다.」 + 앞서 「세부트림은 프레스티지·익스클루시브 같은 것이다. 1.6 GDI 가 왜 세부트림에 들어가냐」.
- 파워트레인(배기량·엔진 이름·연료·구동 — TCe·dCi·VVT·GDI·터보·e-S/C 포함)은 공통 시트·상품의 제원 칸(배기량·연료)이 맡는다. 차종 마스터(F03)에는 쓰지 않는다.
- 엔카 «등급» 이름은 파워트레인 + 세부트림이다. 세부트림만 남긴다(위 «세부트림» 줄). 엔진 이름(GDI·TCe 등)은 따로 칸을 두지 않는다 — 필요하면 공급사 원문과 프리패스 데이터 `vehicle_trim_master.powertrain`에 남아 있다.
- 수입차 모델번호 예외의 경계(한 장 2절 5): 엔카 등급 이름이 «숫자로 된 모델번호»(`520d`·`C300`·`S350 d`·`45 TFSI`·`xDrive30d`)로 시작하면 엔카 글자 전체를 그대로 둔다(`4MATIC`·`TFSI` 포함). 그렇지 않으면(제타 `1.4 TSI 프리미엄`) 파워트레인을 버린다(→ `프리미엄`).
- 제원 값은 F03 `제원마스터` 목록에서만 고른다 — 연료(가솔린·디젤·LPG·하이브리드·플러그인 하이브리드·전기·수소·가솔린+LPG), 구동(2WD·4WD·AWD; FWD·RWD → 2WD, 4MATIC·콰트로·xDrive·4MOTION·HTRAC → AWD), 배기량(cc — 실제 cc와 반올림 값이 같이 있어도 지우지 않되 같은 차에 둘 다 쓰지 않는다).

#### 시트·Data 차종 채우기 원칙 (대표 최종 2026-10-04, 한 장 3·4절)

- 무엇이 이기나: **이름 짓기**(F03을 만들고 고칠 때만) = 한 장의 규칙 → 엔카. **이름 쓰기**(차 한 대·시트·Data를 채울 때) = F03에 있는 이름만 — 프리패스 데이터 마스터·공급사 원문 표기는 쓰지 않는다. **차 한 대 사실**(어느 세부모델·세부트림·연식·배기량·연료인가) = 지지오토 → 공급사 원문 → 프리패스 데이터. 「어느 등급인가」는 사실 순서로 정하고, 「뭐라고 적나」는 F03 이름으로 적는다.
- F03이 규칙·엔카와 다르면 F03을 고친다. 프리패스 데이터 `vehicle_master`·`vehicle_trim_master`는 F03을 따라간다 — 다르면 Data를 고친다(기존 이름 정정 경로).
- F03에 있는 행과 비교해 그 이름을 갖다 놓는다. 새 이름을 지어내지 않는다(공급사 원문으로 F03 행을 새로 만들지 않는다 — F03 신규 행은 엔카 공개 화면에서 확인한 이름만).
- 채우는 작업 순서(싸고 빠른 것부터, 값이 엇갈리면 위 «차 한 대 사실» 순서가 이긴다): ① 프리패스 데이터 `products/<차량번호>` 값을 출발점으로 원문과 맞춰 봄 ② F03에서 맞는 한 행 / 제원마스터 목록에서 값 고름 ③ 안 되면 공급사 원문 낱말로 다시 고름 ④ 그래도 안 되면 지지오토(원문으로 못 고른다고 Codex가 확인한 차만, 아이디당 하루 20대) ⑤ 그래도 안 되면 확인 필요. F03에 없는 차는 엔카 공개 화면 이름으로 F03에 추가한 뒤 다시 ②.
- 원문으로 하나가 정해지지 않으면 비우고 확인 필요(확인 동선). 추정·자유 입력 금지.

#### F03 차종마스터 운영 규칙 (대표 결정 2026-10-03~04)

- **엔카와 다른 점 — 이것뿐(대표 최종 2026-10-04, 앞선 예외 목록을 모두 대체)**: 대표 「엔카랑 완전히 동일하다. 기아 세대명은 개발코드로 쓰고, 괄호는 쓰지 않는다」 + 같은 날 보충. 원문은 `docs/SUPPLIER-INPUT-SHEET-RUNBOOK.md` 「차종 마스터 = 엔카와 완전히 동일」 절.
  1. 기아만 `N세대` → 개발코드(`K5 3세대` → `K5 DL3`).
  2. 괄호 없음 — 괄호 안 코드는 살리고 괄호만 뺀다(`쏘나타 디 엣지(DN8)` → `쏘나타 디 엣지 DN8`, `볼트(Volt)` → `볼트 Volt`). 개발코드는 떼지 않는다.
  3. 기본형 — 모델과 세부모델이 같은 축이면 세부모델 `기본형`(`G80 / G80` → `G80 / 기본형`). 세부트림은 아래 5.에서 파워트레인을 뗀 뒤 남는 것이 없으면 `기본형`.
  4. 제조사 짧게: `쉐보레` · `르노` · `KGM`(옛 `쉐보레(GM대우)`·`GM대우`·`르노코리아(삼성)`·`르노코리아`·`르노삼성`·`KG모빌리티(쌍용)`·`KG모빌리티`·`쌍용`은 별칭). `도요타`는 엔카 표기(`토요타`는 별칭).
  5. 세부트림에는 파워트레인을 쓰지 않는다 — 아래 «차종 4단 구조».
  그 밖에는 전부 엔카 글자 그대로다 — `G80 DH` 같은 우리 시트만의 예외 없음, 2019 이전 종료 세대도 엔카에 있으면 둔다, 영문·한글 표기도 엔카 글자대로. 옛 정본 freepasserp4 `ai-operating-manual.ts` «세대 이름» 줄·`f03-canonical-projection.ts`·`makerForMatch`는 이 최종본으로 고칠 대상이다.
- **기준과 단계**: 위 다른 점 말고는 엔카 공개 화면 표기를 그대로 쓴다. 단계는 엔카와 같은 4단계 `제조사 → 모델 → 세부모델 → 세부트림`(+생산시작·생산종료). 화물·특장은 엔카 화물·특장 메뉴 표기를 쓴다.
- **세부트림**: 엔카에 세부등급이 있으면 그 글자 그대로. 세부등급이 없으면 엔카 등급 이름(= 파워트레인 + 세부트림)에서 파워트레인 부분을 통째로 버린 나머지(`1.4 VVT 스타일` → `스타일`, `M16 GDI 프리미어` → `프리미어`, `1.8 TCe 인스파이어` → `인스파이어`, `1.2 LT` → `LT`), 남는 게 없으면 `기본형`(`1.5`·`가솔린 3.5 터보 2WD` → `기본형`). 용도 괄호(`트렌디(렌터카)`)는 세부트림의 일부라 남긴다(인승은 «당시 기록 — 10-04 인승은 제원으로 철회», 아래 줄대로 뗀다). 모델 번호가 곧 등급인 수입차(`520d xDrive M 스포츠`, `C300 4MATIC`, `40 TDI 콰트로 프리미엄`)는 그대로. 구현 정본은 `src/domain/vehicle-trim-name.ts` — 그 파일의 낱말 목록(배기량·엔진 TCe·dCi·TSI·TDI·VGT·터보·GDi·T-GDi·CRDi·MPi·VVT·V6·e-S/C 등·연료·구동)은 «파워트레인 부분»을 알아보는 수단일 뿐이고 정의는 아래 4단 구조다. 새로 판단이 갈리는 낱말은 그 파일 `TRIM_UNDECIDED_TOKENS`에 두고 떼지 않는다.
- **인승·제조사 공식 표기(2026-10-04, 기준 한 장 2절 5·6번)**: 인승(`7인승`·`9인승`·`11인승`)은 제원 칸이라 세부트림에서 뗀다 — 엔카가 `9인승 노블레스`·`7인승 노블레스`로 나눠도 세부트림은 `노블레스` 하나, 엔카 이름은 별칭으로만 둔다. 같은 세부모델에서 인승을 떼어 이름이 같아지는 행은 `통합→`(행·불변 ID 보존). 제조사 공식 표기 낱말은 엔카 대신 그 제조사 표기로 쓴다 — 지금 목록 기아 `X Line → X-Line` · BMW `X Line → xLine` · 현대 `H Pick → H-Pick`(목록은 기준 한 장 6번에만, 코드는 `TRIM_OFFICIAL_SPELLINGS`, 제조사를 받아야 바꾼다). 이 목록은 수입차 모델 번호 예외보다 앞선다(`xDrive20i X Line` → `xDrive20i xLine`). 세부등급 글자에도 같은 두 규칙을 적용한다.
- **기아 개발코드 확인**: 엔카가 세부모델에 `N세대`를 붙인 자리에만 쓴다. 엔카에 세대 표기가 없으면 엔카 이름 그대로(`더 뉴 카니발`, `올 뉴 카니발`). 개발코드는 기아 공식 발표로 확인하고, 확인되지 않으면 엔카 표기를 쓰고 「개발명 확인 필요」로 표시한다(예: `셀토스 2세대`). 기아 외 제조사는 엔카 세대 표기 그대로(`RAV4 5세대`).
- **제조사 표시명**: 위 4. 옛 이름은 Data 별칭(`vehicle-maker-name.ts`)과 F03 `별칭` 탭에 남긴다.
- **범위**: 우리 취급 차종만 둔다. 공급사·공동 시트에 F03에 없는 차가 나오면 그 차만 엔카 공개 화면에서 확인해 추가한다. 엔카 목록을 통째로 수집하지 않는다(`api.encar.com` robots.txt 전체 Disallow, www도 `/catalog/`·`/cars/` 금지). 공개 화면을 사람처럼 한 화면씩 간격을 두고 열람하며 로그인·접근 제한 우회는 하지 않는다.
- **불변 ID**: `모델행키`·`세부모델행키`·`세부트림행키`·`원자ID`는 이름이 바뀌어도 바꾸지 않는다. 신규 행만 계산한다 — `vmm_`=sha256(`원산지|제조사|모델`), `vms_`=sha256(`원산지|제조사|모델|세부모델`), `vmt_`=`vm_`=sha256(`원산지|제조사|모델|세부모델|세부트림`(빈칸은 `기본형`)), 각 hex 앞 24자(ERP4 `lib/domain/erp5-vehicle-master-ssot.ts` `stableEntryId`). 같은 모델에 행을 추가할 때는 그 모델 기존 행이 키를 만든 당시의 제조사 이름으로 계산해 `모델행키`가 기존과 일치하는지 확인한다(제조사 표시명 변경 전에 추가하거나, 기존 모델행키를 그대로 쓴다).
- **중복·폐지 행**: 행을 지우지 않는다. 같은 차종의 중복 행은 `클로드 엔카대조` 칸에 `통합→<세부모델>`로 표시해 보존하고, 공동 시트 드롭다운 등 소비처는 이 행을 목록에서 뺀다.
- **`별칭` 탭**: `구분 | 옛 이름(원본·이전 표기) | 모델 | F03 표시명 | F03 세부모델행키 | 조건 | 근거 | 등록`. 원문만으로 한 행에 특정될 때만 조건 없이 둔다. 같은 옛 이름이 둘 이상에 걸리면 원문의 연료·연식·최초등록·차명(쿠페·칸 등) 칸으로 가르는 조건을 적고, 원문으로도 특정되지 않으면 `F03 표시명`을 「확인 필요」로 두고 후보만 근거에 적는다(억지로 특정하지 않는다).
- **`별칭` 탭 구분 `세대`(기아 N세대 → 개발코드, 2026-10-04)**: `옛 이름` = 엔카 세부모델 이름 전체(`카니발 4세대`, `더 뉴 카니발 4세대`), `F03 표시명` = F03 세부모델 이름 전체(`카니발 KA4`, `더 뉴 카니발 KA4` — 코드만 쓰지 않는다), `F03 세부모델행키` = 그 세부모델 `vms_`. `조건` = 원문 낱말(순서 무관) 「모델 + N세대 + `더 뉴` 있음/없음」(엔카가 하이브리드 세부모델을 따로 두는 스포티지·K5만 「하이브리드」 있음/없음) — 낱말로 하나면 그대로 쓰고, 둘 이상 남을 때만 원문 연식·최초등록으로 가르며 못 가르면 확인 필요(F03 생산기간은 참고). 첫 등록 17줄(별칭 281~297행, Codex 검토 GO): 니로·K3·스포티지(4)·K5(6)·쏘렌토(2)·K9·카니발(2). F03에 해당 세부모델이 없는 엔카 세대(`K5 2세대`·`K5 하이브리드 2세대`·`스포티지 4세대`)와 개발코드 확인 전인 `셀토스 2세대`는 넣지 않았다. ERP4 차종 마스터 발행(#553)이 이 줄을 읽는다.
- **신규 행 추가 절차**: (1) 공급사·공동 시트 원문과 차량번호·최초등록일로 차종을 특정 (2) 엔카 공개 화면에서 세부모델·트림·연도 확인 (3) 파일 사본 백업 + 바꾸는 범위 전체 값 저장 (4) `A~G` 이름·기간, `I`(클로드 엔카대조)에 근거와 이전 값(`←`), `N~O` 검수 상태, `P~S` 불변 ID 기록 (5) 전체 되읽기로 의도 밖 변경 0·원자ID 중복 0 확인. 원문으로 특정되지 않는 차는 추가하지 않고 확인 동선(ai-ops `docs/확인-동선.md`)으로 공급사에 묻는다.
- **직접 쓰기 금지와 예외**: 위 「direct live Canonical writes are prohibited」는 평소 규칙이다. 대표가 명시적으로 승인한 정정만 예외로 하며, 예외는 이 절에 날짜·내용·백업 위치를 한 줄로 남긴다.
- **코드 별칭(2026-10-04 대표 지적 「쏘나타 DN8인데 세부모델 안 적었다」)**: `별칭` 탭 구분 `코드` 줄은 세대·개발 코드 토큰(DN8·CN7·NQ5·KA4·GL3·LX2·SP2·W222 등)으로 같은 제조사·모델 안의 F03 세부모델을 가리킨다. 출처는 F03 세부모델 이름 속 코드와, 이미 검토한 공급사 원본 정제명의 코드다. 코드가 한 세부모델에만 걸리면 조건 없이, 페이스리프트 전후·연료별로 여러 세부모델에 걸리면 `생산기간으로 가름`(F03 생산기간 vs 원문 연식·최초등록)과 `원문 연료` 조건을 적는다. 연료 조건은 세부모델 이름이 아니라 차종의 실제 연료로 적는다(예: 니로는 하이브리드 차종). 원문으로 가르지 못하면 채우지 않는다. 코드는 그 모델 안에서만 적용한다.

#### F03 → 프리패스 데이터 차종 마스터 옮기기 (대표 2026-10-04 «F03은 프리패스 데이터를 투영하는 정도여야지», 기준 한 장 ai-ops 72ff613·ed8a872)

- **정본**: 차종 마스터의 정본은 프리패스 데이터(freepasserp5 `vehicle_master`·`vehicle_trim_master`·별칭)다. F03 시트는 그것을 보여 주는 사본(투영)이다. F03 쓰기는 2026-10-04 멈췄고, 네 탭(`차종마스터`·`별칭`·`제원마스터`·`파워트레인_보조`) A1 칸에 «투영 — 직접 수정 금지» 메모를 달았다(값 변경 없음, 되읽어 확인). 시트 삭제는 대표가 따로 말할 때만.
- **이름 규칙**: 엔카·다나와는 둘 다 근거 자료(개발코드·출시/부분변경 시기·등급 이름)이고 이름은 기준 한 장 2절 우리 규칙으로 짓는다(어느 한쪽 글자를 베끼지 않음). 다나와 13개 브랜드 타임라인(2026-10-04 수집)은 참고 자료로만 둔다.
- **대조(2026-10-04, 읽기만)**: F03 세부모델 268·활성 세부트림 1,605 ↔ 프리패스 데이터 `vehicle_trim_master` 2,078행(세부모델 203)·`vehicle_master` 1,816. F03 활성 세부트림 중 같음 490 · 별칭/띄어쓰기만 다름 5 · 데이터에 그 이름 없음 449 · 데이터에 세부모델 없음 661. F03 세부모델 135개가 `vehicle_trim_master`에 없고 그중 75개는 `vehicle_master`에도 없음.
- **범위(대표 «우리에게 필요한 것만»)**: 프리패스 데이터 `products` 1,760대가 실제로 쓰는 F03 세부모델 129·세부트림 224행만 옮김 대상. 그중 데이터 마스터에 없는 세부모델 34개(차 많은 순 K8 기본형 57·캐스퍼 기본형 35·더 뉴 K8 23·쏘나타 디 엣지 DN8 19·팰리세이드 기본형 16·더 뉴 기아 레이 14·셀토스 SP3 13 …)를 우리 규칙 이름으로 마스터에 더한다. 나머지 F03 행은 참고로만 둔다. `products` 쪽: 마스터와 세부모델·세부트림 다 맞음 751 · 세부모델 이름이 마스터에 없음 817 · 세부트림 없음 53 · 세부트림 빈칸 72 · 세부모델 빈칸 67.
- **F03을 읽거나 쓰는 곳(바꿀 대상)**:
  - ★자동으로 F03에 쓰는 곳: freepasserp4 `scripts/repair-f03-ssot-projection.mts`(`run-hourly-with-ssot-gate.mts` ⑤-9, `.github/workflows/sync-now-once.yml` `--apply`) — F03 표기 보정 + 공급사 정제칸 투영. 투영 원칙과 어긋나므로 먼저 멈추거나 프리패스 데이터를 읽게 바꿔야 한다.
  - F03을 읽어 하류에 씀(수동): freepasserp4 `publish-vehicle-master-to-erp5-firestore`, `fill-supplier-from-encar-sheet`, `stamp-encar-codes-on-supplier`/`learn-encar`, `fix-refine-vehicle-class`, `publish-vehicle-master-tab`(IMPORTRANGE), 손오공 정제(`sonokong/scripts/손오공-정제.mjs`, hourly-sync ⓪).
  - F03 스냅샷을 기준값으로(이 저장소): `audit:vehicle-name-parity`(`VEHICLE_NAME_REFERENCE_JSON`), `repair:vehicle-name-parity`(trim 정정 방향이 거꾸로 됨 — 뜻 다시 정함), `rename-vehicle-models`, `scripts/supplier-input-sheet.mjs --vehicle-master`(공통 시트 `차종목록`), `contracts/supplier-input-sheet-spec.v1.json` `vehicleMaster.source`, `src/domain/authority.ts` 설명, `src/domain/vehicle-trim-name.ts` 설명.
  - 읽기 전용 감사: freepasserp4 `audit-refine-vs-master`(monitor), `audit-encar-work-sheet`, `audit-encar-work-vs-sheets`, `check-stamp-name-lock`, `plan-inventory-master-gap`, freepass-sales `supplier-coverage`.
  - 정본 표기 고칠 문서·레지스트리: ai-core `registry/data-owners.json`(차종제원 정본 = F03 → 프리패스 데이터), ai-ops 지도(`SHEET_MAP`·`연동지도`·`업무지도`), freepasserp4 `ai-operating-manual.ts`·`vehicle-master-playbook.ts`.
  - 헷갈리기 쉬운 다른 시트: freepasserp4 `MASTER_SHEET_ID ERP4 원천대장 시트(ID는 비공개 ai-ops 문서)`(ERP4 원천대장)도 탭 이름이 `차종마스터`다 — F03 아님.
- **순서**: ① F03 자동 쓰기(`repair-f03-ssot-projection`) 멈춤 ② 우리 규칙 이름 확정(부분변경 «더 뉴» 통일·하이브리드 세부모델 합치기 — 대표 결정 대기) ③ 쓰이는 세부모델 34개 정비안 → Codex → 프리패스 데이터 마스터 반영(별칭·파워트레인·엔카 근거는 그 34개에 필요한 것만) ④ `products` 817대 이름을 마스터에 맞춤(기존 정정 경로) ⑤ 위 읽는 곳들을 프리패스 데이터 마스터로 바꿈(공급사 입력 드롭다운 → 감사 기준 → 정정·이름 변경 → freepasserp4 수동 스크립트) ⑥ F03을 프리패스 데이터에서 다시 그리는 투영 작업.
- **세부모델 별칭 칸**: 세부트림 별칭은 `vehicle_trim_master.trim_aliases`에 있으나 세부모델 별칭(공급사 원문 «더 뉴 토레스 J116/J140» 등)을 둘 칸이 데이터에 없다 — 새로 만들지 대표 결정 대기.


#### F03 검증 기록

- **2026-10-04 엔카 일치 독립 검증(모델·세부모델 단계)** — 표본: 씨앗값 `f03-encar-verify-20261004`, 제조사별 층 `max(4, round(150×제조사행수/1,678))`개를 `sha256(seed|원자ID)` 오름차순으로 + 그날 변경·추가 63행 전부 = 225행(세부모델 ID 121개). 증거: 엔카 공개 화면 검색 패널 「제조사/모델/등급」 원문(모델 그룹 82개, 한 화면씩 약 7초 간격, 로그인·API 직접 호출 없음, 관측 시각 2026-10-03T16:29~16:42Z UTC). 판정: Codex `gpt-6-astra` read-only가 표본과 증거만으로 글자 단위 판정(Claude는 판정에 관여하지 않음).
  - 결과: 제조사 같음 222/225(다름 3 — 화물 메뉴 표기 `기아(아시아)`·`쉐보레`), 모델 같음 221(화물 메뉴는 모델 그룹 없음 4). 세부모델 글자까지 같음 171/225(76.0%), 기아 개발명 허용 포함 180/225(80.0%). 다름 43 중 39는 엔카가 코드를 괄호로 쓰는 표기 차이(`코나 (SX2)`·`쏘나타 디 엣지(DN8)`·`5시리즈 (G30)`·`A6 (C9)`·`체로키(KL)` vs F03 `코나 SX2` 등), 3은 보존 중인 `통합→셀토스` 행, 1은 봉고(엔카 `봉고Ⅲ` 등 4종 중 특정 불가). 증거 없음 2(라보 — 화물 메뉴 미관측).
  - 한계(Codex): 층화·의도 포함 표본이라 가중치 없이 전체 일치율·신뢰구간을 낼 수 없다. 무작위 162행 일치 112/162(69.1%), 변경·추가 63행 59/63(93.7%). 표본에 명백한 글자 불일치가 있으므로 「F03 세부모델 전부 엔카와 글자 일치」는 성립하지 않는다.
  - 세부트림 구조(엔카 공개 화면 확인): 엔카 트림은 `연료·배기량 → 등급 → 세부등급` 단계다. 수입(BMW 5시리즈 (G30): `가솔린 2WD → 520i 럭셔리`, 세부등급 없음; RAV4 5세대: `가솔린 2WD → 2.5 2WD`)은 F03 세부트림 = 엔카 **등급**. 국산(K5 3세대: `LPG 2000cc → 2.0 LPI → 프레스티지·노블레스·시그니처`)은 F03 세부트림 = 엔카 **세부등급**만이고 등급(엔진) 단계가 빠져 같은 세부등급 이름이 여러 등급에 겹친다. 구조가 국산·수입에서 다르며 「엔카 그대로」와 어긋난다 — 이후 대표가 세부트림 = 엔카 «맨 끝 단»으로 정했다(위 운영 규칙).
  - 불일치는 고치지 않았다(AI 상황실 결정 대기). 위 세부모델 다름 중 괄호 39는 대표 최종 「괄호 없음」으로 F03 쪽이 맞다.
- **2026-10-04 세부트림 «끝 단» 글자 대조** — 대상: 같은 날 변경·추가 63행 전부 + 무작위 30행(`sha256(seed|세부트림|원자ID)` 오름차순, 제조사 층화) = 93행. 증거: 엔카 공개 화면 검색 패널을 세부모델 42개에 대해 `연료·배기량 → 등급 → 세부등급`까지 한 화면씩 6~7초 간격으로 펼친 이름(관측 2026-10-03T17:02~18:27Z UTC, 로그인·API 직접 호출 없음). 판정: Codex `gpt-6-astra` read-only, 증거 파일만으로 글자 단위(「(세부등급 없음)」 경로는 등급이 끝 단).
  - 결과: 끝 단 글자 일치 65/87 = 74.7%(변경·추가 43/58, 무작위 22/29), 표기만 다름 0. 증거 없음 6(보존 행 셀토스 SP2 3, 포터 Ⅱ·봉고·뉴 라보 — 화물 메뉴는 트림 단계 없음).
  - 불일치 22: 끝 단 아님 19 — 상위 등급에 머묾(RAV4 6세대 3행, 엔카 끝 단 `XLE`·`리미티드`·`XSE`/`GR 스포츠`; 미니 쿠퍼 S `5도어 클래식`, 엔카 끝 단이 세대 `3세대`), 끝 단에 든 인승·구동·용도가 빠짐(더 뉴 카니발 6행 `디럭스`·`노블레스`·`수출형`·`어린이 보호차`·`하이리무진`·`휠체어 리프트`, 더 뉴 카니발 KA4 `HEV X Line`, 스포티지 NQ5 하이브리드 `노블레스`, GV60 `퍼포먼스`, 더 뉴 QM6 `퀘스트 2.0 LPe 밴`, 트랙스 크로스오버 `LT`, K8 `트렌디`·`스탠다드` — 엔카는 `(렌터카)`·`(택시형)`), 일부만(더 뉴 SM6 `Ce 인스파이어` vs `1.8 TCe 인스파이어`, 셀토스 2세대 `X-라인` vs `시그니처 X Line`); 이어 붙임 2(EQ900 `3.8 GDI 프레스티지`, 셀토스 `시그니처 X Line` — 1세대 엔카에 X Line 없음); 없음 1(볼트 Volt `기본형`, 엔카 등급 `1.5` 하나).
  - 같은 끝 단 이름이 한 세부모델 안 여러 경로(연료·배기량·등급)에 걸리는 행 26 — 트림 이름만으로는 엔카 차 하나가 특정되지 않고 배기량·연료·인승 칸이 함께 필요하다.
  - 「기본형」 보충 규칙(엔카에 세부등급이 없으면 세부트림 기본형)을 글자대로 적용하면 끝 단 일치 29행(예: 5시리즈 G30 `520d 럭셔리 플러스`, 모델 Y `프리미엄 롱 레인지 AWD`, K8 하이브리드 `노블레스`)과 후보 13행이 `기본형`으로 바뀐다. Codex 제안 문구 「엔카 경로의 마지막 실제 이름, 세부등급이 없으면 등급명, 등급명까지 없다는 관측 근거가 있을 때만 기본형」 — 결정 대기.
  - 한계: 표본 구성상 F03 전체 일치율로 일반화하지 않는다. 일치는 이름 일치이며 생산기간·연료·인승 연결까지 보증하지 않는다. 불일치는 고치지 않았다(AI 상황실 결정 대기).

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

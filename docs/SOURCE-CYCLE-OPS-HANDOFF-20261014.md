# 원천 엔진 운영 인계 — 2026-10-14 (B3Q 유지보수 세션)

대화에만 있던 결정·운영 방식을 남긴다. 정본 상세는 각 코드·PR 이 우선이고, 이 문서는 «다음 세션이 같은 곳에서 헤매지 않게» 하는 지도다.

## 1. 오토플러스(RP023) — 시트 우선, 홈피 보조
- 대표 2026-10-14: 오토플러스 정본 = 공급사 원본 구글시트(「New 오토플러스 재고 리스트」 판매 탭 + 전기차 프로모션 탭), 홈페이지는 보조 교차.
- 구현: `src/adapters/autoplus-sheet.ts` + `source-cycle-runtime.ts` 의 `SOURCE_CYCLE_AUTOPLUS_SHEET=1`·`SOURCE_CYCLE_AUTOPLUS_SHEET_ID`(시트 ID 는 저장소에 두지 않고 운영 PC 개인 env 에만). 기본 꺼짐.
- 상태 매핑: 판매중·할인판매·상품대기 = 판매 가능 / 상담중·계약중·보류 = 불가 / 모르는 값 = 보류. 요금 열 «<개월>개월 <1|2|3>만km».
- 안전선: 시트 읽기 실패·탭 없음·중복·행 수 하한(잠금 제외 노출 수·직전 행 수의 80%) 미달 → 쓰기·부재 하향 0. 계약 잠금(LEDGER·정산원장·status 계약중)은 보존.
- 사이트맵 하한(홈피 어댑터)은 잠금·계약중 노출 문서를 뺀다(#583).

## 2. 사진은 «photo_cache.urls»만 이미지로 읽힌다
- 배포 `/api/catalog` 의 imageUrl 은 `photo_cache.urls`(또는 image_urls)에서 나온다. `photo_link` 만 있으면 사진 없음이다.
- 이안카(RP031)는 목록 imageUrl 이 없고 `photoPending=true`(상세에서 앨범 리졸버) — «사진 없음» 통계에 섞지 않는다.
- 연결 도구(운영 PC 에서 `dist` 빌드 후 실행, 쓰기 전 비공개 백업·updateTime 조건·되읽기):
  - `scripts/ops/photo-cache-from-folder.mjs --apply --code=RPxxx` — 문서 `photo_link`(Drive 폴더) → 폴더 이미지 → 썸네일 w640 최대 10장.
  - `scripts/ops/photo-cache-iron.mjs --apply` — 아이언 사이트맵 상세 전수 → 차량번호로 매칭 → supabase 공개 버킷 사진.
- 사진이 없는 차의 유형: 정책상 제외(아이카) / 공급사 미제공(시트 폴더 링크 없음) / 설계상 지연(이안카) / 연결 결함(고쳐야 함).

## 3. 차종 정정 경로 제약 (repair:vehicle-name-parity)
- 한 상품은 한 계획에서 정체성(maker/model/sub_model)과 세부트림 정정을 겹쳐 받을 수 없다 → 계획 둘(정체성 → 세부트림).
- products.trim_name 빈칸 채움은 공급사 원문 근거(evidence)가 있을 때만(#584).
- ★ERP4 수집 엔진의 차종 사전은 프리패스 데이터 마스터가 아니라 ERP4 저장소 `public/data/vehicle-master.json`(옛 이름, 09-08) 이다. 문서를 프리패스 데이터 이름(아이오닉 5 NE·아르카나 LJL…)으로 바꾸면 엔진 후보와 어긋나 IDENTITY_CONFLICT/MASTER_UNMATCHED 가 된다. 근본 해결 = 스냅샷을 프리패스 데이터 마스터에서 다시 만들기(후속 A). 임시로 3행을 값 그대로 갱신(freepasserp4 #586).
- 연식이 겹치는 세대(더 뉴 아반떼 CN7 2023~2026 / 아반떼 CN8 2026~)는 원문 «신형»만으로 특정하지 않는다(확인 필요, 확인 동선 EN1-C1014-97988eb5).

## 4. 아이언(RP006) 승격
- approveAll 설정은 코드 변수가 아니라 `scripts/ci/rp012-approved-plates.json`(freepasserp4)에 있다(#585). 원장은 `ops/rp006_registration_ledger` 로 RP012 와 분리.
- 승격 대기(INFO_INCOMPLETE) 문서를 번호 우선으로 노출해야 할 때: 계획 → 백업 → updateTime 조건 → 한 건씩 되읽기 로 `listable=true, registration_state=PROMOTED, status/vehicle_status=원천 라벨, status_kind=가용` 으로 올린다(2026-10-14 7대). 확인 필요 표식은 `vehicle_name_confirm_needed`.
- 판매완료(원천 상세 라벨)인데 노출된 차는 `publication_withdrawal{reason: SOURCE_SOLD_HOMEPAGE}` 로 내린다.

## 5. 운영 설정(비밀 제외)
- 이안카 RP031 단독 잠: 60분 간격(:05 KST), 정시 전체 회차는 :00.
- 손오공 로그인 0 유지(`SONOGONG_COLLECT_ENABLED=false`), RP012 는 관측 전용.
- 엔진 교체 시: 실행 중 node 프로세스가 없을 때 `git checkout --detach origin/main` → `tsc -p tsconfig.json`, 직전 커밋을 `fd-cycle-prev-commit.txt` 에 기록.
- 중지(연속 실패 3회) 상태 초기화는 해당 원천 `*.state.json` 의 failures/stopped 를 되돌리되 백업(`.before-reset-날짜`)을 남긴다.

## 6. 열린 후속
- 마스터 비차단 편입(rp006/rp012 정보 부족 판정에서 마스터 계열 사유를 matchState 표시로 이동).
- ERP4 스냅샷 정본 투영 재생성(A) + diff 한 장.
- 오토플러스 시트 사진: 시트 차량번호 칸 하이퍼링크 부재 — 신규 2대 사진은 공급사 확인.
- 정시 회차 대사 결과 한 줄 업무방 기록 경로.

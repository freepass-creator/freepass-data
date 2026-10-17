# 원천 엔진 운영 인계 — 2026-10-14 (B3Q 유지보수 세션)

대화에만 있던 결정·운영 방식을 남긴다. 정본 상세는 각 코드·PR 이 우선이고, 이 문서는 «다음 세션이 같은 곳에서 헤매지 않게» 하는 지도다.

## 1. 오토플러스(RP023) — 시트 우선, 홈피 보조
- 대표 2026-10-14: 오토플러스 정본 = 공급사 원본 구글시트(「New 오토플러스 재고 리스트」 판매 탭 + 전기차 프로모션 탭), 홈페이지는 보조 교차.
- 구현: `src/adapters/autoplus-sheet.ts` + `source-cycle-runtime.ts` 의 `SOURCE_CYCLE_AUTOPLUS_SHEET=1`·`SOURCE_CYCLE_AUTOPLUS_SHEET_ID`(시트 ID 는 저장소에 두지 않고 운영 PC 개인 env 에만). 기본 꺼짐.
- 상태 매핑(#628 갱신): 판매중·할인판매·상품대기 = 판매 가능 / 계약 계열(계약중·상담중·예약·선점 등) = «계약중» 노출 / 보류·판매완료·출고완료·판매불가·출고불가 = 불가 / 모르는 값·빈칸 = 보류(그 회차 부재 하향 생략). 요금 열 «<개월>개월 <1|2|3>만km».
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
- 엔진 교체 시: §7 «엔진 교체 절차»를 따른다(순수 `tsc` 만 돌리면 안 된다 — 2026-10-17 사고).
- **ERP5-CARD 이름 정정 적용 스크립트는 기본값이 시험(쓰기 없음)이고, 쓰기는 `--apply` 가 있을 때만 한다**(2026-10-17 사고: 시험용 `--no-window` 실행이 r2-01 을 실제 적용함, 커맨드 센터 지시). 수동 plan 반영 스크립트(`RUN_PLAN`)도 기본 끔이며, 수동 plan 은 원천을 다시 읽고 RAW·관측 상태를 저장한다(상품 변경만 없음).
- 중지(연속 실패 3회) 상태 초기화는 해당 원천 `*.state.json` 의 failures/stopped 를 되돌리되 백업(`.before-reset-날짜`)을 남긴다.
- **신선도 면제(`SOURCE_CYCLE_FRESHNESS_EXEMPT`)는 근거와 기한 없이 두지 않는다**(커맨드 센터 2026-10-17). 값 형식 `원천=사유>해제조건원천` 의 해제 조건(`>RPxxx`)이 없으면 영원히 풀리지 않고, 그동안 그 원천의 STALE·ERROR·정체·에스컬레이션 경보가 전부 꺼진다. 쓰려면 사유·승인자·기한을 이 문서에 적는다.
- **손오공(RP012) 신선도 임계 = 정체 135분·에스컬레이션 240분**(`SOURCE_CYCLE_FRESHNESS_THRESHOLDS = 'RP012=135:240:SONOGONG_API_STAGNANT'`, 2026-10-17 커맨드 센터 승인). 근거: 회차 1시간·최소 읽기 간격 45분 구조에서 읽기 위치가 늦게 잡힌 다음 회차는 간격 보류로 건너뛰므로, 정상 엔진에서도 관측 간격이 약 10회에 한 번 90분을 넘는다(최근 48시간 44회 중 90분 초과 4회, 중앙값 60분, 구조 최악 ≈120분). 90분 기준은 이 최악보다 낮아 오경보를 낳았다.
- **옛 면제 `RP012=SONOGONG_LOCKED` 제거**(2026-10-17, 백업 `env.ps1.before-sono-exempt-20261017`): 10-14 손오공 API 전환 때 들어간 일시 조치(예외 기능 커밋 2cd4ba6e, 전환 문서 SONOGONG-API-ENGINE-SWITCH-20261014.md 31행 «첫 정상 회차에서 자연히 빠진다»)였고 해제 조건이 없어 90/180 정체 경보를 가렸다. 이 줄 자체의 승인 기록은 찾지 못했다. 같은 날 17:07 에 RP012 가 90분(STALE)을 넘었으나 면제로 신선도가 HEALTHY 로 나와 경보가 열리지 않았다. 읽기 전용 평가(assessFreshness, 실제 하트비트): 관측+100분 FRESH, +140분 정체 경보·UNHEALTHY, +250분 에스컬레이션 — 옛 설정은 같은 구간 내내 HEALTHY.

## 7. 엔진 교체 절차 (2026-10-17 사고 뒤 확정 — 커맨드 센터 지시)

2026-10-17 15:48 #732 교체 때 `dist-new` 를 `tsc` 만으로 빌드해 `npm run build` 의 두 번째 단계(복사)가 빠졌다 → 런타임이 `dist/scripts/supplier-input-sheet.mjs` 를 못 찾아
ERR_MODULE_NOT_FOUND 로 사전점검 전에 종료(기록 없음, 예약 작업 결과 1), 15:50 감시 회차 실패. 복사 대상 4파일: `dist/scripts/supplier-input-sheet.mjs` · `dist/scripts/sheet-presentation.mjs` ·
`dist/contracts/supplier-input-sheet-spec.v1.json` · `dist/contracts/f01-f86-sheet-spec.v1.json`.

1. 회차 미실행 확인: `source-cycle-runtime` node 프로세스 0 (정시 :00·감시 :50 ±10분은 피한다).
2. 직전 커밋 기록: `git rev-parse HEAD > <비공개 디렉터리>/fd-cycle-prev-commit.txt`.
3. `git fetch origin main && git checkout --detach origin/main`.
4. **빌드는 `npm.cmd run build` 전체**(tsc + 4파일 복사). 라이브 공백을 줄이려면 `npx tsc -p tsconfig.json --outDir dist-new` 뒤 같은 4파일을 `dist-new` 에 복사하고
   이름 바꾸기(`dist` → `dist-prev-<커밋>`, `dist-new` → `dist`).
5. **읽기 전용 import 되읽기**(필수): `node -e "import('file:///C:/dev/fd-cycle/dist/src/runtime/source-cycle-runtime.js').then(()=>console.log('import ok'))"` — 모듈 누락 0.
6. 수동 plan 1회(쓰기 없음): `node dist/src/runtime/source-cycle-runtime.js --plan <파일> --source RP013` 이 DRY_RUN 과 identityRefine 로드를 보이면 통과.
7. 이전 `dist-prev-<커밋>` 은 다음 회차 정상 확인까지 보존(되돌림 = 이름 바꾸기).
8. 교체 사실·시각·커밋·백업 이름을 커맨드 센터와 수집 Codex 채널에 한 줄 통보(운영 dist SHA 변경을 «원인 불명 drift»로 오인하지 않게).

## 6. 열린 후속
- 마스터 비차단 편입(rp006/rp012 정보 부족 판정에서 마스터 계열 사유를 matchState 표시로 이동).
- ERP4 스냅샷 정본 투영 재생성(A) + diff 한 장.
- 오토플러스 시트 사진: 시트 차량번호 칸 하이퍼링크 부재 — 신규 2대 사진은 공급사 확인.
- 정시 회차 대사 결과 한 줄 업무방 기록 경로.

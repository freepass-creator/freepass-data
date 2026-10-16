# 원천 엔진 3단계 — 운영 runtime 연결 (지휘통제실 → Codex, 2026-10-12)

목표(대표): 원천 판매 가능 N = 프리패스 데이터 N = ERP5 N, 다른 공급사 0곳을, 사람 손 없이 15분마다 유지. 2단계 사이클(src/**/source-cycle*.ts, 합성 시험 41)은 오프라인이다. 이번에 «운영 runtime»과 «실제 원천 캡처 매핑»을 만든다. 정본: SOURCE-ENGINE-SPEC2/RESULT2, DESIGN-REF. 사전점검 영수증은 SPEC 끝 것으로 갈음(네트워크 없음, 외부 도구 실패는 건너뜀).

## 만들 것
1. `src/runtime/source-cycle-runtime.mjs`(또는 .ts 빌드 산출): 결과 문서 «연결 담당이 검토한 로컬 ES 모듈 {plugins, commands, control}» 계약 그대로. `commands` = Firestore REST(gcloud 사용자 토큰, 기존 도구 참고: C:\dev\freepass-data\.claude\worktrees\supplier-collection-freshness-c13097\scripts\exposure-apply.mjs 의 getDoc·PATCH·currentDocument.updateTime 조건부 쓰기·백업 파일·되읽기 모양을 따를 것) — 전체 상품 조회(provider_company_code·listable·status 등 필요한 칸만), 백업(비공개 로컬 폴더 ~/.codex/private/…), 상품 쓰기: 하향(listable=false·status 출고불가·status_kind 불가·publication_withdrawal+prior), 재노출, 신규 편입(새 문서), 조건 갱신(price 맵·보증금). 문서 삭제 없음. 되읽기는 키 순서 무관 깊은 비교.
2. UID 규칙(대표 결정 «한 줄이 한 대»): 차량번호가 있는 줄 UID = 기존 상품 문서 ID 규칙과 동일(문서 ID = 차량번호, 공급사 코드는 provider_company_code 칸). 차량번호가 없는 줄(신차·미정) = 시트 UID 열이 있을 때만 그 값, 없으면 HOLD(UID_REQUIRED, 판매 가능 수에는 «번호미배정 N»으로 따로 표시). 행 번호로 UID 를 만들지 마라. 같은 차량번호 2줄 = 중복 의심 표시, 첫 줄만 편입.
3. 실제 원천 캡처 매핑(plugins): F05 = 기존 capture-shared-sheet(읽기 전용) 결과 + 행 숨김 메타데이터(spreadsheets.get includeGridData rowMetadata hiddenByUser·hiddenByFilter) — 보이는 공급사 12탭만, «종합»·숨김 탭 제외, 숨긴 줄·출고불가 제외 / 아이카 = 별도 시트 «(수정본)아이카 장기차량 리스트»(장기특별이벤트·신차선출고·중고재렌트 열: A 배차상태·B 구분·C 차량번호…, 월렌트는 별도 상품군) / 이안카 = ONE API(AVAILABLE·PREPARING, 열쇠는 프로세스 환경변수 EANCAR_ONE_API_KEY 로만) / 손오공·오토플러스 = 기존 수집기가 프리패스 데이터에 반영한 결과(source=sonokong·website 문서)를 표준 캡처로 읽는 «관측 전용» 플러그인(쓰기 없음, 대수 하트비트만) / 아이언 = 홈피 게시 목록. 시트 ID·열쇠는 환경변수로만 받고 저장소에 쓰지 않는다.
4. 신규 편입 문서의 칸: 기존 수집기가 만든 문서와 같은 칸 이름(car_number, provider_company_code, maker/model/sub_model/trim_name 또는 원문 차명 칸, price{기간:{rent,deposit}}, status/status_kind/vehicle_status, listable, source, source tab/row 추적 칸, 원문 보존). 차종은 원문 그대로 두고 판정 불가면 비움+확인 필요 표식(대표 원칙: 원문은 고치지 않고 차종만 정리). 기존 products 문서 1개를 읽어 칸 이름을 확인해 따라라(C:\dev\freepass-data 에서 로컬 파일로 확인 불가하면 테스트 픽스처를 근거로).
5. 시험: runtime 의 commands 를 가짜 Firestore(메모리 HTTP 서버 또는 주입 fetch)로 시험 — 조건부 쓰기 충돌·되읽기 오탐 없음·백업 되읽기·계약 잠금 불변·UID 중복·번호 미배정 HOLD. 라이브 연결 시험은 하지 말 것(내가 한다).
6. 실행 명령 한 장: 시험 실행(dry-run) 명령, 적용 명령(승인 digest 외부 입력), 환경변수 목록(이름만), 되돌리기 명령. docs/SOURCE-ENGINE-RESULT3-20261012.md 에 변경 파일·시험 숫자·남은 일·next_start_here.

## 규칙
이전 지시서의 금지·보고 규칙 그대로(운영 쓰기·push·schtasks 실제 등록 금지). 커밋은 하지 않아도 된다.

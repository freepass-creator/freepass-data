# 규격 검증 단계 — 운영 메모 (2026-10-16, 커맨드 센터 승인)

설계: `docs/SONOGONG-SPEC-CONFORMANCE-20261016.md` §3. 기본 **꺼짐**, 원천별로 켠다.

- 켜기: 환경변수 `SOURCE_CYCLE_SPEC_VALIDATION_SOURCES=RP012`(쉼표 목록, 현재 구현은 손오공 RP012 플러그인만 연결). 끄기: 변수 제거.
- 동작(쓰기 직전, 계획 단계): 레코드의 `raw.spec` 칸 형식(연료 8종·연식 4자리·최초등록 실제 날짜·배기량 3~5자리 정수·전기/수소 배기량 금지·주행거리 정수·인승 정수·색 ≤20자)과
  보증금(원 단위 정수, 양수는 1만원 이상·1억 이하)을 검사해 **위반 칸만** 뺀 복사본으로 계획한다. 보증금 위반은 그 항을 UNKNOWN 으로 두고 원천 값은 `terms[].raw.deposit_rejected` 에만 남긴다.
  원문(`raw.list`·`raw.detail`)과 기존 문서 값은 건드리지 않는다. 값을 고쳐 쓰지 않는다.
- 경고 줄: `SPEC_VIOLATION:<필드>:<건수>`(번호 없음). 회차 요약 경고에 합산된다.
- 회차 보류: 위반 레코드가 읽은 차의 20% 를 넘고 5건 이상이면 `SPEC_FORMAT_DRIFT` 차단 — 쓰기 0, 원천 형식 변경 의심(공급사 응답 형식 확인 후 규칙 또는 어댑터 조정).
- 알려진 한계: 입력 정의는 점검 보고(`report:sonogong-conformance`)의 `SONOGONG_CHECKS` 와 같은 규칙이지만 코드는 두 군데(`src/domain/source-spec-validation.ts`, `src/application/sonogong-spec-conformance.ts`)에 있다 — 규칙을 바꾸면 두 곳을 함께 바꾼다(시험이 기준 값을 고정).
- 손오공 API 는 구동·변속기·인승·출고 가능일을 구조 필드로 주지 않는다(B3Q 전수 확인, 355문서) — 입구 매핑 칸에 넣지 않고 차종 마스터에서 가져오는 쪽으로 간다.

# 원천 엔진 #577 변경 요약과 운영 적용 현황 (2026-10-14)

> PR #577 은 크다(main 대비 약 48커밋). 합침 후 **되돌리기 단위는 기능별 커밋**이다. 아래 표는 기능별로 묶은 목록이다.
> 시험: 전체 `vitest` 3360 통과 · 7 실패. 7건은 모두 이 변경과 무관한 환경 건이다
> (`jq` 없음, 5초 시간 초과: runtime-policy·runtime-baseline-deployment·read-runtime-*; 단독·다른 PC 에서 통과).

## 엔진 수정 목록

| 기능 | 커밋 | 목적(실사고·근거) | 주요 시험 |
|---|---|---|---|
| 엔진 골격·사이클·운영 runtime | 91eff5e·3ac8cb2·679c779·a044f43 | 표준 레코드·계획→승인 digest→전체 백업→CAS→되읽기, 3회 실패 정지, 여섯 원천 native 캡처 | source-engine·source-cycle |
| 월렌트 1개월 상품군 편입 | 9a2cb82 | 아이카 월렌트 탭(번호 없는 모델 줄)을 판매 가능 상품으로 편입(대표 10-13 장부 620행) | source-cycle-runtime(AICA) |
| 가격 맵 정규화·보정 허용 | 2dd618d·9db9c43·9ca4308·ea739d7·2eaf65b | 키 순서·mileage 표시만 달라 DRIFT 오판, 코드별 가격 보정 승인과 digest 재동기화 | source-cycle-runtime(drift) |
| 신규 편입 원문 차명 보존 | e90ca4d | 마스터 미특정 편입의 ERP5 제목 «차량 정보 확인 필요» 방지 | source-cycle-runtime |
| 무인 1시간 회차 | 3978a00·f99ab3e·fbaa696 | ERP5 1시간 자동 반영, 사전점검(PREFLIGHT_*), TypeScript 한 흐름 | source-cycle-runtime(unattended) |
| 신선도 감시 | 25fba0c·1ac7afd | heartbeats 기준 원천별 마지막 정상 완료 나이, 공급사별 노출 전후 기록 | source-freshness |
| 계획 가드 | 7596dc1·a9d5d18 | 보증금 UNKNOWN 은 KNOWN/ZERO 보존, 하향 비율 사유별 분리, 알 수 없는 회사명 보류, 가격만 다른 문서는 쓸 때만 차단 | source-cycle |
| 경진 별칭 | aa5c4ff | 경진 탭 회사명 «경진렌트» → RP015 별칭(대표 승인 10-13) | shared-sheet-source |
| UID 연결·약정거리·읽기 세부 코드 | 3fc7aa1·f629ad6·062b429 | 같은 번호 옛 ID 문서 연결, 이안카 96/96 보류 해소, READ_FAILED 원인 코드 | source-cycle·source-engine |
| 단일 읽기·압축 레코드 | fb29f2e·1cbf7c2 | 재읽기 불일치 중단 해소, 문서 1MiB 초과·반쯤 적용 사고 수정 | source-cycle-runtime |
| 대표 지시 공급사 내림 | a54253b | 에스에이(PT-0023) 10대 출고불가를 엔진 결정으로 반영·재노출 방지 | source-cycle-runtime(DECISION) |
| 옵션 가격 키·상류 정지 | 8753778 | 소비처가 읽는 옵션 키 복원, UPSTREAM_STALE 은 연속 실패로 세지 않음 | source-cycle-runtime |
| 잠금 인계 | 940440e | 죽은 프로세스의 잠금만 인계(원천이 «중복 회차 생략» 으로만 지나가던 사고) | source-cycle-control |
| 관측 전용 원천 신선도 | c709070·0d06efb·a75e511 | 손오공·오토플러스: 수집기 최종 갱신·ERP4 수집 단계 성공 시각 근거, 24시간 한정 임시 오탐 표기 | source-freshness·erp4-collection-evidence |
| 시트 읽기 실패 원인 | 991242d | gws 시간 초과·종료 코드·HTTP 상태를 코드로, 일시 오류 재시도 | capture-shared-sheet-retry |
| status_kind 계약값 | 14c59cf·888b009·fb7952f | 표시 상태로 결정·값이 같아도 한 번 다시 씀·목록 필드 마스크에 vehicle_status 포함 | source-cycle-runtime(마스크 적용 모의) |
| DETAIL_SOURCE_DRIFT 소프트 보류 | 294faad | 상세 읽기 중 신선도 창 초과로 이안카가 연속 3회 정지되는 것 방지 | source-cycle-runtime |
| 6시간 상한 escalate | c9f6676 | 소프트 보류가 조용히 계속되지 않게 신선도 보고에 escalate 목록 | source-freshness |
| 다시 쓰기 사유 정리·월렌트 product_type | 32399fd | `rewriteReasons` 한 곳으로 정리, 월렌트 모델 문서 product_type 쓰기(**기본 꺼짐**) | source-cycle-runtime |
| 아이카 안내 행 제외 | e84a7e3 | 번호·차종·트림·요금이 모두 빈 안내 문구 행이 «번호 미배정»으로 세어져 RP004 부재 하향이 막히던 사고 | source-cycle-runtime(AICA) |
| 문서·체크리스트 | 677b7f3·816600d·1fe95eb·f2a45bb | 이안카 갱신 주기 결정, 실데이터 계획 선확인 체크리스트, SPEC 번호 마스킹 | — |
| 월렌트 어휘 확장 | (#579 로 분리) | main 에 bc42300c 로 합쳐짐, 이 가지에서는 c3da011 로 되돌려 정본 경로 중복 해소 | erp5-product-mapping |

## 운영에 이미 적용돼 도는 것 / 아직 안 도는 것

| 항목 | 상태 | 근거·조건 |
|---|---|---|
| B3Q 엔진 체크아웃 | **도는 중**: e84a7e31(detached) | 21:00Z 회차 RP004 하향 11건 적용 예정, 합침 후 main 으로 이전 |
| 무인 1시간 회차(예약 :00) | 도는 중 | 임계 15분 유지, 이안카 읽기 시점 확보를 위해 :25 → :00 |
| status_kind 정정(28건+5건) | 적용 완료 | 드리프트 0 재스캔 |
| 월렌트 product_type 쓰기 | **꺼짐**(`SOURCE_CYCLE_WRITE_MONTHLY_PRODUCT_TYPE` 미설정) | 어휘 확장(#579) 합침됨, 쓰기는 plan 선확인 결과와 함께 별도 승인 |
| 신선도 근거 교체(수집 단계 성공 시각) | 도는 중 | `SOURCE_CYCLE_ERP4_REPO` 설정, 실패 시 문서 시각 폴백 |
| 임시 오탐 표기 | 미사용 | `SOURCE_CYCLE_STALE_FALSE_POSITIVE` 미설정 |
| ERP4 풀 회차 누락 보완(`scripts/ensure-erp4-round.ps1`) | **안 도는 중**(예약 미연결) | 기본 읽기 전용, 발송은 별도 승인 후 |
| 이안카 읽기 시간 단축·상류 감지 읽기 | 검토 중 | 상세 읽기 약 5분이 신선도 창을 넘기는 근본 원인 |

## 합침 후 검증 절차

1. B3Q 엔진 체크아웃을 detached e84a7e31 → main 으로 이전한다(예약 회차 사이).
2. 이전 직후 한 회차: exit·freshness·쓰기 0 또는 설명 가능한 UPDATE·총 노출 변화 0 확인, 이상 시 e84a7e31 로 원복.
3. 쓰기 경로를 바꾸는 후속 수정은 [엔진 변경 시험 체크리스트](SOURCE-ENGINE-UNATTENDED-20261013.md)의 «실데이터 계획 선확인»을 따른다.

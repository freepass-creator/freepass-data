# shared-sheet-daily 예약 적용 연속 실패 — B안(적용 단계 라이브 재계획) 설계

> 2026-10-16 · 유지보수(B3Q) 작성 · 1번 커맨드 센터 지시 «선택지 B 권고안으로 설계 PR 준비, 적용은 관문 뒤».
> 이 문서는 **설계만** 담는다. 코드·워크플로 변경은 이 문서의 승인(데이터 소유 담당 판정) 뒤 별도 PR 로 올린다.

## 1. 현상과 원인(수집 15분 세션이 확정, 읽기 전용 대조)

- 증상: `shared-sheet-daily` 예약 적용이 2026-10-11 22:15Z 이후 전 회차 실패(최신 확인 10-15 23:52Z 도 실패).
- 원인: 적용 단계 사전 점검(`preflightSharedSheetApply`)이 `prepared(plan.capture, …)` 를 통해
  `scripts/supplier-input-sheet.mjs` 의 `vehicleMasterSnapshotRows(master, now)` 를 부르고, 이 함수가
  **계획에 박제된 차종 마스터 스냅샷(`readAt`)이 now 기준 5분(300000ms)을 넘으면** `HOLD: Active Data vehicle master snapshot required`
  (현재 코드 `VEHICLE_MASTER_SNAPSHOT_STALE_OR_INCOMPLETE`) 를 던진다.
  예약 회차는 «캡처·계획» 단계 뒤에 «라이브 재캡처 → 적용» 단계가 오고, 계획 후 적용 사전 점검까지 305~390초가 걸려 5분을 넘긴다.
- 이미 반영된 완화: #571·#599(사유 코드 노출), #576(운영 갱신 관측 상한 900→3600초).

## 2. 지키는 불변식(바꾸지 않는다)

1. «만료된 계획의 마스터 스냅샷은 갱신하지 않는다» (커밋 8bc4d786 시험) — 승인된 계획의 증거를 사후에 바꾸지 않는다.
2. 운영 갱신(`operationalRefresh`) 계획은 관측 시각이 상한(3600초)을 넘으면 거절한다.
3. 수동 승인 계획(`reviewed_*` 입력) 적용 경로의 의미: 사람이 검토한 digest 와 같은 계획만 적용한다. 이 경로는 이 설계가 건드리지 않는다.
4. 사람 입력·확정값 보존, 계약 잠금 비접촉, 쓰기 전 백업·되읽기.

## 3. 선택지

| 안 | 내용 | 장점 | 단점 |
|---|---|---|---|
| A | 예약(operationalRefresh) 계획에 한해 «계획 자신의 증거 시각»(캡처·마스터 readAt 최댓값)을 기준 시계로 사용 | 변경 작음 | 시험 ①(만료 계획 마스터 비갱신)·②(15분 초과 관측 거절)의 기대를 바꿔야 함. 변경 후 되돌림을 digest 가 못 잡음 |
| **B(권고)** | **예약 회차만** 적용 단계에서 라이브 캡처로 계획을 **새로 만들고 5분 안에 적용** | 불변식 ①②③ 유지(계획은 항상 신선), 수동 승인 의미 유지 | 적용 단계가 재계획을 한 번 더 수행(시간·읽기량 증가) — 단축 병행 필요 |

## 4. B안 상세

### 4.1 흐름(예약 회차 한정)

```
[기존] 캡처·계획(no write) → (대기) → 라이브 재캡처 → 적용(계획 digest 승인)
[B안] 캡처·계획(no write, 보고용) → 라이브 재캡처 → ★재계획(같은 프로세스에서 새 계획·새 digest) → 즉시 적용
```

- 재계획과 적용은 **같은 프로세스·같은 마스터 스냅샷**을 쓴다: 마스터 `readAt` 이후 5분 안에 사전 점검·적용이 끝나야 한다.
- 새 계획의 digest 를 그 자리에서 계산해 `--expected-plan-digest` 로 넘기되, **사전 점검의 5분 검사는 그대로 둔다**(스냅샷이 신선하므로 통과).
- 재계획 결과가 앞선 «보고용 계획» 과 다르면(항목 수·차량 구성 변화) 보고에 `REPLANNED_DIFFERENT` 와 차이 건수만 남긴다(번호 없음).

### 4.2 바꾸는 곳(최소 범위)

1. `src/jobs/ingest-shared-sheet-canonical.ts`: 새 CLI 플래그 `--replan-then-apply`(기본 꺼짐).
   `--live-capture` 와 함께 쓰면 `planSharedSheetCanonical(store, liveCapture, target, …, operationalRefresh=true)` 로 새 계획을 만든 뒤
   같은 호출 안에서 `runSharedSheetCanonical({ apply:true, plan, expectedPlanDigest })` 를 수행한다.
   - 수동 승인 입력(`--plan`+`--expected-plan-digest` 가 사람이 준 값)과 **동시에 쓸 수 없음**(`REPLAN_CONFLICTS_WITH_REVIEWED_PLAN` 로 거절).
2. `.github/workflows/shared-sheet-daily.yml`: 예약(`schedule`) 이벤트 분기에서만 위 플래그를 사용. 수동 `workflow_dispatch apply` 는 기존 그대로.
3. 사전 점검 중복 단축(병행 개선, 별 PR 가능): `preflightSharedSheetApply` 가 `planSharedSheetCanonical` 을 한 번 더 부르는 부분과
   RAW 적재·`listOffers` 구간의 계측을 먼저 넣어 305~390초가 어디서 쓰이는지 구간별로 남긴다.

### 4.3 위험과 방어

| 위험 | 방어 |
|---|---|
| 재계획이 사람이 검토하지 않은 계획을 쓰기에 사용 | 예약 회차는 원래 «자동 계획 → 자동 적용» 이다. 쓰기 범위는 `operationalRefresh`(상태·기존 기간 월료)로 한정, 주행거리·보증금·한도 변경은 계획 단계 보류(#668) |
| 5분 안에 적용이 끝나지 않음 | 재계획 직후 시작하므로 적용 단계 소요(재계획·사전 점검·적용)가 5분을 넘으면 같은 사유로 HOLD — 계측으로 확인, 단축이 안 되면 4.2-3 의 단축을 선행 |
| 이중 적용 | 기존 멱등 키·`SHARED_SHEET_HEAD_CHANGED` 검사 그대로 |
| 롤백 | 플래그 기본 꺼짐: 워크플로에서 인자 제거 한 줄로 이전 동작 복귀 |

### 4.4 시험(구현 PR 에 포함)

- 신선도: 계획 후 305초가 지난 계획은 기존대로 `VEHICLE_MASTER_SNAPSHOT_STALE_OR_INCOMPLETE`(불변식 ①), `--replan-then-apply` 는 같은 시각에서 통과.
- 수동 승인 계획과 `--replan-then-apply` 동시 사용 거절.
- 재계획 결과가 이전과 다르면 보고에 `REPLANNED_DIFFERENT` 만 남고 번호·식별자 없음.
- 운영 갱신이 허용하지 않는 변경(주행거리 등)은 재계획에서도 계획 단계 보류(#668 불변).
- `readbackMismatches` 가 0 이고 `committed > 0` 인 예약 회차 한 건(합성 데이터).

## 5. 판정 요청

- 데이터 소유 담당(00): 본 B안 채택 여부. A안이 필요한 사유(시험 ①② 기대 변경 감수)가 있으면 이 문서에 병기.
- 채택 시 구현 PR 은 4.2 의 1·2 번을 한 PR, 3 번(계측·단축)을 별 PR 로 올린다. 적용(예약 활성)은 Codex 읽기 관문 뒤.
- 확인 방법: 반영 뒤 다음 예약 회차의 `apply.json` 이 `APPLIED` 또는 `PARTIAL_HOLD` 이고 `reconciliation.readbackMismatches=0`.

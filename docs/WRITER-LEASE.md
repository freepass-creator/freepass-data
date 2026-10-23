# 쓰는 쪽 하나 (writer lease)

대표/PC1 커맨드 2026-10-23. 같은 쓰기 실행기가 두 PC 에서 동시에 돌지 않게, 예약을 끄고 켜는 대신 «임대»만 넘긴다. 기본 꺼짐.

## 설계 요지
- 프리패스 데이터에 `writer_leases/<레인>` 문서 하나씩: `holder`(PC 이름) · `epoch`(넘길 때마다 +1) · `expiresAt` · `ttlMin`(기본 180).
- 레인 = 실행기 묶음 이름: `source-cycle`(시간당·F05·RP031 무인 회차), `photo`(사진 단계), 마음카 등은 필요할 때 레인을 더한다.
- 무인 회차는 시작에 임대를 확인한다(`runtimeCli --unattended` 앞). 내 PC 면 통과(남은 시간이 절반 이하면 갱신), 아니면 쓰기 0 으로 끝나고 `lease-skips.jsonl` 에만 남는다(종료 코드 0, 실행 기록·신선도 판정은 건드리지 않음).
- 닫힘: 임대 문서가 없거나, 읽지 못하거나, 손상됐거나, 설정(레인·PC 이름)이 빠졌으면 쓰지 않고 종료 코드 1 + 알림.
- 남의 임대는 만료돼도 자동으로 가져오지 않는다. 가져오려면 명시 인수(`claim`, 만료일 때만)나 현재 보유자·에포크를 지정한 이전(`transfer`).
- 모든 임대 쓰기는 문서 `updateTime` 조건부(동시 인수 충돌은 실패), 쓴 뒤 되읽기.
- 사진 단계(`run-source-cycle.ps1`)는 `photo` 레인(`WRITER_LEASE_PHOTO_LANE`)을 따로 확인한다.
- 시간 기준은 이 PC 시계가 아니라 Firestore 서버 응답의 `Date` 헤더(시계 오차로 조기 인수·고착 방지). 헤더가 없으면 쓰지 않는다.
- 원천마다 시작 전에 임대를 다시 확인한다(도중에 넘어가면 남은 원천은 쓰지 않고 `WRITER_LEASE_LOST`, 종료 코드 1). 수동 `--apply`·`--rollback` 도 같은 조건을 따른다.
- 임대 문서가 아예 없으면 `WRITER_LEASE_MISSING`(종료 코드 1 + 알림). `WRITER_LEASE_ENFORCE` 는 `1`(켬)·`0`/없음(끔)만 허용하고 그 밖의 값은 닫힘.
- 한계(알려진 것): ① 이미 시작한 원천 하나는 끝까지 간다(문서 쓰기는 각각 `updateTime` 조건부라 데이터는 안전) — 전환은 회차 사이(정시 직후)에. ② PC 이름·레인은 자기신고라 두 PC 가 같은 이름을 쓰면 둘 다 통과한다 — 이름은 PC 마다 다르게. ③ 손상된 임대 문서는 자동 복구가 없다(커맨드가 콘솔에서 고친다). ④ `ENFORCE` 를 켜지 않은 실행기는 막지 못한다(켠 뒤 `lease-skips.jsonl`·실행 기록으로 확인).

## 켜는 방법 (실행기의 비공개 env 파일)
```
$env:WRITER_LEASE_ENFORCE = '1'
$env:WRITER_LEASE_LANE = 'source-cycle'      # 이 실행기의 레인
$env:WRITER_LEASE_PC = 'PC3'                 # 이 PC 의 이름(대문자·숫자·하이픈)
# $env:WRITER_LEASE_TTL_MIN = '180'          # 선택
```
빌드 후 `dist\src\jobs\writer-lease.js` 로 운영한다(개발 중에는 `npx tsx src/jobs/writer-lease.ts …`).

```
node dist/src/jobs/writer-lease.js status --lane=source-cycle
WRITER_LEASE_WRITE_APPROVED=true node dist/src/jobs/writer-lease.js claim --lane=source-cycle --pc=PC3          # 없을 때 만들기
WRITER_LEASE_WRITE_APPROVED=true node dist/src/jobs/writer-lease.js transfer --lane=source-cycle --from=PC3 --to=PC1 --epoch=<status 의 epoch>
```
인수·이전은 커맨드 승인 뒤에만 한다(`WRITER_LEASE_WRITE_APPROVED=true`).

## 양방향 한 명령 전환·다른 실행기
```
WRITER_LEASE_WRITE_APPROVED=true node dist/src/jobs/writer-lease.js handover --lane=source-cycle --to=PC1   # PC3→PC1, 반대도 같은 명령
```
이전 쪽은 다음 확인(회차·원천 시작)부터 쓰기 0 — 예약을 끄지 않는다. 임대는 만료돼도 자동으로 넘어가지 않고 사람·커맨드의 `claim`/`handover` 로만 넘어간다.
다른 쓰기 담당(예: 정산 접수 시트, 레인 `settlement-intake`)도 같은 방식: 쓰기 전에 `node dist/src/jobs/writer-lease.js check --lane=settlement-intake`(종료 코드 0 이면 쓰기, 3 이면 쓰지 않음)을 부르거나 `writerLeaseStore().check(lane, pc)` 를 쓴다. 레인 이름은 소문자·숫자·하이픈.

## 전환 순서
1. 새 쓰기 PC 에 코드 반영·빌드 → 2. 레인마다 `claim`(처음) → 3. 실행기 env 에 위 네 줄 → 4. 시험: 다른 PC 에서 `check` 가 종료 코드 3, 회차가 `lease-skips.jsonl` 만 남기는지 → 5. 이전할 때는 `transfer` 한 번(예약은 끄지 않는다).

## 켜기 절차서 (커맨드 승인 2026-10-23, `WRITER_LEASE_WRITE_APPROVED=true` 는 이 순서의 claim 에 한해 승인됨)

### ① 레인 목록 — 어느 실행기를 막나
레인은 «실행기의 env 파일»이 정한다(`WRITER_LEASE_LANE`). 같은 코드(`runtimeCli --unattended`)를 쓰는 실행기는 레인만 다르게 켠다.
| 레인 | 막는 실행기 | 켜는 곳 |
|---|---|---|
| `source-cycle` | 시간당 전체 회차(FreePass-Source-Cycle) | 그 실행기 env |
| `f05-realtime` | F05 5분 실행기(FreePass-F05-Realtime) | 그 실행기 env (checkout 이 달라도 같은 레인 이름) |
| `rp031-watch` | RP031 감시 실행기(:50, `--watch-sync`) | 그 실행기 env |
| `photo` | 사진 폴더 연결 단계(`run-source-cycle.ps1` 끝, `WRITER_LEASE_PHOTO_LANE` 로 이름 변경 가능) | 시간당 실행기 env (`ENFORCE` 와 함께 자동 확인) |
| 마음카·정산 접수 등 | `runtimeCli` 를 거치지 않는 쓰기 실행기는 자동으로 막히지 않는다 — 그 실행기가 쓰기 전에 `node dist/src/jobs/writer-lease.js check --lane=<레인>` 을 불러야 한다(종료 0=쓰기, 3=금지) | 해당 담당 |
주의: 레인 이름은 한 번 정하면 PC1·PC3 가 같게 쓴다. 한 실행기는 레인 하나만 가진다.

### ② 켜는 순서
0. 사전: PC3 에 PR 785·786 이 들어간 최신 main 을 받아 `npm.cmd run build`. PC3 에서 `status --lane=…` 가 `lease: null` 로 읽히면 연결 정상.
1. **레인 하나씩.** 아래를 레인마다 반복하고, 한 레인이 «한 회차 정상(쓰기 가능·종료 0)»을 확인한 뒤에 다음 레인으로 간다.
   - 보유 PC 로 `claim`: `WRITER_LEASE_WRITE_APPROVED=true node dist/src/jobs/writer-lease.js claim --lane=<레인> --pc=<보유PC>`
   - 그 PC 실행기 env 에 `WRITER_LEASE_ENFORCE=1`, `WRITER_LEASE_LANE=<레인>`, `WRITER_LEASE_PC=<보유PC>` 세 줄.
   - 다음 회차 뒤 확인: 실행 기록(`unattended-runs.jsonl`) 최신 줄 `exit 0`, `lease-skips.jsonl` 에 그 PC 줄이 없을 것, `status` 의 `renewedAt`/`epoch`.
2. **F05 레인(`f05-realtime`)**: PC1 이 임시 담당이므로 `--pc=PC1` 로 claim 한다. PC1 F05 실행기와 PC3 F05 실행기 둘 다 위 세 줄(PC 이름은 각자: PC1 / PC3)로 `ENFORCE` 를 켜 둔다. PC3 F05 는 예약이 켜져 있어도 `lease-skips.jsonl` 에 `NOT_HELD` 만 남기고 쓰기 0 으로 끝난다. 대표가 PC1 F05 예약을 끄면 한 줄로 넘긴다: `WRITER_LEASE_WRITE_APPROVED=true node dist/src/jobs/writer-lease.js handover --lane=f05-realtime --to=PC3` (반대도 같은 명령).
3. **되돌림(레인마다 한 줄)**: 그 실행기 env 의 `WRITER_LEASE_ENFORCE` 줄을 지운다(또는 `0`). 다음 회차부터 임대와 무관하게 예전처럼 돈다. 임대 문서는 남겨 둬도 무해하다.

### ③ 닫힘 시험 (PC3 쓰기 0 상태에서 한 번)
PC3 실행기를 «아직 보유자가 아닌» 상태로 두고 시험한다(쓰기 0 이 보장됨).
- 임대 없음: 아직 claim 안 한 레인(예: `lease-test`)으로 `WRITER_LEASE_ENFORCE=1 WRITER_LEASE_LANE=lease-test WRITER_LEASE_PC=PC3 SOURCE_CYCLE_UNATTENDED=1 node dist/src/runtime/source-cycle-runtime.js --unattended` → 종료 코드 1, 출력 `lease.error = WRITER_LEASE_MISSING`, `alerts.jsonl` 에 같은 사유, 원천 읽기·쓰기 없음.
- 읽기 실패: 같은 명령에 `FIREBASE_PROJECT_ID=freepasserp5` 로 두되 `SOURCE_CYCLE_GCLOUD_ACCOUNT=none@invalid` 처럼 잘못된 계정으로 토큰을 실패시킨다 → 종료 코드 1, `WRITER_LEASE_REQUEST_FAILED` 또는 토큰 오류 코드, 쓰기 없음.
- 설정 오류: `WRITER_LEASE_ENFORCE=true` → `WRITER_LEASE_ENFORCE_INVALID`, 종료 1.
확인 뒤 `lease-test` 레인은 쓰지 않으므로 정리할 것이 없다(문서가 만들어지지 않는다).

### ④ 승인 범위
위 순서대로의 `claim`·`handover` 에 한해 커맨드가 `WRITER_LEASE_WRITE_APPROVED=true` 를 승인했다(대표 «PC1 은 언제라도 3번 거를 받을 수 있어야»). 다른 레인·순서 변경은 커맨드에 다시 확인한다.

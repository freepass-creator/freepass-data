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

## 전환 순서
1. 새 쓰기 PC 에 코드 반영·빌드 → 2. 레인마다 `claim`(처음) → 3. 실행기 env 에 위 네 줄 → 4. 시험: 다른 PC 에서 `check` 가 종료 코드 3, 회차가 `lease-skips.jsonl` 만 남기는지 → 5. 이전할 때는 `transfer` 한 번(예약은 끄지 않는다).

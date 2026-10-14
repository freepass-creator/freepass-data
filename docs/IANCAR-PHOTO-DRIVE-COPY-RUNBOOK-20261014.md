# 이안카 사진 드라이브 복사 — 구현·실행 한 장 (2026-10-14, DATA)

> 설계 정본: `IANCAR-PHOTO-DRIVE-DESIGN-20261014.md`(별도 가지)의 **저장 위치·이름 규칙을 이 문서가 대체**한다(대표 직접 확인 10-14: 공유 드라이브 «freepasserp.com» 의 `freepasspics/이안카` 구조 재사용).
> 코드: `src/application/iancar-photo-drive-copy.ts`(오케스트레이션) · `src/infra/gws-photo-drive.ts`(드라이브 포트) · `src/jobs/copy-iancar-photos-to-drive.ts`(잡) · 등록 도구 `scripts/ops/register-approved-photos.mjs --method IANCAR_COMPRESSED_COPY`.
> **쓰기 경로(Drive + Firestore refs) — Codex 독립 검토 대상.** 키·사진 URL·응답 본문은 어디에도 출력하지 않는다(건수·번호 끝 4자리·코드만).

## 1. 저장 위치(개정)
```
공유 드라이브 «freepasserp.com» / freepasspics / 이안카 /         ← IANCAR_PHOTO_DRIVE_ROOT_ID 는 «이안카» 폴더 id (저장소에 두지 않음, 환경 변수)
   <번호> <차종>/   또는   <번호>/                                 ← 번호 폴더(기존 사람이 만든 것 재사용)
       01.jpg 02.jpg …                                             ← 이 잡이 올리는 압축본(대표 01)
```
- **번호 기준 매칭**: 폴더 이름의 «첫 토큰»(공백 앞)이 차량번호와 정확히 같으면 그 번호의 폴더다. «161허1397 쏘나타», «161허1397 쏘나타 DN8 디 엣지»가 같은 번호 폴더 후보다. 이름 검색(contains)은 믿지 않고 이안카 폴더 직계 폴더 전체를 한 번 읽어 로컬에서 고른다.
- **새 폴더 이름**: 후보가 없을 때만 만든다 — 차종 표기가 원천 목록에 있으면 «<번호> <차종>»(이름에 못 쓰는 문자 제거, 40자), 없으면 «<번호>». 기존 사람이 만든 이름 규칙(차종 접미사)을 따르되 차종을 추정하지 않는다.
- **중복 정리**: 같은 번호 후보가 여럿이면 — 사진이 든 폴더가 정확히 1개면 그것을 쓰고, 사진 든 폴더가 2개 이상이면 `AMBIGUOUS_FOLDER`(쓰기 0, 사람이 합친 뒤 다음 회차) — 삭제·이동은 하지 않는다. 모두 비어 있으면 이름이 가장 짧은 폴더를 쓴다.
- **기존 사진 있음 → 건너뜀**: 선택된 폴더에 «이 잡이 올리지 않은» 이미지(파일 속성 `srcKey` 없음)가 하나라도 있으면 `SKIPPED_EXISTING`(쓰기 0). 사람이 모은 정본 사진을 덮지 않는다. 이 잡의 부분 복사(`srcKey` 있음)는 이어서 채운다.
- 폴더 `appProperties`: `iancarPhotoSet`(앨범 지문)·`copiedAt`. 파일 `appProperties`: `srcKey`(원본 사진 id 의 해시, 사진 id 자체는 쓰지 않음).

## 2. 모드·한도·환경 변수
| 모드 | 동작 |
|---|---|
| `DRY_RUN`(기본) | 상세 조회(번호별 사진 id)와 드라이브 읽기만. 다운로드·업로드·폴더 생성·지문 기록 0. 결과: 차량별 PLANNED_COPY/SKIPPED_SAME/SKIPPED_EXISTING/NO_TARGET/NEEDS_REPLACEMENT/AMBIGUOUS_FOLDER |
| `PILOT` | 사진이 있는 차량을 번호 순서로 `IANCAR_PHOTO_PILOT_ONLY`(기본 10)대까지(이미 복사된 차량도 포함 — 집합 고정). `IANCAR_PHOTO_COPY_APPROVED=true` 필요 |
| `FULL` | 회차 한도 안에서 전체. 승인 변수 + **`IANCAR_PHOTO_FULL_APPROVED=<확인 값>`**(대상 «이안카» 폴더 id 에 묶인 해시, 파일럿 합격 뒤 `--mode DRY_RUN --print-full-token` 으로 꺼내 환경에 넣는다). 없거나 다른 폴더 값이면 거부 — `--mode FULL` 로 파일럿 한도를 우회할 수 없다(Codex ⑤) |

환경: `EANCAR_ONE_API_KEY`(+선택 `EANCAR_ONE_API_BASE_URL`), `IANCAR_PHOTO_DRIVE_ROOT_ID`, `GWS_BIN`(선택), `IANCAR_PHOTO_COPY_MODE`(또는 `--mode`). 한도(기본값): `MAX_VEHICLES` 40 · `MAX_PHOTOS` 400 · `MAX_PER_VEHICLE` 10 · `TIME_BUDGET_MIN` 40 · `INTERVAL_MS` 1500(최소 1000). **전체 첫 회차 상한은 파일럿 합격 뒤 이 변수로 조정**(93대를 1~2회에 끝내려면 MAX_VEHICLES·MAX_PHOTOS 상향).
- 직렬(동시 1), 공급사 호출 사이 간격, **실패 재시도 0**(502/503/504 도 클라이언트 내장 재시도를 막고 한 번에 실패 처리), 429·연속 3회 실패는 즉시 종료.
- **연속 실패 카운터**는 «차량 한 대를 끝까지 처리했는가»로 센다 — 상세 조회가 성공해도 다운로드·드라이브 쓰기 실패는 누적되어 연속 3회에서 종료한다(Codex ①). 정상 처리된 차량(복사·건너뜀·대상 없음 등)이 나오면 0 으로 돌아간다.
- **드라이브 429·쿼터**(`DRIVE_RATE_LIMITED`)도 공급사 429 와 같이 회차를 즉시 종료한다(Codex ②).
- **완료 표식**: 올린 파일에는 `srcKey`(원본 id 해시)와 `copySha256`(올릴 때 로컬 sha256)을 남기고, 다음 회차는 두 표식이 맞고 `copySha256` 이 드라이브 체크섬과 같을 때만 «완료»로 건너뛴다. 체크섬 불일치·표식 없는 같은 이름 파일은 `NEEDS_REPLACEMENT`(보류)이며 등록 CSV 에 들어가지 않는다(Codex ③). 이미 복사된 차량(`SKIPPED_SAME`)은 등록 CSV 에 다시 들어간다(앞 등록이 실패했어도 재시도, 등록 도구는 refs 가 있으면 건너뜀).
- 상류 정지·신선도 초과(`UPSTREAM_STALE`) 중에는 목록 단계에서 `IANCAR_SOURCE_NOT_READY` 로 시작하지 않는다.

## 3. 실측 반영(B3Q)
- 총 1,594장·원본 ≈515MB·압축 ≈302MB. 압축 = JPEG q80·긴 변 960px(기존 `renderVehiclePhotoRendition('detail')`), 입력 ≤8MB·24MP, 래스터만.
- **저장된 image_urls 14개 중 8개 404** → 저장된 URL 을 쓰지 않는다. 항상 «상세 재조회 → 즉시 다운로드» 순서(24시간 참조도 같은 잡 안에서 소비). 사진 URL 은 저장·출력하지 않는다.
- 원천에 사진이 없는 차(18대)는 `NO_TARGET`(정상). 실패가 아니다.

## 4. 등록(Firestore refs) — 빈 칸만·CAS·전후 기록
1. 잡이 `--out <csv>`(비공개 디렉터리)에 «번호,폴더»를 쓴다(지문 기록까지 끝난 차량만).
2. `node scripts/ops/register-approved-photos.mjs <csv> --method IANCAR_COMPRESSED_COPY`(DRY_RUN) → 확인 후 `--apply`.
   - 공급사 RP031 문서만, `photo_original_refs` 가 **비어 있을 때만** 쓴다(있으면 «이미 사진 있음» 건너뜀 — 교체는 하지 않는다).
   - 문서별 쓰기 전 백업(비공개)·`updateTime` 조건부 PATCH(CAS)·한 건씩 되읽기·audit 한 줄(번호 끝 4자리·장수·`prior`·method·결과).
   - 공유 드라이브 폴더를 읽도록 `supportsAllDrives`·`includeItemsFromAllDrives` 를 사용한다.
3. 교체(앨범 변경)는 이번 범위 밖: 폴더 지문이 달라지면 `NEEDS_REPLACEMENT` 로 보류만 한다(삭제·덮어쓰기 없음). 별도 승인 설계로 진행.

## 5. 쓰기 주체·권한 확인(B3Q)
- 쓰기 주체 = B3Q 개발 PC 에 이미 로그인된 gws 계정(서비스 계정·키 파일 없음). Drive API 설정됨(커맨드 센터 확인).
- 이 트리를 읽는 현재 경로: 승인 사진 reader(`FREEPASS_DATA_APPROVED_PHOTO_READER`: `drive-public`=«링크가 있는 모든 사용자» 다운로드, `drive-api`=Cloud Run 서비스 계정이 드라이브에서 보기 공유된 파일을 Drive API 로 읽음)와 refs 의 `driveFileId`. reader 는 폴더 루트를 쓰지 않고 파일 id 만 쓴다(sha256 검증). **공유 드라이브 파일은 reader 모드에 맞는 접근이 필요**하다.
- **B3Q 에 확인 요청(3건)**: ① gws 계정이 «freepasserp.com» 공유 드라이브의 «이안카» 폴더에서 **편집자 이상**(콘텐츠 관리자/편집자)인지 — DRY_RUN 은 읽기만이라 이 확인 전에는 쓰기 모드 금지 ② 운영 reader 모드(`FREEPASS_DATA_APPROVED_PHOTO_READER` 값)와 그 모드에서 공유 드라이브 파일이 읽히는지(`drive-public` 이면 이안카 폴더 «링크가 있는 모든 사용자», `drive-api` 이면 해당 서비스 계정이 공유 드라이브 구성원/폴더 보기) — 파일럿 1대로 refs 등록 뒤 `/api/catalog` 사진 노출로 확인 ③ 이안카 폴더 id 를 `IANCAR_PHOTO_DRIVE_ROOT_ID` 로 개발 PC 환경에만 설정.

## 6. 파일럿 → 전체 절차
1. DRY_RUN: 대수·PLANNED_COPY/SKIPPED_EXISTING/AMBIGUOUS_FOLDER 건수 확인(쓰기 0). 사람이 만든 4개 폴더(예 «133호5567»)는 사진이 있으면 SKIPPED_EXISTING 이어야 한다.
2. PILOT(승인 변수·N=10): 폴더·파일 수·sha256 확인 → 등록 DRY_RUN → `--apply` → `/api/catalog` 이안카 사진없음 93 → 83, «사진 준비 중» 해제, 이안카 429 0.
3. 합격 뒤 한도 값 조정 → FULL(일 1회, 지문 바뀐 차만 다음 날부터).

## 7. 시험
- `tests/iancar-photo-drive-copy.test.ts`(14): DRY_RUN 쓰기 0, 대표 01·지문 마지막·CSV, 지문 같으면 건너뜀, 기존 사진 폴더 건드리지 않음, 중복 폴더 보류, 기존 빈 폴더 재사용, 부분 복사 이어서·충돌 보류, 파일럿 집합 고정, 429 즉시 종료·재요청 0, 연속 실패, 간격, 사진 상한(차량 쪼개지 않음), 차량당 ≤10, 결과에 전체 번호·id 없음.
- `tests/gws-photo-drive.test.ts`(6): 번호 첫 토큰 매칭, 공유 드라이브 파라미터, 삭제 명령 없음, 새 폴더 이름·업로드 속성·체크섬 검증·임시 파일 삭제, 지문 기록, 한도·승인 거부.

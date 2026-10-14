# 이안카 압축 복사 사진 → 승인 사진 refs 경로 검토 (한 장)

> 2026-10-14 · DATA 유지보수 · 검토만(코드 변경 없음). 결정 근거: 커맨드 센터 «공급사 공개 URL 사진 보관소 복사 여부» 회신.

## 결정(커맨드 센터)
1. 손오공 `images[].url`·아이언 갤러리 URL = **URL 그대로 노출**, 복사 안 함, `raw.images` 보존(저작권·저장 정책 결정 전까지).
2. 이안카만 **압축 복사**(대표 제안). 복사 설계는 수집 이안카 세션 담당. 이 장은 «복사 결과가 승인 사진 refs 로 들어가는 경로»만 다룬다.
3. 핫링크가 끊기면 «사진 준비 중» 표시 + `raw.images` 보존.

## 현행 refs 스키마와 서빙 (스키마 확장 불필요)
- `products/{번호}.photo_original_refs[]` 한 건 = `{driveFileId, sha256, mediaType(jpeg|png|webp), role, zone, vehicleKey, approvedAt, vehiclePhotoVerifiedBy/Method/At}` (`ApprovedVehiclePhotoRef`, consumer-output-contract).
- 서빙: `drive-approved-photo-reader` 가 `driveFileId` 로 **우리 드라이브** 바이트를 읽고 등록된 `sha256` 과 다르면 거절. 8MB·형식·시그니처 검사.
- 등록: `scripts/ops/register-approved-photos.mjs`(번호,폴더 CSV) → 문서별 백업·updateTime 조건·되읽기. 방법 코드 `AUTO_KAKAO_COLLECT`.
- 사진 연결 승격 계획(`plan-photo-links`, e7f6ccc)이 «어느 차에 어느 폴더»를 정해 CSV 를 만든다.

## 권장 경로: «드라이브 번호 폴더»에 압축본 업로드 → 기존 등록 경로 재사용
```
이안카 수집 세션: ONE 앨범 → 압축(JPEG, ≤8MB, 장당 상한) → 공유 드라이브 «번호 폴더/<번호>/NN.jpg» 업로드
  → Drive 가 sha256Checksum 계산 → plan-photo-links(폴더×문서 스냅샷) → register-approved-photos --apply
```
- **보관소 위치 = 기존 «번호 폴더» 드라이브**(승인 사진과 같은 곳). 새 저장소·새 스키마 없음. refs 의 `driveFileId`·`sha256` 은 «압축본» 기준이므로 읽기 쪽 해시 검증이 그대로 성립한다.
- refs 스키마 확장 **불필요**. 출처 표시가 필요하면 `vehiclePhotoVerificationMethod` 에 새 값(예: `IANCAR_COMPRESSED_COPY`)만 추가 — 값 목록 검증 코드(`hasVehiclePhotoVerification`) 확인 후 별도 PR.

## 반드시 풀어야 할 접점 (코드 확인 완료·미구현)
| # | 접점 | 위험 | 제안 |
|---|---|---|---|
| 1 | 이안카 사진 ID 게이트(`iancar_one_photo_ids`) | refs 가 있으면 이안카 원천 서빙을 쓰지 않는다(consumer-output-contract:418 `!hasOwn photo_original_refs`). 복사본이 원천 앨범보다 오래되면 «옛 사진 고정» | 복사 세션이 `iancar_one_photo_ids` 지문을 refs 와 함께 저장하고, ID 가 바뀌면 재복사(또는 refs 제거 후 게이트 복귀) |
| 2 | 소멸·철회 | 원천에서 차량이 사라져도 우리 사본이 남음 | `publication_withdrawal` 이면 노출 자체가 내려가므로 사본은 보관만(서빙 안 됨). 폴더 정리는 별도 주기 |
| 3 | 드라이브 쓰기 권한 | 현재 수집 쪽은 `drive.readonly` | 업로드는 별도 서비스 계정·좁은 폴더 쓰기 권한 필요 → **권한·공유 설정은 대표/보안 승인 사항**(AI 변경 불가) |
| 4 | 저작권·저장 정책 | 이안카 사진은 공급사 자산 | 이안카 한정 대표 제안은 있음. 계약상 복사 허용 근거를 «결정함» 형식으로 남길 것 |
| 5 | 중복 방지 | 같은 차를 두 번 복사 | `sha256` 동일 파일 건너뛰기 + 폴더 단위 멱등 업로드(이름 `NN.jpg` 고정) |

## DATA 가 할 수 있는 다음 코드(요청 시)
- `plan-photo-links` 에 «이안카 지문 불일치(재복사 필요)» 보류 사유 추가(순수 함수, 테스트 포함).
- `IANCAR_COMPRESSED_COPY` 방법 코드 허용 + 시험.
- 업로드 자체(드라이브 쓰기)는 수집 이안카 세션 구현·B3Q 실행 — DATA 는 쓰지 않는다.

## 열린 결정 (대표)
- 드라이브 쓰기 권한 부여 방식(서비스 계정/폴더 범위).
- 이안카 복사본의 갱신 주기(ONE 사진 ID 변경 감지 시 즉시 vs 일 1회).

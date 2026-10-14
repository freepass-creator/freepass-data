# 이안카 사진 — 사본 우선 서빙 (2026-10-15)

대표 2026-10-14·15 결정: 이안카 사진은 압축해 우리 드라이브로 가져와 연동하고, 이안카 원천은 대여료·보증금·정책 텍스트만 쓴다.
화면 요청이 이안카(ONE) 서버를 두드리지 않는다.

## 무엇이 바뀌었나

| 항목 | 변경 전 | 변경 후 |
| --- | --- | --- |
| 서빙 원천 | 공개 RP031 은 `iancarSource`(ONE 라이브)가 항상 먼저 — 드라이브 사본 refs 가 있어도 무시 | 사본 refs 가 있으면 `approvedSource`(드라이브 사본, sha256 검증)만 사용 |
| 공개 게이트 | `isPublicIancarPhotoProduct` 가 ONE 차량 ID(`iancar_one_vehicle_id`)를 요구 → 엔진이 쓴 문서는 `PUBLIC_INELIGIBLE` | 사본 경로는 `isIancarCopyPhotoProduct`(= `isApprovedVehiclePhotoProduct` 와 같은 상태 규칙 + 사본 방식 검사) |
| 사본 없는 RP031 | ONE 라이브 | `IANCAR_LIVE_PHOTO_FALLBACK=off` 면 404(사진 없음, ONE 호출 0). 기본은 종전(켜짐) |
| 공개 피드 | 없음 | `photo_approved_count`(사본 서빙 보장 수, 아니면 0) |

## 사본 상품 조건 (`isIancarCopyPhotoProduct`)
RP031 이고 `isApprovedVehiclePhotoProduct` 를 만족하며, 모든 refs 가 `vehiclePhotoVerificationMethod=IANCAR_COMPRESSED_COPY` 이고 `sourceKind`(ONE 결속)가 없다.
옛 ONE 결속 refs·다른 방식 refs·다른 공급사는 사본 경로가 아니다(다른 공급사 동작 불변).

## 켜는 순서 (운영 작업은 DEV·ERP5 몫)
1. 이 PR 합침·배포(코드만; `IANCAR_LIVE_PHOTO_FALLBACK` 미설정 = 종전 동작 유지).
2. 읽기 서비스에 `FREEPASS_DATA_APPROVED_PHOTO_READER`(drive-api 권장) 확인.
3. `IANCAR_LIVE_PHOTO_FALLBACK=off` 설정 → 화면 요청의 ONE 호출 0.
4. ERP5 는 `photo_approved_count > 0` 인 차만 imageUrl 을 만든다.

## 옛 ONE 기반 refs (예: 끝4 8099, 51건)
옛 «ONE 차량사진 전용 확인» refs 는 드라이브 파일이 없어 404 다. 이 PR 은 이를 사본 경로로 취급하지 않는다(`photo_approved_count=0`).
교체 규칙(삭제 없이 철회·신규 등록 허용, 기존 refs 를 prior 기록으로 보존)은 등록 도구(`register-approved-photos.mjs`) 쪽 별도 설계 — 결정 대기.

## 검증
`tests/iancar-copy-first-serving.test.ts`(사본 있음/없음/sha 불일치/드라이브 404/리더 꺼짐/비적격/다른 공급사/ONE 호출 0), `tests/public-product-feed.test.ts`(photo_approved_count·스키마).

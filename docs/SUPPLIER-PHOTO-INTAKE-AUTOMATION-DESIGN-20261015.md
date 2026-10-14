# 공급사 공통 사진 인입 자동화 — 설계 한 장 (2026-10-15, 대표 질문 «사진 저장·링크 거는 것까지 자동화돼 있나?»)

상태: DESIGNED. 코드 변경 없음, 라이브 쓰기 없음. 승인(결정) 뒤 구현·Codex 검토.

## 0. 지금 자동화된 곳과 아닌 곳 (코드 기준)

| 단계 | 현재 | 자동? |
| --- | --- | --- |
| 저장 — 카톡 말풍선 «저장» | GUI 수동 | 아니오 |
| 저장 — 이안카 ONE 사진 | 일 1회 잡(`copy:iancar-photos` → 압축 사본 드라이브 저장) | 예(이안카 한정) |
| 저장 — 손오공 | 원천 엔진이 API 사진 주소를 `image_urls` 로 씀(#654) | 예(URL 그대로, 사본 없음) |
| 등록(`photo_original_refs`) | `scripts/ops/register-approved-photos.mjs`(`--root` 로 공급사 폴더 전체 가능) DRY_RUN→`--apply` 사람이 실행 | 아니오 |
| 서빙(데이터) | `createVehiclePhotoReader` 의 approvedSource 는 공급사 불문 승인 refs 를 서빙. 다만 기계 소비처 `erp5-public-media` 는 RP031(`iancarSource`)만 통과 → 다른 공급사는 404 | 부분 |
| 공개 응답 | `photo_approved_count` 는 `isIancarCopyPhotoProduct`(RP031·IANCAR_COMPRESSED_COPY) 전용 | 이안카 한정 |
| 소비처(ERP5 #136) | `approvedPhotoCount` 를 provider RP031 만 인정 | 이안카 한정 |

결론: 이안카를 뺀 공급사는 «사진을 올려도 화면에 안 붙는다». 끊긴 곳은 ① 등록이 수동 ② 서빙·카운트가 RP031 한정 ③ ERP5 규칙이 RP031 한정.

## 1. 목표 흐름

`freepasspics/<공급사>/<번호 차종>/` 에 사진이 생기면(카톡·직접 업로드·공급사 올림 어느 경로든) 일 1회(필요하면 시간당) 잡이 아래를 한다. 한 단계라도 실패한 차는 건너뛰고 다음 회차에 다시 본다(삭제·덮어쓰기 없음).

1. **폴더 ↔ 번호 검증**: `photo-folder-match`(#631 방식) — 폴더 이름의 번호가 상품 번호와 정확히 일치, 같은 번호 폴더가 둘 이상이면 그 번호는 등록하지 않음. 서류 하위 폴더는 직계 이미지만 읽어 제외.
2. **파일 검증**: 이미지 시그니처(JPEG/PNG/WEBP)·크기 상한·sha256(드라이브 `sha256Checksum` — 바이트를 내려받지 않음 / 압축 시 결과물 sha256).
3. **압축 사본 규칙**: 이미 승인 규격(JPEG q80·최대 960px 이하, `renderVehiclePhotoRendition('detail')`)이면 그대로, 아니면 압축 사본을 만들어 우리 드라이브 번호 폴더에 별도 이름으로 저장(원본 보존, appProperties 로 srcKey·copySha256 표기, 이안카 사본 잡과 같은 방식 — 공급사 불문으로 일반화).
4. **등록**: `photo_original_refs` 가 **빈 칸일 때만**. 사람이 등록한 폴더·옛 refs 는 보존하고 건너뜀(교체는 별도 승인). 쓰기는 문서 updateTime CAS·백업·되읽기·감사 기록(`vehiclePhotoVerifiedBy` = 잡 이름, 방법 코드 = 공급사 불문 `SUPPLIER_FOLDER_COPY` 등 하나로 통일 제안).
5. **응답**: 공개 응답·내부 응답 `photo_approved_count` = 검증된 refs 수(서빙 보장될 때만 > 0), 공급사 불문. 산식은 `isApprovedVehiclePhotoProduct` + 방법 허용 목록.
6. **서빙**: 기계 소비처도 «승인 refs 가 있으면 공급사 불문 approvedSource(드라이브 사본, sha256 검증)» 로 서빙. ONE·외부 원천 호출 0.
7. **소비처(ERP·개발 몫)**: ERP5 는 provider RP031 한정이 아니라 `photo_approved_count > 0` 인 차만 imageUrl 을 만든다.

## 2. 공급사별 승인 가드(사진 사용 허용 정책)

공급사마다 사진 사용 조건이 다르다. 잡은 **공급사 허용표**에 «사진 사용 허용»이 명시된 공급사만 처리한다(표에 없으면 처리 안 함 — fail-closed).
- 허용표 항목: 공급사 코드, 사진 사용 허용(예/아니오), 사본 방식(원본 허용/압축 필수), 폴더 규칙, 제외 표지(예: 아이카 «사용X»).
- **아이카 «사용X» 폴더/파일 해석은 결정 필요**: 이름에 «사용X» 가 들어간 폴더·파일은 «등록 제외»로 해석하는 것이 안전하다(제안). 정확한 의미·위치는 아이카 담당 확인 전에는 구현하지 않는다.
- 사진 사용 허용 여부 자체는 정책 문서(공급사 계약)가 정본이다 — 코드가 추정하지 않는다.

## 3. 상한·안전

- 회차당 등록 상한(예: 50대), 차량당 사진 상한 200장(승인 도메인 규칙), 파일 크기 상한 8MB(서빙 규칙).
- 삭제 없음: 드라이브·refs 어느 것도 지우지 않는다. 철회는 기존 `publication_withdrawal` 규칙.
- DRY_RUN 기본, 적용은 명시 승인. 쓰기 전 백업(비공개 디렉터리), 한 건씩 되읽기, CAS 충돌·대상 증가 시 중단.
- 이안카 사본 우선 서빙 PR(`iancar-copy-first-serving-20261015`)과 충돌하지 않도록 `isIancarCopyPhotoProduct` 를 «공급사 사본 상품»으로 일반화하는 변경으로 이어 간다.

## 4. 구현 순서(승인 후, PR 단위)

1. 서빙·카운트 일반화(도메인): `isIancarCopyPhotoProduct` → 공급사 허용표 기반 `isSupplierCopyPhotoProduct`, `photo_approved_count` 공급사 불문, `erp5-public-media` 의 approvedSource 허용(Codex 검토, 다른 공급사 불변 시험).
2. 인입 잡(`intake-supplier-photos`): 폴더 열거 → 검증 → 압축 → 등록 계획(DRY_RUN) 출력까지(쓰기 0).
3. 등록 쓰기(`register-approved-photos` 재사용), 일 1회 예약은 운영 몫(B3Q).
4. ERP5 규칙 변경(ERP·개발).

## 5. 결정 필요

1. 공급사 허용표 확정 — 어느 공급사가 사진 사용 허용인가(정책 문서 기준).
2. 아이카 «사용X» 의미(제외 표지로 해석해도 되는가).
3. 압축 필수 여부(공급사 원본 그대로 서빙 허용 공급사가 있는가).
4. 방법 코드 통일(`AUTO_KAKAO_COLLECT`·`IANCAR_COMPRESSED_COPY` 와 공존/통합).
5. 인입 주기(일 1회 vs 시간당).

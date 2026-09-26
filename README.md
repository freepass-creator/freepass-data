# FreePass Data

FreePass 전체 제품군의 데이터 계약, 정본, lineage, distribution을 담당하는 중앙 데이터 플랫폼입니다.

최종 목표는 **“FreePass Data에서 가져와”라는 요청 하나로 권한이 허용된
`freepasserp5` 관리 데이터를 이곳의 안정된 계약을 통해 찾고 가져올 수 있게 하는 것**입니다.
상품 Catalog V1부터 구현하되, 이후 고객·접수·계약·정산·증빙 등도 각 업무 소유권과
개인정보 권한을 보존한 도메인 계약으로 연결합니다. 이는 Firestore 전체 문서를 그대로
노출하는 범용 덤프 API를 뜻하지 않습니다.

## 역할

FreePass Data는 또 하나의 화면 앱이 아닙니다.

- 원천 데이터를 수집한다.
- RAW 원문을 변경 없이 보존한다.
- 공급사/시트/기존 Firebase 차이를 normalize 한다.
- Canonical SSOT를 만든다.
- Admin / Sales / ERP.com / Estimate 등 소비자별 projection을 제공한다.
- 모든 수정은 revision, actor, reason, diff, receipt를 남긴다.
- 각 소비 앱이 Firebase collection 구조를 직접 알지 않게 한다.
- 공통 데이터 조회의 단일 진입점을 제공하고, 도메인·조직·사용자 권한에 맞는 결과와 버전 증거를 반환한다.

## 핵심 원칙

1. **GitHub repo는 코드·계약 정본이고 운영 데이터 저장소가 아니다.**
2. **RAW는 immutable** — 직접 수정하지 않는다.
3. **Canonical은 설명 가능해야 한다** — 모든 필드는 source / transform / override provenance를 가진다.
4. **직접 수정은 override** — 원문 덮어쓰기가 아니다.
5. **소비 앱은 Data Contract를 사용** — 장기적으로 Firebase SDK 직접 접근을 제거한다.
6. **기능 정본과 데이터 정본을 분리** — Estimate는 계산 기능을, Sales는 영업 workflow를, Admin은 운영 workflow를 소유하되 공통 업무 사실은 FreePass Data가 제공한다.
7. **쓰기 완료는 receipt 기반** — UI에서 저장 버튼을 눌렀다는 사실이 완료가 아니다.
8. **RTDB 신규 사용 금지** — 기존 흔적은 migration debt로만 취급한다.
9. **모든 관리 대상 데이터는 발견 가능해야 한다** — 데이터 도메인 목록과 제공 상태를 조회할 수 있고, 미연결 데이터는 누락시키지 않고 `HOLD`로 표시한다.
10. **전체 조회와 전체 공개는 다르다** — 중앙에서 관리·검색할 수 있어도 소비자에게는 승인된 필드와 범위만 제공한다.

## 현재 확인된 상태 — 2026-09-20

- FreePass Admin: Canonical Product Domain SSOT를 소비하도록 설계되어 있으나 production persistence/auth는 아직 NOT VERIFIED.
- FreePass Sales: Firebase project `welrixtable` / Firestore를 현재 운영 정본으로 직접 사용.
- FreePass Estimate: 견적 기능 SSOT / upstream. 데이터 플랫폼 정본 역할은 아니다.
- freepasserp4: Firebase project `freepasserp3` binding과 Firestore/RTDB/Storage 설정이 존재하는 legacy/reference 경계.
- FreePass Data: 신규 central data platform.

자세한 내용:
- [Approved Architecture v2](docs/ARCHITECTURE-V2-APPROVED.md)
- [Repository Structure](docs/REPO-STRUCTURE.md)
- [Architecture v1 — 이력(NOT_CANONICAL, 정본은 v2)](docs/ARCHITECTURE.md)
- [Migration Plan](docs/MIGRATION-PLAN.md)
- [Console UX](docs/CONSOLE-UX.md)
- [ERP.com · Google Sheets SSOT Operating Map](docs/ERP-COM-GOOGLE-SHEETS-SSOT.md)

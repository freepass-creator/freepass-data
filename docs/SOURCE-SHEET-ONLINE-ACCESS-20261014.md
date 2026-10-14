# 시트 원천 온라인 읽기(ADC·WIF) — 설정 표 (2026-10-14)

상태: CODED·TESTED(전송 분기·사전점검), 실제 켜기는 사람 손(시트 «보기» 공유·WIF 설정). 값(시트 ID·이메일)은 이 문서에 쓰지 않는다 — 변수 이름만.

## 전송

| 환경 | `SHEETS_TRANSPORT` | 시트 토큰 | Firestore 토큰 | 필요한 것 |
|---|---|---|---|---|
| 운영 PC(B3Q, 현행) | `gws` | gws CLI(회사 계정 위임) | gcloud 사용자 토큰 | gws·gcloud 로그인 |
| 온라인(GitHub Actions) | `adc` | ADC(Application Default Credentials) 읽기 전용 토큰 | ADC `datastore` 토큰 | WIF 설정 파일(`GOOGLE_APPLICATION_CREDENTIALS`, 키 없는 external_account) |

- ADC 는 `google-github-actions/auth` 가 만드는 «키 없는» 외부 계정 설정 파일을 그대로 쓴다(저장소·비밀에 서비스 계정 JSON 키를 두지 않는다). 쓰기 범위 없음(`spreadsheets.readonly`, GET 만).
- 사전점검: `adc` 이면 gws·gcloud 를 요구하지 않고 ADC 토큰만 확인한다(`PREFLIGHT_ADC_TOKEN_MISSING`).
- Firestore 쓰기 권한은 같은 서비스 계정의 IAM(`roles/datastore.user` 수준) — 코드가 아니라 사람 손(IAM).

## 원천별 설정 표 (시트 ID·이메일은 비공개 설정에만, 여기에는 변수 이름)

| 원천 | 읽는 시트 | 시트 ID 변수 | 서비스 계정 공유 | 비고 |
|---|---|---|---|---|
| F05 공통 입력 시트(공급사 15곳·마춤카 탭) | 공통 입력 시트 한 개 | `SOURCE_CYCLE_F05_SHEET_ID` | 서비스 계정에 «보기» | 숨김 탭·행·필터 메타(`includeGridData`)까지 읽음 |
| 아이카 RP004 | 아이카 별도 시트(장기특별이벤트·신차선출고·중고재렌트·월렌트 탭) | `SOURCE_CYCLE_AICA_SHEET_ID` | 서비스 계정에 «보기» | 숨김 탭 불가(보이는 탭만) |
| 오토플러스 RP023 | 공급사 원본 시트(재고 리스트) | `SOURCE_CYCLE_AUTOPLUS_SHEET_ID` (+ `SOURCE_CYCLE_AUTOPLUS_SHEET=1`) | 서비스 계정에 «보기» | 홈피는 교차 확인(공개, 계정 불필요) |
| 이안카 RP031 | 시트 없음(ONE API) | — | — | 이안카 계정 비밀은 별도 이관 필요 |
| 손오공 RP012 | 시트 없음(공식 파트너 API) | — | — | `SONOGONG_API_KEY`·`SONOGONG_API_BASE` 비밀 |
| 아이언 RP006 | 시트 없음(공개 홈피) | — | — | 계정 불필요 |

서비스 계정 이메일은 WIF 설정에서 정한 «읽기 전용 서비스 계정» 하나를 위 세 시트에 «보기»로 공유한다(사람 손, 편집 권한 금지).

## 켜기 순서(온라인 이전, 원천 단위·이중 쓰기 금지)

1. WIF 풀·서비스 계정 생성, 시트 3곳 «보기» 공유, 워크플로에 `google-github-actions/auth` 단계(사람).
2. Actions 에서 `SHEETS_TRANSPORT=adc` + 대상 원천 한 개만 DRY_RUN(쓰기 0)으로 B3Q 정시 회차와 결과 비교(NEW/MISSING/값 불일치 동일).
3. 같은 원천의 B3Q 예약을 끄고 Actions 쓰기를 켠다(원천 단위 전환), 이상 시 되돌림은 `SHEETS_TRANSPORT=gws` 로 B3Q 복귀.

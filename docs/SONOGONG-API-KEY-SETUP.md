# 손오공 공식 API 키 등록·시험 순서 안내문 (대표 손 1장)

작성 2026-10-14. 값(키)은 이 문서·채팅·로그·커밋 어디에도 쓰지 않는다. 키가 올 때까지 코드는 «키 없음 → 호출 0»이다.

## 1. 키가 오면 먼저 확인(값은 보지 말고 존재만)
- 받은 메일·첨부에서 확인할 것 4가지만 AI 세션에 알려 준다: ① API 기본 주소(도메인만) ② 인증 방식 이름(예: 헤더 Bearer/ApiKey) ③ 호출 한도(분·시간·일) ④ 문서 첨부 여부. 키 값은 알리지 않는다.

## 2. 저장소 비밀값 등록(대표 손, 화면)
- 대상 저장소: `freepass-creator/freepass-data` → Settings → Secrets and variables → Actions → New repository secret
- 이름 **SONOGONG_API_BASE** — 값: 받은 기본 주소(예: https://… 도메인)
- 이름 **SONOGONG_API_KEY** — 값: 받은 키
- 명령으로 넣을 때(대표 PC, 값이 화면·기록에 안 남음): `gh secret set SONOGONG_API_KEY -R freepass-creator/freepass-data < <키가 든 로컬 파일>` 후 파일 삭제.
- 등록 뒤 확인(값 없이): `gh secret list -R freepass-creator/freepass-data` 에서 두 이름과 등록 시각만 보면 된다.

## 3. 시험 순서(AI 세션 담당, 각 단계 끝에 결과 한 줄 보고)
1. 가짜 응답 시험 통과 확인(키 불필요, 로컬): `npx vitest run tests/sonogong-official-api-reader.test.ts`(어댑터 구현 후).
2. 읽기 1회, 목록 1쪽만(쓰기 0, 정책: 직렬·재시도 0·시간당 상한) → 총수·필드 이름·인증 성공 여부만 보고.
3. 목록 전체 1패스(쪽 간 간격) → 원천 총수·유형별 대수 → 331 화면 기준과 대조(정의 차이는 따로 보고).
4. 정합 보고(NEW/MISSING/값불일치) → 승인 후 plan(미리보기) → 백업 → 적용 → 되읽기.
5. 이상(429·401·응답 구조 변경) 나오면 즉시 정지, 다음 시도는 백오프 후 «목록만».

## 4. 하지 않는 것
- 키를 채팅·문서·커밋·로그에 쓰기, 로그인 수집 병행(키 확인 뒤 로그인 수집은 폐기), 새 로그인 시도.
- 호출 한도를 문서 확인 없이 추정해 올리기.

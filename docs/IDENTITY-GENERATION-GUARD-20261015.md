# 정체성 매칭 세대 구분 근거 점검 (R1·R2·R3) — 2026-10-15

커맨드 센터 승인(대표 10-15 지적 «세대 구분 근거 없음»). 방향: **더 적게 확정, 틀린 확정 방지**. 이름을 짓지 않고 확정을 보류로 돌릴 뿐이다. 판정기(`matchIdentity`)는 계획서 생성기와 엔진 정체성 정제(#655)가 같이 쓴다.

## 규칙
- **R1 수식어 일치**: 원문에서 마스터 이름(또는 개발코드를 뗀 이름) 바로 앞에 수식어(디·올·더·뉴·신형·THE·ALL·NEW)가 더 붙어 있으면 부분 일치로 보지 않는다 → `GENERATION_QUALIFIER_MISMATCH`. 예: «디 올 뉴 그랜저» 안의 옛 «뉴 그랜저».
- **R2 형제 세대 연식 근거**: 같은 제조사·모델에 «형제 세대»(개발코드가 다르거나, 코드가 같아도 기본 이름이 같고 앞 수식어만 다른 부분변경)가 있고 원문에 이 세대의 개발코드·전체 이름이 없으면, 상품 연식이 이 세대 범위 안에만 있고 형제 범위와 겹치지 않을 때만 확정 → 아니면 `GENERATION_EVIDENCE_MISSING`. 하이브리드 같은 변형(기본 이름이 다름)은 형제가 아니다.
- **R3 점검 목록**: 마스터에서 형제 세대가 있는 모델 목록을 자동 도출(`appendix.generationFamilies`), 별칭 후보(`appendix.aliasCandidates`).
- 적용 범위: 마스터를 «원문 부분 일치»로 고른 경우(엔진 원문 편입·세부모델 칸 빈 상품)만. 세부모델 칸을 마스터 이름과 정확히 대조한 경우는 해당 없음.

## 판정(커맨드 센터 샘플)
1. «현대_디 올뉴그랜저 하이브리드» → «뉴 그랜저»: R1 로 보류. 확정하려면 마스터 별칭(규칙 20) «디 올뉴그랜저 하이브리드» → «그랜저 하이브리드 GN7» 이 필요(후보 목록으로만 올림, 코드에 박지 않음).
2. «현대_팰리세이드_3.8 가솔린» → «팰리세이드 LX2»: 별칭이 1세대에만 이어져 있으면 연식 ≤2021 만 확정, 2022(겹침)·연식 없음·2023+ 는 R2 로 보류.

## 사용(읽기 전용)
```
node dist/src/jobs/build-identity-promotion-plan.js --input <snapshot.json> --out <plan.json> --held <held.json> \
  --appendix <appendix.json> --audit <audit.json>
```
- `--appendix`: 형제 세대 모델 목록·별칭 후보(원문·대수·연식으로 좁힌 후보·unique 여부 — 사람이 승인).
- `--audit`: 이미 확정된 상품(세부모델 칸이 마스터 이름과 정확히 같은 문서)을 R1/R2 로 다시 점검 — 공급사별 대수(OK·UNVERIFIABLE·사유 코드)와 «검토 필요» 목록(끝4·사유). 되돌리지 않는다. UNVERIFIABLE = 원문이 비었거나 마스터 이름이 원문에 없음(근거 없음 ≠ 오류).
- 스냅샷 내보내기는 상품에 `supplier`(provider_company_code)를 함께 싣는다(공급사별 집계용, 번호는 끝4만).

## 시험
`tests/identity-generation-guard.test.ts`(R1·R2·엔진 정제·계획서 부록·감사), 기존 `identity-promotion-plan`·`engine-identity-refine`·`identity-snapshot`·`identity-plan-cli` 통과.

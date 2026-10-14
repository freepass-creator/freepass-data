# 계약중 문서 작성 주체 증거와 잠금 값 (2026-10-14, DATA)

> 배경: #622(f18c8ab9)가 «엔진이 쓴 계약중은 잠금 아님»을 도입한 뒤 Codex 독립 검토가 P1 2건을 냈다. 이 문서는 그 수정의 규칙과 이관 설계다.

## 규칙
1. **잠금 값 허용표(하나)**: `locked_by_contract` 가 `undefined`·`null`·`false`·`''` 가 «아니면» 전부 잠금이다 — `true`, `'LEDGER'`(정산원장), 알 수 없는 값·객체 포함(보수적). 코드: `isContractLockValue`.
2. **엔진 작성 표식**: 엔진은 문서를 쓸 때마다 `source_cycle_write: { by: 'source-engine', status: <표시 상태>, at: <관측 시각> }` 를 함께 쓴다.
3. **엔진 소유 계약중**(잠금 아님)의 조건은 전부 충족일 때만: 표식 `by==='source-engine'`·`status==='계약중'`, 문서 `status==='계약중'`·`status_kind==='선점'`(엔진이 쓰는 값)·`vehicle_status==='계약중'`·`listable===true`, 원천 기록 상태 원문 계약중, 잠금 필드 값 없음.
4. **그 밖의 계약중은 계약 잠금**: 표식 없음·다른 주체·ERP 가 `status_kind` 를 «계약중» 으로 바꿈·잠금 필드 있음 → 원천이 출고가능으로 바뀌어도 덮어쓰지 않는다.

## 이관(이미 쓴 35건)
- 수정 전 쓰기(엔진 29bb2890)에는 표식이 없으므로 **계약중 1건은 잠금으로 남는다**(보수적). 노출 중이며 값은 정상, 엔진이 갱신만 하지 못한다.
- 일회성 보정을 둔다면(승인 필요, 자동 아님): `provider_company_code=RP012`, `status=계약중`, `status_kind=선점`, `listable=true`, `locked_by_contract` 없음/false, `source_cycle_record.status.raw=계약중`, `source_cycle_record.raw.source='sonogong-partner-api'`, 갱신 시각이 첫 APPLY 구간(11:21~11:39Z) 안인 문서에 한해 표식을 추가. 계획서(번호 끝 4자리, 건수)를 DATA 가 만들고 B3Q 가 정식 경로로 적용·되읽기 한다. 대표/커맨드 센터 승인 전에는 만들지 않는다.

## 시험(tests/contracted-readback.test.ts)
- LEDGER 문자열·알 수 없는 객체 잠금 보호(엔진이 쓴 계약중에도).
- 표식 없는 계약중(수정 전 쓰기 포함) 보호, ERP 가 바꾼 status_kind 보호.
- 표식 있는 계약중은 원천이 출고가능으로 돌아오면 UPDATE.

# 정책 정정기

`repair:policy-correction`은 Firestore `policy/<정책코드>` 문서의 허용 칸만 근거와 함께 고치는 일반 길이다. 기본은 DRY RUN이며 실제 쓰기는 `--apply`와 `AUTHORIZE_POLICY_CORRECTION=<planDigest>`가 모두 맞을 때만 실행한다.

## 계획 형식

```json
{
  "planId": "policy-correction-20261005-01",
  "createdAt": "2026-10-05T00:00:00.000Z",
  "items": [{
    "policyCode": "POL-0023",
    "supplierCode": "RP000",
    "field": "driver_age_lowering",
    "layer": "supplierCondition",
    "from": "협의",
    "to": "불가",
    "evidence": {
      "source": "공급사답",
      "location": "문의건 2026-10-05-01",
      "effectiveDate": "2026-10-05"
    }
  }]
}
```

## 규칙

- `source`는 `공급사답`, `운영정책`, `대표결정`만 허용한다. `옛입력`, 빈 `location`, 빈 문자열·null `to`는 거부한다.
- `from`은 현재 저장값과 글자 그대로 같아야 한다. 필드 없음은 `null`로 적는다.
- `0`, `없음`, `무료`, `불가`는 서로 다른 값이다. 허용 칸과 타입 검사를 통과해야 한다.
- 같은 정책코드·칸·층에 기존 근거가 있으면 새 `effectiveDate`가 더 늦어야 한다. 근거가 없으면 문서 `updated_at` 또는 `created_at`보다 늦어야 한다.
- `supplierCondition`은 `policy/<코드>[field]`와 `field_evidence[field]`를 쓴다. `salesPolicy`는 공급사 조건을 건드리지 않고 `sales_policy[field]`만 쓴다.
- 적용 시 개인 백업을 `~/.codex/private/freepass-data-policy-corrector-backups/<runId>.json`에 만들고, 트랜잭션 안 재확인, 되읽기, `audit_events` 검증을 한다.

## 계약서 원본의 공란과 별도 적용 조건

- 기존 계획은 기본 `set` 동작을 유지한다. `null`이나 빈 `to`로 공란을 표현하지 않는다.
- 원본에 일반 자차 부담률이 없을 때만 `field: "own_damage_repair_ratio"`, `layer: "supplierCondition"`, `operation: "clear"`를 사용하며 `to` 키는 생략한다. `from`에는 현재 저장된 비어 있지 않은 값을 그대로 넣는다. 다른 필드나 영업정책 층의 삭제는 허용하지 않는다.
- 이 연산은 필드를 명시적 공란인 `null`로 갱신하고 `field_evidence`에 `operation: "clear", value: null`을 남긴다. 이전 값은 기존 백업과 감사 이력에 보존하며 필드·문서를 물리 삭제하지 않는다. 공란을 0%·없음·면책으로 해석하지 않는다. 필드가 사라지거나 빈 문자열로 저장되면 readback 실패이며, 같은 계획의 재실행은 명시적 공란과 근거가 모두 일치할 때만 쓰기 0건이다.
- `policy_extra_terms`는 최대 10,000자의 원문을 줄바꿈·앞뒤 공백까지 보존한다. 일반 자차 면책과 중과실 20%의 적용 대상을 합치거나 새 계산식을 만들지 않는다.
- `own_damage_compensation`은 기존 한도 선택값 외에 최대 500자의 원본 표현도 지원한다. 예를 들어 공제조합·손해보험사 시세 한도와 한도 초과 시 처리 조건을 원문대로 담는다.
- `clear`와 위 두 필드의 원문 표현에는 기존 `source/location/effectiveDate` 외에 원본 SHA256인 `evidence.answerSha256`와 적용 대상을 적은 `evidence.applicability`가 필수다. `location`에는 원본 파일·시트·셀 등 실제 근거 위치를 적는다. 메타데이터만으로 원본 일치가 자동 입증되는 것은 아니므로 실행 담당자가 원본과 대조한다.
- 정책코드·공급사·상품/연령/차종/판본별 적용 범위를 먼저 확인한다. 특정 차량의 월료·보증금·기간·주행거리를 공급사 기본정책으로 옮기지 않는다. 실제 적용은 기존 정확한 계획 digest 승인·writer guard·트랜잭션·백업·감사 경로를 그대로 사용한다.

## 실행

```powershell
$env:POLICY_CORRECTION_PLAN="C:\path\plan.json"
npm.cmd run repair:policy-correction
$env:AUTHORIZE_POLICY_CORRECTION="<DRY_RUN planDigest>"
npm.cmd run repair:policy-correction -- --apply
```

후속 HOLD: 기존 공급사 전용 보정 3개와 매일 수집 경로가 `policy_field_owner: 'policy-corrector'` 문서를 덮지 않도록 별도 차단 로직을 추가해야 한다. 이번 작업은 표시만 남긴다.

## 배움 → 프리패스 데이터 다리 (설계 메모 — 코드는 다음 차례)

카톡 응대 중 공급사가 답한 조건은 지금 ai-ops 의 `state/공급사확인사실.jsonl`(`scripts/세션/공급사사실.ps1 -적기` → `kakao-supplier-facts.mjs record`)과 `docs/공급사정책-<공급사>.md`의 «AI가 배운 조건» 줄(조건·범위·날짜·방·근거 ID `[Lmmddhhmmss-xxxx]`)에만 있다 — 문서에만 있으면 «안 한 것»이다. 이것을 정정기 계획으로 바꾼다.

1. **입력 모으기**: 공급사사실(jsonl: `meta{supplier_code,supplier_room,supplier_sender,inquiry_id}` + `facts[{subject,item,value,note «범위=정책|차량»}]`)과 공급사정책 문서의 배운 조건 줄. 확인 동선 건 번호(`inquiry_id`·질문 ID)가 공통 열쇠.
2. **범위로 가르기**: `범위=정책`만 이 정정기로. `범위=차량`(한 대의 지금 상태)은 차종·제원 정정기/차량 데이터 길로 보낸다.
3. **항목 → 정책 칸 사전**: 항목 이름(«최저 연령»·«연 주행거리 추가»·«추가운전자 범위»·«심사» …)을 `ALLOWED_FIELDS` 칸 이름으로 옮기는 사전 파일 하나(`config/policy-item-field-map.json`, 사람이 검토). 사전에 없는 항목은 계획에서 빼고 «미매핑 목록»으로 낸다(추정으로 칸을 정하지 않는다).
4. **값 정규화**: 답 원문(예 «만 21세 진행 가능»)을 칸 형식(`driver_age_lowering` = «만 21세까지», 금액 = «10만원»)으로 옮기는 규칙은 칸마다 정규식 하나씩(= `ALLOWED_FIELDS` 와 같은 검사로 걸러 냄). 한 값으로 못 옮기면 계획에서 빼고 사람에게 «이 답 원문 → 어떤 값?» 한 줄.
5. **적용 대상 정책코드**: 공급사 코드 → 그 공급사의 정책 문서(`provider_company_code`) 목록. 답이 «전 차량»이면 활성 문서 전부, 상품·기간이 특정이면 해당 정책코드만 — 여럿이고 범위가 안 분명하면 HOLD(질문). 답의 범위를 넓혀 담지 않는다.
6. **계획 만들기**: `from` = 데이터의 지금 저장값 글자 그대로(읽기 전용으로 읽음), `to` = 정규화 값, `evidence = { source:'공급사답', location:'<방 이름> <보낸 사람> <근거 ID> 건 <번호>', effectiveDate:<답한 날>, answerSha256:<카톡 원문 해시> }`. 같은 칸에 답이 둘이면 시행일 늦은 것, 같은 날 충돌이면 HOLD.
7. **시험 digest → 적용**: `npm run repair:policy-correction`(DRY_RUN, planDigest 출력) → 상황실이 `AUTHORIZE_POLICY_CORRECTION=<planDigest>` 로 `--apply`.
8. **닫기**: 적용·되읽기 뒤 공급사정책 문서 줄과 공급사사실에 «담음 <planId>» 표시, 확인 동선 건 «해결:». 이후 문서는 사람이 읽는 사본이고 정본은 프리패스 데이터다(문서 줄을 데이터에서 생성하는 것은 그다음 일).
9. **실패 모드**: 매핑 없음·정규화 불가·범위 불명·`from` 불일치(CONFLICT)·시행일 STALE 은 모두 «계획에서 빠진 목록»으로 상황실에 올린다 — 조용히 건너뛰지 않는다.

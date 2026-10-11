# FreePass Data Trust Scorecard

목표: 대표 기준 `프리패스 데이터 100% - 한눈에 봤을 때 이 차 맞다`를 매일 읽기 전용으로 산출한다. 운영 쓰기, 보정, 공개 차량 식별자 출력은 하지 않는다.

## 정의

| id | 항목 | 기준 | basis | 한계 |
| --- | --- | --- | --- | --- |
| `vehicle-name-spec-confirmed` | 차종·제원 정리율 | 판매 중 차 중 maker, model, sub_model, trim_name, fuel_type, engine_cc가 있고 vehicle master 이름 대조가 통과 | DIRECT | 전기차 배기량 비적용 세부 규칙이 마스터에 없으면 분모에 남는다. |
| `deposit-confirmed` | 보증금 확정율 | 판매 중 가격행 rent > 0 중 compat 보증금 판정이 KNOWN 또는 ZERO | DIRECT | `withCompatibilityDepositEvidence` 결과를 그대로 쓴다. |
| `period-rent-fee-confirmed` | 기간별 대여료·수수료 확정율 | 판매 중 가격행 rent > 0 중 새 Catalog offer의 청구·지급 수수료가 모두 CONFIRMED | DIRECT | Catalog에 없는 차는 분모 포함, 분자 제외. 대여료 확정 단독 비율은 note에 병기한다. |
| `photo-present` | 사진 보유율 | photo_link 또는 image_urls가 http(s)이거나 이안카 공개 사진 판정 통과 | PROXY | ERP5 화면 실제 노출은 오프라인에서 확인하지 못한다. |
| `source-freshness` | 신선도 | sources.expectedFreshnessSeconds 대비 source_heads observedAt/acceptedAt 경과가 2배 이내 | DIRECT | head timestamp가 없으면 실패로 둔다. |
| `status-consistency` | 상태 정확도 | ERP5 상태 사전과 vehicle_status/status/status_kind/listable이 모순 없음 | PROXY | 원천 대조는 박제 도구 확장 필요. |

합계 `all-core`는 판매 중 차 단위로 1, 2, 3, 4가 모두 통과한 비율이다. 보증금과 수수료는 그 차의 모든 rent > 0 가격행이 통과해야 한다. 병목표는 한 항목만 막는 차 수를 항목별로 낸다.

## 실행

수동 실행만 지원한다. 일일 자동화는 다음 PR에서 `data-owned-refresh` 패턴으로 붙인다.

```powershell
$env:TRUST_SCORECARD_OUT_DIR="C:\private\freepass-data-trust-scorecard"
npm.cmd run audit:trust-scorecard
```

출력 파일:

- `YYYYMMDD.json`: 전체 요약, 항목, 원천 신선도 표, 병목표, 차 단위 통과 목록. 차 단위 목록은 hash만 포함한다.
- `summary.json`: ERP5 화면 요약용 최소 공개본. 합계와 항목별 ratio, basis, readAt만 포함하며 차량 식별 정보는 없다.
- stdout: 항목별 numerator/denominator와 digest만 출력한다.

// 막힘(2026-10-04 AI 상황실 사후 검토): 이 실행기는 시험 실행 없이, Catalog 쓰기 주인(EXCLUSIVE) 검사와
// access.write 기록 없이 운영 Firestore·Storage 에 바로 썼다 — «넣는 길 하나» 원칙에 어긋나는 두 번째 쓰기 길이다.
// 기존 차종 마스터 적재 경로(capture-vehicle-master-source → ingest-vehicle-master-source → promote)로 합칠 때까지
// 어떤 환경 변수로도 실행하지 않는다. 정규화·봉인 코드(src/application/*vehicle-reference*)는 합칠 때 다시 쓴다.
// 다음 할 일: docs/NEXT-START-HERE.md «차종 레퍼런스 적재 실행기 막음».
process.stderr.write('VEHICLE_REFERENCE_IMPORT_BLOCKED: 기존 차종 마스터 적재 경로로 합칠 때까지 실행하지 않습니다 (docs/VEHICLE-MASTER-REFERENCE-IMPORT.md)\n');
process.exitCode = 1;

#!/usr/bin/env bash
# 이안카 단발 적용 한 장 — ONE 갱신(synced_at 변화)을 감지하자마자 «계획→건수 관문→적용→되읽기»를 한 번에 돌린다.
# 사용(저장소 최신 main 에서): bash scripts/iancar-apply-once.sh [--dry]   (--dry 는 적용 없이 계획만)
# 비밀은 파일·출력에 두지 않는다: ONE 열쇠는 Secret Manager(freepass-data-iancar-one-api 버전 1)에서 실행 프로세스 환경변수로만 읽는다.
set -euo pipefail
MODE_APPLY=true; [ "${1:-}" = "--dry" ] && MODE_APPLY=false
POLL_SECONDS="${POLL_SECONDS:-20}"          # 감지 간격(목록 1건 조회, 분당 3회 이하)
MAX_WAIT_MINUTES="${MAX_WAIT_MINUTES:-90}"  # 이 시간 안에 갱신이 없으면 포기(ONE 갱신이 최대 약 60분 간격)
OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}/iancar-apply}"; mkdir -p "$OUT_DIR"

KEY="$(gcloud secrets versions access 1 --secret=freepass-data-iancar-one-api --project=freepasserp5 2>/dev/null)"
test -n "$KEY"
synced_at() { curl -s -H "Authorization: Bearer $KEY" 'https://eancarone.com/v1/vehicles?page=1&page_size=1' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).synced_at||"")}catch{console.log("")}})'; }

base="$(synced_at)"; echo "기준 synced_at=$base (변화를 기다림, 최대 ${MAX_WAIT_MINUTES}분)"
deadline=$(( $(date +%s) + MAX_WAIT_MINUTES*60 ))
while :; do
  now="$(synced_at)"
  if [ -n "$now" ] && [ "$now" != "$base" ]; then echo "ONE 갱신 감지: $now"; break; fi
  [ "$(date +%s)" -ge "$deadline" ] && { echo "갱신 없음 — 중단(쓰기 0)"; exit 3; }
  sleep "$POLL_SECONDS"
done

export FIREBASE_PROJECT_ID=freepasserp5
export EANCAR_ONE_API_KEY="$KEY"
export EANCAR_ONE_API_TIMEOUT_MS=45000
export EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET=freepasserp5-data-audit-evidence
# 승인 범위(B안: 노출 중단 8대 보류 유지·사진 제외·PHOTO_PENDING). 필수 7+1 키 전부, 벗어나면 쓰기 전 중단(fail-closed).
export IANCAR_SYNC_EXPECT='{"created":[3,7],"absenceHeld":[11,20],"withdrawalHoldsReleased":[0,0],"open":[78,97],"deletes":[0,0],"contractChanges":[0,0],"policyDocumentChanges":[0,0],"skippedCount":[0,1]}'
ARGS=(--sync --photos-pending --keep-withdrawn)
if [ "$MODE_APPLY" = true ]; then export EANCAR_ONE_SYNC_APPROVED=true; ARGS+=(--apply-sync); fi
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
echo "실행: npx tsx src/jobs/collect-iancar-one-api.ts ${ARGS[*]}  (시작 $stamp)"
set +e
npx tsx src/jobs/collect-iancar-one-api.ts "${ARGS[@]}" > "$OUT_DIR/result-$stamp.json" 2> "$OUT_DIR/error-$stamp.txt"
code=$?
set -e
echo "종료 코드 $code, 결과 파일 $OUT_DIR/result-$stamp.json (비밀 없음)"
node -e '
const s=require("fs").readFileSync(process.argv[1],"utf8");const i=s.indexOf("{\n");if(i<0){console.log("JSON 없음 — 오류 파일 확인");process.exit(0)}
const j=JSON.parse(s.slice(i));console.log("상태",j.status,"원천 갱신",j.syncedAt||j.publication?.sourceSyncedAt);
const p=j.publicationPlan||{};console.log("계획",JSON.stringify({원천:p.sourceCount,연결:p.matched,신규:p.created,공개보류:p.absenceHeld,해제:p.withdrawalHoldsReleased,사진확인중:p.photoPendingMarked,보류유지:p.keptWithdrawn,노출:p.open,잠금건너뜀:p.skippedCount,삭제:p.deletes,계약변경:p.contractChanges,정책변경:p.policyDocumentChanges,digest:p.planDigest}));
if(j.publication)console.log("적용",JSON.stringify({상태:j.publication.status,노출:j.publication.open,신규:j.publication.created,공개보류:j.publication.absenceHeld,백업:j.publication.privateBackupObject,runId:j.publication.runId}));
if(j.reasons)console.log("중단 사유",j.reasons.join(","))' "$OUT_DIR/result-$stamp.json"
exit "$code"

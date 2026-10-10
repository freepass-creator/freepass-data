#!/usr/bin/env bash
# 가장 최근에 끝난 매시 감사(erp5-continuous-audit)의 daily-writer-guard 결과 한 줄을 낸다: "<결론> <끝난 시각>".
# 결과가 없으면 "missing -". 목록·job 조회가 실패하면 종료 코드 1(호출 쪽이 «읽지 못함»으로 처리).
# shared-sheet-daily 의 audit-refresh 와 관문 두 곳이 이 한 곳만 쓴다(읽는 방법이 둘로 갈라지지 않게).
set -euo pipefail
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
ids="$(gh api "repos/$repo/actions/workflows/erp5-continuous-audit.yml/runs?branch=main&per_page=5" --jq '.workflow_runs[].id')"
tmp="$(mktemp)"
: > "$tmp"
for id in $ids; do
  gh api "repos/$repo/actions/runs/$id/jobs?per_page=100" \
    --jq '.jobs[] | select(.name == "daily-writer-guard" and .status == "completed") | {conclusion, completed_at}' >> "$tmp"
done
jq -rs 'sort_by(.completed_at) | last // {} | "\(.conclusion // "missing") \(.completed_at // "-")"' "$tmp"

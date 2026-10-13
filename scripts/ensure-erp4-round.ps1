# ERP4 풀 회차(erp5-ssot-refresh) 누락 보완 — GitHub schedule 이 3시간 이상 비는 일이 반복돼 마지막 run 이 오래되면 한 번 dispatch 한다.
# 읽기 전용이 기본: -Dispatch 를 줘야 workflow_dispatch 를 보낸다. 같은 워크플로가 이미 돌고 있거나 대기 중이면 건너뛴다.
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-erp4-round.ps1 [-Repo owner/repo] [-MaxAgeMinutes 75] [-Dispatch]
param(
  [string]$Repo = $env:ERP4_REPO,
  [string]$Workflow = 'erp5-ssot-refresh.yml',
  [int]$MaxAgeMinutes = 75,
  [switch]$Dispatch
)
$ErrorActionPreference = 'Stop'
if (-not $Repo) { throw 'ERP4_REPO_REQUIRED' }
$runs = gh run list --repo $Repo --workflow $Workflow --limit 10 --json databaseId,status,conclusion,createdAt,event | ConvertFrom-Json
if (-not $runs) { throw 'NO_RUNS_FOUND' }
$active = @($runs | Where-Object { $_.status -in 'in_progress', 'queued', 'waiting', 'requested', 'pending' })
$last = $runs | Sort-Object { [datetime]$_.createdAt } -Descending | Select-Object -First 1
$ageMin = [int]((Get-Date).ToUniversalTime() - ([datetime]$last.createdAt).ToUniversalTime()).TotalMinutes
$result = [ordered]@{ checkedAt = (Get-Date).ToUniversalTime().ToString('o'); lastRunId = $last.databaseId; lastEvent = $last.event; lastStatus = $last.status
  lastConclusion = $last.conclusion; lastAgeMinutes = $ageMin; activeRuns = $active.Count; maxAgeMinutes = $MaxAgeMinutes; action = 'NONE' }
if ($active.Count -gt 0) { $result.action = 'SKIP_ACTIVE_RUN' }
elseif ($ageMin -le $MaxAgeMinutes) { $result.action = 'SKIP_RECENT' }
elseif ($Dispatch) { gh workflow run $Workflow --repo $Repo | Out-Null; $result.action = 'DISPATCHED' }
else { $result.action = 'WOULD_DISPATCH' }
$result | ConvertTo-Json -Compress

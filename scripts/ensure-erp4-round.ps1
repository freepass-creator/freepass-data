# ERP4 풀 회차(erp5-ssot-refresh) 누락 보완 — GitHub schedule 이 오래 비는 일이 반복돼(손오공 RP012 STALE 의 원인) 마지막 run 이 오래되면 한 번 dispatch 한다.
# 기본은 읽기 전용(WOULD_DISPATCH 만 출력). -Dispatch 를 줘야 workflow_dispatch(입력 없음 = 판매시트 게시 안 함)를 보낸다.
# 가드(커맨드 센터 승인 2026-10-14):
#  - 마지막 run 이 MaxAgeMinutes(기본 75) 초과이고 진행 중/대기 중 run 이 없을 때만 발송
#  - 시간당 최대 1회(발송 이력 로그 기준)
#  - 직전 발송 3건의 수집(쓰기) 단계가 모두 성공하지 못했으면 발송을 멈추고 STOP_CONSECUTIVE_FAILURES 로 보고
#  - 모든 판단·발송은 로그(JSONL)에 한 줄씩 남긴다
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-erp4-round.ps1 -Repo owner/repo [-MaxAgeMinutes 75] [-LogPath <파일>] [-Dispatch]
param(
  [string]$Repo = $env:ERP4_REPO,
  [string]$Workflow = 'erp5-ssot-refresh.yml',
  [int]$MaxAgeMinutes = 75,
  [string]$LogPath,
  [switch]$Dispatch
)
$ErrorActionPreference = 'Stop'
# gh 출력(한글 워크플로·단계 이름)을 PowerShell 5.1 기본 코드페이지(CP949)로 읽으면 JSON 이 깨진다(2026-10-14 B3Q 실측). UTF-8 로 고정한다.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $Repo) { throw 'ERP4_REPO_REQUIRED' }
if (-not $LogPath) {
  $dir = if ($env:SOURCE_CYCLE_PRIVATE_DIR) { $env:SOURCE_CYCLE_PRIVATE_DIR } else { Join-Path $env:USERPROFILE '.codex\private\source-cycle' }
  $LogPath = Join-Path $dir 'erp4-round-dispatch.jsonl'
}
$collectionStep = '원천에서 ERP5 현재 원자 계산'
$now = (Get-Date).ToUniversalTime()
$runs = gh run list --repo $Repo --workflow $Workflow --limit 20 --json databaseId,status,conclusion,createdAt,event | ConvertFrom-Json
if (-not $runs) { throw 'NO_RUNS_FOUND' }
$active = @($runs | Where-Object { $_.status -in 'in_progress', 'queued', 'waiting', 'requested', 'pending' })
$last = $runs | Sort-Object { [datetime]$_.createdAt } -Descending | Select-Object -First 1
# 나이 기준은 «마지막 run» 이 아니라 «수집(쓰기) 단계가 마지막으로 성공한 run»이다: 이안카 단독 회차(IANCAR_ONLY)는 수집 단계를 돌지 않아
# 단독 회차만 성공해도 RP012·RP023 은 STALE 로 남는다. 최근 완료 run 최대 8개의 단계를 최신순으로 훑는다.
$basis = $null
foreach ($run in ($runs | Where-Object { $_.status -eq 'completed' } | Sort-Object { [datetime]$_.createdAt } -Descending | Select-Object -First 8)) {
  $jobs = gh api "repos/$Repo/actions/runs/$($run.databaseId)/jobs" | ConvertFrom-Json
  $step = $jobs.jobs | ForEach-Object { $_.steps } | Where-Object { $_.name -eq $collectionStep -and $_.conclusion -eq 'success' } | Select-Object -First 1
  if ($step -and $step.completed_at) { $basis = ([datetime]$step.completed_at).ToUniversalTime(); break }
}
$ageMin = if ($basis) { [int]($now - $basis).TotalMinutes } else { 100000 }   # 성공 run 이 없으면 매우 오래된 것으로 본다(발송 후보)
# 발송 이력(최근 순)
$history = @()
if (Test-Path -LiteralPath $LogPath) {
  $history = @(Get-Content -LiteralPath $LogPath -Encoding UTF8 | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } |
    Where-Object { $_ -and $_.action -eq 'DISPATCHED' } | Sort-Object { [datetime]$_.checkedAt } -Descending)
}
$lastDispatch = $history | Select-Object -First 1
$sinceDispatchMin = if ($lastDispatch) { [int]($now - ([datetime]$lastDispatch.checkedAt).ToUniversalTime()).TotalMinutes } else { $null }
# 직전 발송 3건의 수집 단계 결과: 발송 시각 직후(10분 안) 시작된 workflow_dispatch run 의 수집 단계 conclusion
$collectionOk = {
  param($entry)
  $at = ([datetime]$entry.checkedAt).ToUniversalTime()
  $run = $runs | Where-Object { $_.event -eq 'workflow_dispatch' -and ([datetime]$_.createdAt).ToUniversalTime() -ge $at.AddSeconds(-30) -and ([datetime]$_.createdAt).ToUniversalTime() -le $at.AddMinutes(10) } |
    Sort-Object { [datetime]$_.createdAt } | Select-Object -First 1
  if (-not $run -or $run.status -ne 'completed') { return $null }          # 아직 판단 불가
  $jobs = gh api "repos/$Repo/actions/runs/$($run.databaseId)/jobs" | ConvertFrom-Json
  $step = $jobs.jobs | ForEach-Object { $_.steps } | Where-Object { $_.name -eq $collectionStep } | Select-Object -First 1
  return ($step -and $step.conclusion -eq 'success')
}
$result = [ordered]@{ checkedAt = $now.ToString('o'); lastRunId = $last.databaseId; lastEvent = $last.event; lastStatus = $last.status
  lastConclusion = $last.conclusion; lastCollectionSuccessAt = $(if ($basis) { $basis.ToString("o") } else { $null }); lastAgeMinutes = $ageMin; activeRuns = $active.Count; maxAgeMinutes = $MaxAgeMinutes;
  minutesSinceLastDispatch = $sinceDispatchMin; action = 'NONE' }
if ($active.Count -gt 0) { $result.action = 'SKIP_ACTIVE_RUN' }
elseif ($ageMin -le $MaxAgeMinutes) { $result.action = 'SKIP_RECENT' }
elseif ($null -ne $sinceDispatchMin -and $sinceDispatchMin -lt 60) { $result.action = 'SKIP_HOURLY_LIMIT' }
else {
  $recent = @($history | Select-Object -First 3)
  $failedInRow = $false
  if ($recent.Count -ge 3) {
    $outcomes = @($recent | ForEach-Object { & $collectionOk $_ })
    $failedInRow = (@($outcomes | Where-Object { $_ -eq $false }).Count -eq 3)
  }
  if ($failedInRow) { $result.action = 'STOP_CONSECUTIVE_FAILURES' }
  elseif ($Dispatch) { gh workflow run $Workflow --repo $Repo | Out-Null; $result.action = 'DISPATCHED' }
  else { $result.action = 'WOULD_DISPATCH' }
}
$line = $result | ConvertTo-Json -Compress
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
$line
if ($result.action -eq 'STOP_CONSECUTIVE_FAILURES') { exit 2 }

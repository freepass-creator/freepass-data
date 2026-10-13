param(
  [string]$Runtime,
  [string]$TaskName = 'FreePass-Source-Cycle',
  [switch]$OnlyWhenSynced,
  [string]$AcceptDrift,
  [switch]$Unattended,
  [string]$EnvFile,
  [int]$IntervalMinutes = 60,
  [switch]$Register
)
# 대표 2026-10-13: ERP5 원천 반영은 개발 PC(B3Q) 작업 스케줄러에서 1시간 간격(기본 60분) 무인 적용.
#  -Unattended : scripts\run-source-cycle.ps1 을 예약(계획→적용까지 한 회차). -EnvFile 로 비공개 env 파일(저장소 밖) 지정.
#  -Runtime    : 옛 계획 전용 경로(dist\src\jobs\source-cycle.js --runtime …, 적용 없음).
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
if ($IntervalMinutes -lt 1 -or $IntervalMinutes -gt 1439) { throw 'IntervalMinutes must be 1..1439.' }
if ($TaskName.Contains('"')) { throw 'Invalid argument quote.' }
if ($Unattended) {
  if ($Runtime) { throw 'Use either -Unattended or -Runtime, not both.' }
  $runner = Join-Path $PSScriptRoot 'run-source-cycle.ps1'
  $job = Join-Path $repo 'dist\src\runtime\source-cycle-runtime.js'
  if (!(Test-Path -LiteralPath $job)) { throw 'Run npm.cmd run build first.' }
  $pwsh = (Get-Command powershell.exe -ErrorAction Stop).Source
  $taskCommand = '"' + $pwsh + '" -NoProfile -ExecutionPolicy Bypass -File "' + $runner + '"'
  if ($EnvFile) {
    $envPath = (Resolve-Path -LiteralPath $EnvFile).Path
    if ($envPath.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'EnvFile must live outside the repository.' }
    if ($envPath.Contains('"')) { throw 'Invalid argument quote.' }
    $taskCommand += ' -EnvFile "' + $envPath + '"'
  }
  if ($OnlyWhenSynced) { $taskCommand += ' -OnlyWhenSynced' }
  if ($AcceptDrift) {
    if ($AcceptDrift -notmatch '^RP\d{3}(,RP\d{3})*$') { throw 'ACCEPT_DRIFT_CODE_INVALID' }
    $taskCommand += ' -AcceptDrift ' + $AcceptDrift
  }
} else {
  if (!$Runtime) { throw 'Runtime is required unless -Unattended.' }
  $runtimePath = (Resolve-Path -LiteralPath $Runtime).Path
  $job = Join-Path $repo 'dist\src\jobs\source-cycle.js'
  if (!(Test-Path -LiteralPath $job)) { throw 'Run npm.cmd run build first.' }
  if ($runtimePath.Contains('"')) { throw 'Invalid argument quote.' }
  $taskCommand = '"' + $node + '" "' + $job + '" --runtime "' + $runtimePath + '"'
  if ($OnlyWhenSynced) { $taskCommand += ' --only-when-synced' }
}
$taskArgs = @('/Create', '/TN', $TaskName, '/SC', 'MINUTE', '/MO', "$IntervalMinutes", '/TR', $taskCommand)
# No /F: never silently overwrite an existing user task. No stored credentials or elevated account.
if (!$Register) { Write-Output ('DRY_RUN schtasks.exe ' + ($taskArgs -join ' ')); exit 0 }
& schtasks.exe @taskArgs
if ($LASTEXITCODE -ne 0) { throw 'Task registration failed.' }

param(
  [string]$EnvFile,
  [switch]$OnlyWhenSynced,
  [string]$Source
)
# 원천 엔진 무인 회차 실행기(작업 스케줄러가 부른다). 대표 2026-10-13: ERP5 원천 반영을 개발 PC 에서 1시간 간격 무인 적용.
#  - EnvFile: 저장소 밖 비공개 PowerShell 파일. $env:FIREBASE_PROJECT_ID, $env:SOURCE_CYCLE_SOURCES, $env:SOURCE_CYCLE_PRIVATE_DIR,
#             $env:SOURCE_CYCLE_*_SHEET_ID 등을 설정한다. 비밀값은 저장소에 두지 않는다.
#  - 무인 적용은 $env:SOURCE_CYCLE_UNATTENDED = '1' 과 --unattended 둘 다 있어야 켜진다(코드 가드).
#  - 결과 한 줄(JSON)을 $env:SOURCE_CYCLE_PRIVATE_DIR\unattended-runs.jsonl 에 남긴다. 원문·토큰은 기록하지 않는다.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ($EnvFile) {
  $envPath = (Resolve-Path -LiteralPath $EnvFile).Path
  if ($envPath.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'EnvFile must live outside the repository.' }
  . $envPath
}
if (!$env:SOURCE_CYCLE_SOURCES) { throw 'SOURCE_CYCLE_SOURCES is required (set it in EnvFile or user environment).' }
$env:SOURCE_CYCLE_UNATTENDED = '1'
if (!$env:NODE_ENV) { $env:NODE_ENV = 'production' }
$job = Join-Path $repo 'dist\src\runtime\source-cycle-runtime.js'
if (!(Test-Path -LiteralPath $job)) { throw 'Run npm.cmd run build first.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
# 사전점검(대표 10-13 「왜 자꾸 멈추냐」 — 예약 환경에 gws·gcloud 토큰이 없어 AUTH_FAILED 로 멈춘 사고): 회차를 돌리기 전에
# 시트 읽기 gws 와 gcloud 사용자 토큰을 확인하고, 없으면 원천별 AUTH_FAILED 로 3회 정지시키지 말고 환경 오류 한 줄로 끝낸다.
$privateDir = $env:SOURCE_CYCLE_PRIVATE_DIR
if (!$privateDir) { $privateDir = Join-Path $env:USERPROFILE '.codex\private\source-cycle' }
if (!(Test-Path -LiteralPath $privateDir)) { New-Item -ItemType Directory -Path $privateDir -Force | Out-Null }
$preflight = @()
if ($env:SOURCE_CYCLE_SOURCES -match 'F05|AICA') {
  $gws = $env:GWS_BIN
  if (!$gws) { $gws = (Get-Command gws.cmd -ErrorAction SilentlyContinue).Source }
  if (!$gws -or !(Test-Path -LiteralPath $gws)) { $preflight += 'PREFLIGHT_GWS_MISSING' }
}
$gcloud = (Get-Command gcloud.cmd -ErrorAction SilentlyContinue).Source
if (!$gcloud) { $preflight += 'PREFLIGHT_GCLOUD_MISSING' }
else {
  $token = & $gcloud auth print-access-token 2>$null
  if ($LASTEXITCODE -ne 0 -or !$token) { $preflight += 'PREFLIGHT_GCLOUD_TOKEN_MISSING' }
  $token = $null
}
if ($preflight.Count -gt 0) {
  $line = @{ started = (Get-Date).ToUniversalTime().ToString('o'); finished = (Get-Date).ToUniversalTime().ToString('o'); exit = 1; preflight = ($preflight -join ',') } | ConvertTo-Json -Compress
  Add-Content -LiteralPath (Join-Path $privateDir 'unattended-runs.jsonl') -Value $line -Encoding UTF8
  Add-Content -LiteralPath (Join-Path $privateDir 'alerts.jsonl') -Value (@{ source = 'RUNNER'; reason = ($preflight -join ','); at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress) -Encoding UTF8
  Write-Output $line
  exit 1
}
$cliArgs = @($job, '--unattended')
if ($OnlyWhenSynced) { $cliArgs += '--only-when-synced' }
if ($Source) { $cliArgs += @('--source', $Source) }
$started = (Get-Date).ToUniversalTime().ToString('o')
$stdout = & $node @cliArgs 2>$null
$exit = $LASTEXITCODE
$privateDir = $env:SOURCE_CYCLE_PRIVATE_DIR
if (!$privateDir) { $privateDir = Join-Path $env:USERPROFILE '.codex\private\source-cycle' }
if (!(Test-Path -LiteralPath $privateDir)) { New-Item -ItemType Directory -Path $privateDir -Force | Out-Null }
# 회차 뒤 신선도 판정(heartbeats 기준, 기본 120분). 정상이 아니면 freshness.status 가 UNHEALTHY 로 남고 종료 코드도 1.
$freshness = & $node (Join-Path $repo 'scripts\check-source-freshness.mjs') --dir $privateDir 2>$null
if ($LASTEXITCODE -ne 0 -and $exit -eq 0) { $exit = 1 }
$line = @{ started = $started; finished = (Get-Date).ToUniversalTime().ToString('o'); exit = $exit; report = ($stdout -join ''); freshness = ($freshness -join '') } | ConvertTo-Json -Compress
Add-Content -LiteralPath (Join-Path $privateDir 'unattended-runs.jsonl') -Value $line -Encoding UTF8
Write-Output $line
exit $exit

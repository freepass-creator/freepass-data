param(
  [string]$EnvFile,
  [switch]$OnlyWhenSynced,
  [string]$Source,
  [string]$AcceptDrift
)
# 원천 엔진 무인 회차 실행기(작업 스케줄러가 부른다). 대표 2026-10-13: ERP5 원천 반영을 개발 PC 에서 1시간 간격 무인 적용.
# 이 스크립트는 환경 파일을 읽어 node 를 부르고 종료 코드를 전달하는 것만 한다. 사전점검·계획·적용·신선도 판정·실행 기록은
# 전부 src/runtime/source-cycle-runtime.ts(runUnattended)가 하고, 결과는 $env:SOURCE_CYCLE_PRIVATE_DIR\unattended-runs.jsonl 에 남는다.
#  - EnvFile: 저장소 밖 비공개 PowerShell 파일($env:FIREBASE_PROJECT_ID, SOURCE_CYCLE_SOURCES, SOURCE_CYCLE_*_SHEET_ID, SHEETS_TRANSPORT, GWS_BIN …).
#  - 무인 적용은 $env:SOURCE_CYCLE_UNATTENDED = '1' 과 --unattended 둘 다 있어야 켜진다(코드 가드).
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ($EnvFile) {
  $envPath = (Resolve-Path -LiteralPath $EnvFile).Path
  if ($envPath.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'EnvFile must live outside the repository.' }
  . $envPath
}
$job = Join-Path $repo 'dist\src\runtime\source-cycle-runtime.js'
if (!(Test-Path -LiteralPath $job)) { throw 'Run npm.cmd run build first.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$env:SOURCE_CYCLE_UNATTENDED = '1'
if (!$env:NODE_ENV) { $env:NODE_ENV = 'production' }
$cliArgs = @($job, '--unattended')
if ($OnlyWhenSynced) { $cliArgs += '--only-when-synced' }
if ($Source) { $cliArgs += @('--source', $Source) }
if ($AcceptDrift) {
  if ($AcceptDrift -notmatch '^RP\d{3}(,RP\d{3})*$') { throw 'ACCEPT_DRIFT_CODE_INVALID' }
  $cliArgs += @('--accept-drift', $AcceptDrift)
}
& $node @cliArgs
exit $LASTEXITCODE

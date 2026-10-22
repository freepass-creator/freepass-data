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
if ($Source) {
  $cliArgs += @('--source', $Source)
  $env:SOURCE_CYCLE_TAKEOVER = '0'   # 단독 원천 예약은 죽은 잠금 인계 권한이 없다(인계자는 전체 정시 예약 하나)
}
if ($AcceptDrift) {
  if ($AcceptDrift -notmatch '^RP\d{3}(,RP\d{3})*$') { throw 'ACCEPT_DRIFT_CODE_INVALID' }
  $cliArgs += @('--accept-drift', $AcceptDrift)
}
& $node @cliArgs
$cycleExit = $LASTEXITCODE
# 사진 폴더 연결 «계획만» 단계(2026-10-22 PC1 커맨드 승인): SOURCE_CYCLE_PHOTO_PLAN_CODES(쉼표 공급사 코드)가 있을 때만, 회차가 끝난 뒤 공급사별로 계획(쓰기 0, --apply 를 넘기지 않는다)을 돌려
# 비공개 디렉터리 photo-plan.log 에 요약만 남긴다. 단계 전체가 예외·시간 초과(공급사당 3분, 전체 10분)와 격리돼 회차 종료 코드·결과에 영향을 주지 않는다.
try {
  if ($env:SOURCE_CYCLE_PHOTO_PLAN_CODES -and $env:SOURCE_CYCLE_PRIVATE_DIR) {
    $ErrorActionPreference = 'Continue'
    $photoScript = Join-Path $repo 'scripts\ops\photo-cache-from-folder.mjs'
    $photoLog = Join-Path $env:SOURCE_CYCLE_PRIVATE_DIR 'photo-plan.log'
    $photoDeadline = (Get-Date).AddMinutes(10)
    foreach ($photoCode in ($env:SOURCE_CYCLE_PHOTO_PLAN_CODES -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^(RP|PT-)\d{3,4}$' })) {
      if ((Get-Date) -gt $photoDeadline) { Add-Content -LiteralPath $photoLog -Encoding UTF8 -Value ('[{0}] 전체 시간 초과로 {1} 이후 생략' -f (Get-Date -Format o), $photoCode); break }
      $photoText = ''
      try {
        $photoJob = Start-Job -ScriptBlock { param($n, $s, $c) & $n $s "--code=$c" 2>&1 | Out-String } -ArgumentList $node, $photoScript, $photoCode
        if (Wait-Job -Job $photoJob -Timeout 180) { $photoText = [string](Receive-Job -Job $photoJob) } else { $photoText = '시간 초과(3분)'; Stop-Job -Job $photoJob }
        Remove-Job -Job $photoJob -Force
      } catch { $photoText = '실행 실패' }
      $photoLines = @($photoText -split "`r?`n" | Where-Object { $_ -match '^(PLAN|\d{4} |시간 초과|실행 실패)' } | Select-Object -First 40)
      try { Add-Content -LiteralPath $photoLog -Encoding UTF8 -Value ('[{0}] {1}' -f (Get-Date -Format o), $photoCode); if ($photoLines.Count) { Add-Content -LiteralPath $photoLog -Encoding UTF8 -Value ($photoLines -join [Environment]::NewLine) } } catch { }
    }
  }
} catch { }
exit $cycleExit

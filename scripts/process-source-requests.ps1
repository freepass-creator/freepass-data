param(
  [string]$EnvFile,
  [string]$RequestDir,
  [int]$MinIntervalMinutes = 5
)
# Immediate source-cycle request processor (run by a 5-minute scheduled task on the operating PC).
# A request is a small JSON file dropped into the request directory:
#   { "source": "RP012", "requestedAt": "2026-10-14T01:30:00Z", "by": "free text, no secrets" }
# For each valid request this script runs scripts/run-source-cycle.ps1 -Source <code> ONCE and moves the file to
# processed/ (or rejected/ when invalid). It never writes products itself, never changes locks, and never takes over
# a dead lock: -Source runs only report DEAD_LOCK_HELD (see run-source-cycle.ps1).
# Safety:
#   - source code must match ^RP\d{3}$ and be in the allow-list file allowed-sources.txt (one code per line) in the request dir;
#   - one request per source per MinIntervalMinutes (IANCAR-like 429 history): newer duplicates are merged, too-frequent ones deferred;
#   - requests older than 2 hours are rejected (stale instruction);
#   - a single run of this script processes at most 6 sources and uses a mutex so two task instances never overlap.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $RequestDir) { throw 'RequestDir is required (a private directory outside the repository).' }
$dir = (Resolve-Path -LiteralPath $RequestDir).Path
if ($dir.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'RequestDir must live outside the repository.' }
$processed = Join-Path $dir 'processed'; $rejected = Join-Path $dir 'rejected'
New-Item -ItemType Directory -Force -Path $processed, $rejected | Out-Null

$mutex = New-Object System.Threading.Mutex($false, 'Global\FreePassSourceRequests')
if (-not $mutex.WaitOne(0)) { Write-Output 'SOURCE_REQUESTS_ALREADY_RUNNING'; exit 0 }
try {
  $allowedFile = Join-Path $dir 'allowed-sources.txt'
  $allowed = @()
  if (Test-Path -LiteralPath $allowedFile) { $allowed = @(Get-Content -LiteralPath $allowedFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^RP\d{3}$' }) }
  $stateFile = Join-Path $dir 'last-run.json'
  $last = @{}
  if (Test-Path -LiteralPath $stateFile) {
    try { (Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $last[$_.Name] = [datetime]$_.Value } } catch { $last = @{} }
  }
  $runner = Join-Path $PSScriptRoot 'run-source-cycle.ps1'
  $now = [datetime]::UtcNow
  $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | Where-Object { $_.Name -ne 'last-run.json' } | Sort-Object LastWriteTimeUtc)
  $bySource = @{}
  foreach ($file in $files) {
    $reason = $null; $req = $null
    try { $req = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json } catch { $reason = 'JSON_INVALID' }
    if (-not $reason) {
      $code = [string]$req.source
      $at = $null
      try { $at = ([datetime]$req.requestedAt).ToUniversalTime() } catch { $reason = 'REQUESTED_AT_INVALID' }
      if (-not $reason -and $code -notmatch '^RP\d{3}$') { $reason = 'SOURCE_CODE_INVALID' }
      elseif (-not $reason -and $allowed -notcontains $code) { $reason = 'SOURCE_NOT_ALLOWED' }
      elseif (-not $reason -and ($now - $at).TotalMinutes -gt 120) { $reason = 'REQUEST_STALE' }
      elseif (-not $reason -and ($at - $now).TotalMinutes -gt 5) { $reason = 'REQUESTED_AT_FUTURE' }
    }
    if ($reason) {
      Move-Item -LiteralPath $file.FullName -Destination (Join-Path $rejected ("{0}.{1}.{2}" -f $file.BaseName, $reason, $file.Extension.TrimStart('.'))) -Force
      Write-Output "REJECTED $($file.Name) $reason"
      continue
    }
    if (-not $bySource.ContainsKey($code)) { $bySource[$code] = New-Object System.Collections.ArrayList }
    [void]$bySource[$code].Add($file)
  }
  $ran = 0
  foreach ($code in ($bySource.Keys | Sort-Object)) {
    $group = $bySource[$code]
    if ($last.ContainsKey($code) -and ($now - $last[$code]).TotalMinutes -lt $MinIntervalMinutes) {
      Write-Output "DEFERRED $code (min interval $MinIntervalMinutes min)"
      continue    # files stay in place and are retried by the next 5-minute run
    }
    if ($ran -ge 6) { Write-Output "DEFERRED $code (per-run limit)"; continue }
    $ran++
    $runArgs = @('-Source', $code)
    if ($EnvFile) { $runArgs = @('-EnvFile', $EnvFile) + $runArgs }
    & $runner @runArgs
    $exit = $LASTEXITCODE
    $last[$code] = $now
    foreach ($file in $group) {
      Move-Item -LiteralPath $file.FullName -Destination (Join-Path $processed ("{0}.exit{1}.json" -f $file.BaseName, $exit)) -Force
    }
    Write-Output "RAN $code exit=$exit requests=$($group.Count)"
  }
  $out = @{}; foreach ($k in $last.Keys) { $out[$k] = $last[$k].ToString('o') }
  ($out | ConvertTo-Json -Compress) | Set-Content -LiteralPath $stateFile -Encoding UTF8
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
exit 0

param(
  [string]$EnvFile,
  [string]$RequestDir,
  [int]$MinIntervalMinutes = 5,
  [int]$MaxAttempts = 3
)
# Immediate source-cycle request processor (run by a 5-minute scheduled task on the operating PC).
# A request is a small JSON file dropped into the request directory:
#   { "source": "RP012", "requestedAt": "2026-10-14T01:30:00Z", "by": "free text, no secrets" }
# For each valid request this script runs scripts/run-source-cycle.ps1 -Source <code> ONCE. It never writes products itself,
# never changes locks and never takes over a dead lock (-Source runs only report DEAD_LOCK_HELD).
# Delivery semantics (independent review round 4):
#   - a request is CLAIMED (moved to inflight/) BEFORE the run; if this script dies mid-run the claimed file is never re-run
#     automatically - the next invocation moves it to processed/ as ".unknown" (operator re-requests if needed). No duplicate runs.
#   - the run result decides the outcome: exit 0 => processed/; non-zero (including a LOCKED/HOLD skip) => the request is put
#     back and retried on the next invocation, up to MaxAttempts, then rejected/ as EXHAUSTED. A request is never silently consumed.
#   - last-run.json is written atomically (temp + rename); a damaged file is moved aside, not silently treated as empty history.
#   - allowed-sources.txt lines: "RP012" or "RP031:15" (per-source minimum minutes). RP031 (Iancar, 429 history) defaults to 15.
#   - requests older than 2 hours or dated in the future are rejected; at most 6 sources per invocation; a mutex prevents overlap.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $RequestDir) { throw 'RequestDir is required (a private directory outside the repository).' }
$dir = (Resolve-Path -LiteralPath $RequestDir).Path
if ($dir.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'RequestDir must live outside the repository.' }
$processed = Join-Path $dir 'processed'; $rejected = Join-Path $dir 'rejected'; $inflight = Join-Path $dir 'inflight'
New-Item -ItemType Directory -Force -Path $processed, $rejected, $inflight | Out-Null

$mutex = New-Object System.Threading.Mutex($false, 'Global\FreePassSourceRequests')
if (-not $mutex.WaitOne(0)) { Write-Output 'SOURCE_REQUESTS_ALREADY_RUNNING'; exit 0 }
try {
  # A claimed file left over from a crashed run: it may or may not have executed - never re-run it automatically.
  foreach ($stale in @(Get-ChildItem -LiteralPath $inflight -File -ErrorAction SilentlyContinue)) {
    Move-Item -LiteralPath $stale.FullName -Destination (Join-Path $processed ($stale.BaseName + '.unknown.json')) -Force
    Write-Output "UNKNOWN_OUTCOME $($stale.Name)"
  }
  $allowedFile = Join-Path $dir 'allowed-sources.txt'
  $allowed = @{}
  if (Test-Path -LiteralPath $allowedFile) {
    foreach ($line in (Get-Content -LiteralPath $allowedFile)) {
      $t = $line.Trim()
      if ($t -match '^(RP\d{3})(:(\d{1,3}))?$') { $allowed[$Matches[1]] = if ($Matches[3]) { [int]$Matches[3] } else { $MinIntervalMinutes } }
    }
  }
  if ($allowed.ContainsKey('RP031') -and $allowed['RP031'] -lt 15) { $allowed['RP031'] = 15 }   # enforced floor for Iancar
  $stateFile = Join-Path $dir 'last-run.json'
  $last = @{}; $attempts = @{}
  if (Test-Path -LiteralPath $stateFile) {
    try {
      $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
      if ($state.last) { $state.last.PSObject.Properties | ForEach-Object { $last[$_.Name] = [datetime]$_.Value } }
      if ($state.attempts) { $state.attempts.PSObject.Properties | ForEach-Object { $attempts[$_.Name] = [int]$_.Value } }
    } catch {
      Move-Item -LiteralPath $stateFile -Destination (Join-Path $dir ('last-run.damaged.' + [guid]::NewGuid().ToString('N') + '.json')) -Force
      Write-Output 'STATE_DAMAGED_MOVED_ASIDE'
    }
  }
  $save = {
    $o = @{ last = @{}; attempts = @{} }
    foreach ($k in $last.Keys) { $o.last[$k] = $last[$k].ToString('o') }
    foreach ($k in $attempts.Keys) { $o.attempts[$k] = $attempts[$k] }
    $tmp = $stateFile + '.' + $PID + '.tmp'
    ($o | ConvertTo-Json -Depth 4 -Compress) | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $stateFile -Force
  }
  $runner = Join-Path $PSScriptRoot 'run-source-cycle.ps1'
  $now = [datetime]::UtcNow
  $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | Where-Object { $_.Name -notlike 'last-run*' } | Sort-Object LastWriteTimeUtc)
  $bySource = @{}
  foreach ($file in $files) {
    $reason = $null; $req = $null; $code = $null
    try { $req = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json } catch { $reason = 'JSON_INVALID' }
    if (-not $reason) {
      $code = [string]$req.source
      $at = $null
      try { $at = ([datetime]$req.requestedAt).ToUniversalTime() } catch { $reason = 'REQUESTED_AT_INVALID' }
      if (-not $reason -and $code -notmatch '^RP\d{3}$') { $reason = 'SOURCE_CODE_INVALID' }
      elseif (-not $reason -and -not $allowed.ContainsKey($code)) { $reason = 'SOURCE_NOT_ALLOWED' }
      elseif (-not $reason -and ($now - $at).TotalMinutes -gt 120) { $reason = 'REQUEST_STALE' }
      elseif (-not $reason -and ($at - $now).TotalMinutes -gt 5) { $reason = 'REQUESTED_AT_FUTURE' }
    }
    if ($reason) {
      Move-Item -LiteralPath $file.FullName -Destination (Join-Path $rejected ("{0}.{1}.json" -f $file.BaseName, $reason)) -Force
      Write-Output "REJECTED $($file.Name) $reason"
      continue
    }
    if (-not $bySource.ContainsKey($code)) { $bySource[$code] = New-Object System.Collections.ArrayList }
    [void]$bySource[$code].Add($file)
  }
  $ran = 0
  foreach ($code in ($bySource.Keys | Sort-Object)) {
    $group = $bySource[$code]
    $interval = $allowed[$code]
    if ($last.ContainsKey($code) -and ($now - $last[$code]).TotalMinutes -lt $interval) {
      Write-Output "DEFERRED $code (min interval $interval min)"
      continue    # files stay in place and are retried by the next run
    }
    if ($ran -ge 6) { Write-Output "DEFERRED $code (per-run limit)"; continue }
    $ran++
    # Claim BEFORE running so a crash can never cause a duplicate run.
    $claimed = @()
    foreach ($file in $group) {
      $dest = Join-Path $inflight $file.Name
      Move-Item -LiteralPath $file.FullName -Destination $dest -Force
      $claimed += $dest
    }
    $runArgs = @{ Source = $code }          # hashtable splat = named parameters (an array would bind positionally)
    if ($EnvFile) { $runArgs.EnvFile = $EnvFile }
    $exit = 1
    try { & $runner @runArgs; $exit = $LASTEXITCODE } catch { $exit = 1 }
    $last[$code] = $now
    if ($exit -eq 0) {
      foreach ($path in $claimed) { Move-Item -LiteralPath $path -Destination (Join-Path $processed ("{0}.exit0.json" -f [IO.Path]::GetFileNameWithoutExtension($path))) -Force }
      $attempts.Remove($code)
      Write-Output "RAN $code exit=0 requests=$($group.Count)"
    } else {
      $count = 1 + $(if ($attempts.ContainsKey($code)) { $attempts[$code] } else { 0 })
      $attempts[$code] = $count
      foreach ($path in $claimed) {
        $name = [IO.Path]::GetFileName($path)
        if ($count -ge $MaxAttempts) {
          Move-Item -LiteralPath $path -Destination (Join-Path $rejected ("{0}.EXHAUSTED.json" -f [IO.Path]::GetFileNameWithoutExtension($path))) -Force
        } else {
          Move-Item -LiteralPath $path -Destination (Join-Path $dir $name) -Force   # put back: retried by the next invocation
        }
      }
      if ($count -ge $MaxAttempts) { $attempts.Remove($code) }
      Write-Output "FAILED $code exit=$exit attempt=$count requests=$($group.Count)"
    }
    & $save
  }
  & $save
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
exit 0

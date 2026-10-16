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
# Delivery semantics (independent review rounds 4-5):
#   - a request is CLAIMED (moved to inflight/) BEFORE the run; if this script dies mid-run the claimed file is never re-run
#     automatically - the next invocation moves it to processed/ as ".unknown" (operator re-requests if needed). No duplicate runs.
#   - the run result decides the outcome. The engine exits 0 only when it really read and planned; with SOURCE_CYCLE_REQUEST_RUN=1 it
#     exits 3 for LOCKED / UNCHANGED_SYNC ("not executed") and 1 for HOLD/STOPPED. Only exit 0 consumes the request (-> processed/).
#   - any other result puts the request back under a UNIQUE name that carries the attempt count ("<id>.r<N>-<stamp>.json"); the rename
#     itself is the attempt record (no separate state to lose in a crash), a returned file never overwrites a newer request, and after
#     MaxAttempts the request goes to rejected/ as EXHAUSTED. Attempts are per request, not per source.
#   - last-run.json is replaced atomically with [IO.File]::Replace; old-schema ({"RP031":"<utc>"}) is read as-is; an unknown or damaged
#     file is moved aside and every allowed source is delayed for one interval (never "no history = no floor").
#   - allowed-sources.txt lines: "RP012" or "RP031:15" (per-source minimum minutes). RP031 (Iancar, 429 history) is floored at 15.
#   - requests older than 2 hours or dated in the future are rejected; at most 6 sources per invocation; a mutex prevents overlap.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $RequestDir) { throw 'RequestDir is required (a private directory outside the repository).' }
$dir = (Resolve-Path -LiteralPath $RequestDir).Path
if ($dir.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'RequestDir must live outside the repository.' }
$processed = Join-Path $dir 'processed'; $rejected = Join-Path $dir 'rejected'; $inflight = Join-Path $dir 'inflight'
New-Item -ItemType Directory -Force -Path $processed, $rejected, $inflight | Out-Null

function Move-Unique([string]$from, [string]$toDir, [string]$name) {
  # never overwrite: add a numeric suffix when the target name exists
  $target = Join-Path $toDir $name; $n = 0
  while (Test-Path -LiteralPath $target) { $n++; $target = Join-Path $toDir ([IO.Path]::GetFileNameWithoutExtension($name) + ".d$n" + [IO.Path]::GetExtension($name)) }
  Move-Item -LiteralPath $from -Destination $target
}

$mutex = New-Object System.Threading.Mutex($false, 'Global\FreePassSourceRequests')
if (-not $mutex.WaitOne(0)) { Write-Output 'SOURCE_REQUESTS_ALREADY_RUNNING'; exit 0 }
try {
  # A claimed file left over from a crashed run: it may or may not have executed - never re-run it automatically.
  foreach ($stale in @(Get-ChildItem -LiteralPath $inflight -File -ErrorAction SilentlyContinue)) {
    Move-Unique $stale.FullName $processed ($stale.BaseName + '.unknown.json')
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
  $now = [datetime]::UtcNow
  $stateFile = Join-Path $dir 'last-run.json'
  $last = @{}
  if (Test-Path -LiteralPath $stateFile) {
    $ok = $false
    try {
      $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
      $props = @($state.PSObject.Properties)
      $names = @($props | ForEach-Object { $_.Name })
      # Strict, case-SENSITIVE schema check (PowerShell -eq / -contains / -notin are case-insensitive and coerce types):
      # keys must be exactly {version?, last}; version must be a JSON integer (int/long) equal to 1 - not true, not "1".
      $versionPresent = $names -ccontains 'version'
      $versionOk = (-not $versionPresent) -or (($state.version -is [int] -or $state.version -is [long]) -and ($state.version -ceq 1))
      $knownKeys = @($names | Where-Object { $_ -ceq 'version' -or $_ -ceq 'last' })
      if (($names -ccontains 'last') -and $knownKeys.Count -eq $names.Count -and $versionOk -and $state.last -is [pscustomobject]) {
        $state.last.PSObject.Properties | ForEach-Object { $last[$_.Name] = [datetime]$_.Value }; $ok = $true
      } elseif ($props.Count -gt 0 -and -not ($props | Where-Object { $_.Name -cnotmatch '^RP\d{3}$' -or -not ($_.Value -is [datetime] -or "$($_.Value)" -match '^\d{4}-\d{2}-\d{2}T') })) { # legacy {"RP031":"<utc>"}
        $props | ForEach-Object { $last[$_.Name] = [datetime]$_.Value }; $ok = $true
      } elseif ($props.Count -eq 0) { $ok = $true }                                                                # empty object = no history yet
    } catch { $ok = $false }
    if (-not $ok) {
      Move-Unique $stateFile $dir ('last-run.damaged.' + [guid]::NewGuid().ToString('N') + '.json')
      foreach ($k in $allowed.Keys) { $last[$k] = $now }          # safe side: delay every allowed source one interval
      Write-Output 'STATE_UNKNOWN_OR_DAMAGED_MOVED_ASIDE'
    }
  }
  $save = {
    $o = @{ version = 1; last = @{} }
    foreach ($k in $last.Keys) { $o.last[$k] = $last[$k].ToString('o') }
    $tmp = $stateFile + '.' + $PID + '.tmp'
    ($o | ConvertTo-Json -Depth 4 -Compress) | Set-Content -LiteralPath $tmp -Encoding UTF8
    if (Test-Path -LiteralPath $stateFile) { [IO.File]::Replace($tmp, $stateFile, [NullString]::Value) } else { [IO.File]::Move($tmp, $stateFile) }
  }
  $runner = Join-Path $PSScriptRoot 'run-source-cycle.ps1'
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
      Move-Unique $file.FullName $rejected ("{0}.{1}.json" -f $file.BaseName, $reason)
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
      Move-Unique $file.FullName $inflight $file.Name
      $claimed += (Join-Path $inflight $file.Name)
    }
    $runArgs = @{ Source = $code }          # hashtable splat = named parameters (an array would bind positionally)
    if ($EnvFile) { $runArgs.EnvFile = $EnvFile }
    $exit = 1
    $env:SOURCE_CYCLE_REQUEST_RUN = '1'
    $last[$code] = [datetime]::UtcNow       # interval base = the moment this runner is actually started (not the invocation start)
    try { & $runner @runArgs; $exit = $LASTEXITCODE } catch { $exit = 1 } finally { Remove-Item Env:\SOURCE_CYCLE_REQUEST_RUN -ErrorAction SilentlyContinue }
    & $save                                  # interval record first: a crash below can only delay, never re-run sooner
    foreach ($path in $claimed) {
      if (-not (Test-Path -LiteralPath $path)) { continue }
      $base = [IO.Path]::GetFileNameWithoutExtension($path)
      if ($exit -eq 0) { Move-Unique $path $processed ($base + '.exit0.json'); continue }
      # not executed / failed: put back under a unique name that carries the attempt count
      # the attempt count survives Move-Unique collision suffixes (".d<N>" after the stamp)
      $m = [regex]::Match($base, '^(?<id>.*)\.r(?<n>\d+)-\d{14,17}(\.d\d+)*$')
      $attempt = 1 + $(if ($m.Success) { [int]$m.Groups['n'].Value } else { 0 })
      $id = if ($m.Success) { $m.Groups['id'].Value } else { $base }
      if ($attempt -ge $MaxAttempts) { Move-Unique $path $rejected ("{0}.EXHAUSTED.json" -f $id); continue }
      $stamp = [datetime]::UtcNow.ToString('yyyyMMddHHmmssfff')
      Move-Unique $path $dir ("{0}.r{1}-{2}.json" -f $id, $attempt, $stamp)
    }
    Write-Output "RUN $code exit=$exit requests=$($group.Count)"
  }
  & $save
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
exit 0

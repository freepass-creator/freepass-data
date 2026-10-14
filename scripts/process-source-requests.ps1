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
# Delivery semantics (independent review rounds 4-6):
#   - file names are NEVER trusted: any file whose name is not short and plain is renamed to an internal id before it is processed
#     (Windows component limit 255); if even that fails the file is rejected. Attempt suffixes are parsed with TryParse and a range check.
#   - a request is CLAIMED (moved to inflight/) BEFORE the run; if this script dies mid-run the claimed file is never re-run
#     automatically - the next invocation moves it to processed/ as ".unknown" (operator re-requests if needed). No duplicate runs.
#   - the interval for a source is RESERVED durably BEFORE its runner starts (state saved first), and a quarantined/damaged state file is
#     replaced at once by a fresh state that delays every allowed source one interval - so an interruption can only delay, never speed up.
#   - the run result decides the outcome. The engine exits 0 only when it really read and planned; with SOURCE_CYCLE_REQUEST_RUN=1 it
#     exits 3 for LOCKED / UNCHANGED_SYNC ("not executed") and 1 for HOLD/STOPPED. Only exit 0 consumes the request (-> processed/).
#   - any other result puts the request back under a UNIQUE name that carries the attempt count ("<id>.r<N>-<stamp>.json"); after
#     MaxAttempts the request goes to rejected/ as EXHAUSTED. Attempts are per request, not per source.
#   - last-run.json: {"version":1,"last":{"RPxxx":"<utc ISO>"}}; keys must be exactly allowed source codes (case-sensitive), values ISO
#     strings within [now-7d, now+5min]; the old flat map {"RP031":"<utc>"} is read with the same checks; anything else is quarantined.
#   - allowed-sources.txt lines: "RP012" or "RP031:15" (per-source minimum minutes). RP031 (Iancar, 429 history) is floored at 15.
#   - requests older than 2 hours or dated in the future are rejected; at most 6 sources per invocation; a mutex prevents overlap.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $RequestDir) { throw 'RequestDir is required (a private directory outside the repository).' }
$dir = (Resolve-Path -LiteralPath $RequestDir).Path
if ($dir.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'RequestDir must live outside the repository.' }
$processed = Join-Path $dir 'processed'; $rejected = Join-Path $dir 'rejected'; $inflight = Join-Path $dir 'inflight'
New-Item -ItemType Directory -Force -Path $processed, $rejected, $inflight | Out-Null

$ID_MAX = 48    # internal ids are at most 48 chars so every derived name stays far below the 255-char component limit
function New-InternalId { 'req-' + [datetime]::UtcNow.ToString('yyyyMMddHHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) }
function Move-Unique([string]$from, [string]$toDir, [string]$name) {
  # never overwrite: add a numeric suffix when the target name exists; names longer than 120 chars are replaced by an internal id
  if ($name.Length -gt 120) { $name = (New-InternalId) + [IO.Path]::GetExtension($name) }
  $target = Join-Path $toDir $name; $n = 0
  while (Test-Path -LiteralPath $target) { $n++; $target = Join-Path $toDir ([IO.Path]::GetFileNameWithoutExtension($name) + ".d$n" + [IO.Path]::GetExtension($name)) }
  Move-Item -LiteralPath $from -Destination $target
  return $target
}
function Short-Id([string]$base) { if ($base.Length -gt $ID_MAX) { return $base.Substring(0, $ID_MAX) } return $base }

$mutex = New-Object System.Threading.Mutex($false, 'Global\FreePassSourceRequests')
if (-not $mutex.WaitOne(0)) { Write-Output 'SOURCE_REQUESTS_ALREADY_RUNNING'; exit 0 }
try {
  # A claimed file left over from a crashed run: it may or may not have executed - never re-run it automatically.
  foreach ($stale in @(Get-ChildItem -LiteralPath $inflight -File -ErrorAction SilentlyContinue)) {
    try { [void](Move-Unique $stale.FullName $processed ((Short-Id $stale.BaseName) + '.unknown.json')); Write-Output "UNKNOWN_OUTCOME $($stale.Name.Substring(0, [Math]::Min(60, $stale.Name.Length)))" }
    catch { try { [void](Move-Unique $stale.FullName $rejected ((New-InternalId) + '.unknown-move-failed.json')) } catch { Write-Output 'INFLIGHT_RECOVERY_FAILED' } }
  }
  $allowedFile = Join-Path $dir 'allowed-sources.txt'
  $allowed = @{}
  if (Test-Path -LiteralPath $allowedFile) {
    foreach ($line in (Get-Content -LiteralPath $allowedFile)) {
      $t = $line.Trim()
      if ($t -cmatch '^(RP\d{3})(:(\d{1,3}))?$') { $allowed[$Matches[1]] = if ($Matches[3]) { [int]$Matches[3] } else { $MinIntervalMinutes } }
    }
  }
  if ($allowed.ContainsKey('RP031') -and $allowed['RP031'] -lt 15) { $allowed['RP031'] = 15 }   # enforced floor for Iancar
  $now = [datetime]::UtcNow
  $stateFile = Join-Path $dir 'last-run.json'
  $last = @{}
  $save = {
    $o = @{ version = 1; last = @{} }
    foreach ($k in $last.Keys) { $o.last[$k] = $last[$k].ToString('o') }
    $tmp = $stateFile + '.' + $PID + '.tmp'
    ($o | ConvertTo-Json -Depth 4 -Compress) | Set-Content -LiteralPath $tmp -Encoding UTF8
    if (Test-Path -LiteralPath $stateFile) { [IO.File]::Replace($tmp, $stateFile, [NullString]::Value) } else { [IO.File]::Move($tmp, $stateFile) }
  }
  # Validate one {code: value} map: exact allowed codes (case-sensitive), ISO strings, plausible time window.
  $readMap = {
    param($map)
    $result = @{}
    foreach ($p in @($map.PSObject.Properties)) {
      if ($p.Name -cnotmatch '^RP\d{3}$' -or -not $allowed.ContainsKey($p.Name)) { return $null }
      $v = $p.Value
      $dt = $null
      if ($v -is [datetime]) { $dt = $v.ToUniversalTime() }
      elseif ($v -is [string] -and $v -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$') {
        try { $dt = ([datetime]::Parse($v, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)).ToUniversalTime() } catch { return $null }
      } else { return $null }
      if ($dt -lt $now.AddDays(-7) -or $dt -gt $now.AddMinutes(5)) { return $null }
      $result[$p.Name] = $dt
    }
    return $result
  }
  if (Test-Path -LiteralPath $stateFile) {
    $parsed = $null
    try {
      $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
      $names = @($state.PSObject.Properties | ForEach-Object { $_.Name })
      $versionPresent = $names -ccontains 'version'
      $versionOk = (-not $versionPresent) -or (($state.version -is [int] -or $state.version -is [long]) -and ($state.version -ceq 1))
      $knownKeys = @($names | Where-Object { $_ -ceq 'version' -or $_ -ceq 'last' })
      if (($names -ccontains 'last') -and $knownKeys.Count -eq $names.Count -and $versionOk -and $state.last -is [pscustomobject]) {
        $parsed = & $readMap $state.last
      } elseif ($names.Count -eq 0) { $parsed = @{} }
      elseif (-not ($names | Where-Object { $_ -cnotmatch '^RP\d{3}$' })) { $parsed = & $readMap $state }      # legacy flat map
    } catch { $parsed = $null }
    if ($null -ne $parsed) { $last = $parsed }
    else {
      try { [void](Move-Unique $stateFile $dir ('last-run.damaged.' + [guid]::NewGuid().ToString('N') + '.json')) } catch { Remove-Item -LiteralPath $stateFile -Force }
      foreach ($k in $allowed.Keys) { $last[$k] = $now }          # safe side: delay every allowed source one interval
      & $save                                                     # durable marker NOW: an interruption cannot erase the delay
      Write-Output 'STATE_UNKNOWN_OR_DAMAGED_MOVED_ASIDE'
    }
  }
  $runner = Join-Path $PSScriptRoot 'run-source-cycle.ps1'
  # Intake: names are untrusted - normalize anything long or unusual to an internal id before reading it.
  $files = @()
  foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | Where-Object { $_.Name -notlike 'last-run*' } | Sort-Object LastWriteTimeUtc)) {
    if ($f.Name.Length -le 100 -and $f.Name -cmatch '^[A-Za-z0-9._-]+$') { $files += $f; continue }
    try {
      $newPath = Move-Unique $f.FullName $dir ((New-InternalId) + '.json')
      $files += (Get-Item -LiteralPath $newPath)
    } catch { Write-Output 'INTAKE_RENAME_FAILED' }
  }
  $bySource = @{}
  foreach ($file in $files) {
    $reason = $null; $req = $null; $code = $null
    try { $req = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json } catch { $reason = 'JSON_INVALID' }
    if (-not $reason) {
      $code = [string]$req.source
      $at = $null
      try { $at = ([datetime]$req.requestedAt).ToUniversalTime() } catch { $reason = 'REQUESTED_AT_INVALID' }
      if (-not $reason -and $code -cnotmatch '^RP\d{3}$') { $reason = 'SOURCE_CODE_INVALID' }
      elseif (-not $reason -and -not $allowed.ContainsKey($code)) { $reason = 'SOURCE_NOT_ALLOWED' }
      elseif (-not $reason -and ($now - $at).TotalMinutes -gt 120) { $reason = 'REQUEST_STALE' }
      elseif (-not $reason -and ($at - $now).TotalMinutes -gt 5) { $reason = 'REQUESTED_AT_FUTURE' }
    }
    if ($reason) {
      try { [void](Move-Unique $file.FullName $rejected ((Short-Id $file.BaseName) + ".$reason.json")) } catch { Write-Output 'REJECT_MOVE_FAILED' }
      Write-Output "REJECTED $reason"
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
      try { $claimed += (Move-Unique $file.FullName $inflight $file.Name) } catch { Write-Output 'CLAIM_FAILED' }
    }
    if ($claimed.Count -eq 0) { continue }
    # Reserve the interval durably BEFORE the runner starts (start time recorded first).
    $last[$code] = [datetime]::UtcNow
    & $save
    $runArgs = @{ Source = $code }          # hashtable splat = named parameters (an array would bind positionally)
    if ($EnvFile) { $runArgs.EnvFile = $EnvFile }
    $exit = 1
    $env:SOURCE_CYCLE_REQUEST_RUN = '1'
    try { & $runner @runArgs; $exit = $LASTEXITCODE } catch { $exit = 1 } finally { Remove-Item Env:\SOURCE_CYCLE_REQUEST_RUN -ErrorAction SilentlyContinue }
    foreach ($path in $claimed) {
      if (-not (Test-Path -LiteralPath $path)) { continue }
      $base = [IO.Path]::GetFileNameWithoutExtension($path)
      try {
        if ($exit -eq 0) { [void](Move-Unique $path $processed ((Short-Id $base) + '.exit0.json')); continue }
        # not executed / failed: put back under a unique name that carries the attempt count (range-checked, never throws)
        $attempt = 1; $id = Short-Id $base
        $m = [regex]::Match($base, '^(?<id>.{1,48}?)\.r(?<n>\d{1,3})-\d{14,17}(\.d\d{1,3})*$')
        if ($m.Success) {
          $n = 0
          if ([int]::TryParse($m.Groups['n'].Value, [ref]$n) -and $n -ge 1 -and $n -le 99) { $attempt = $n + 1; $id = $m.Groups['id'].Value }
          else { $attempt = $MaxAttempts }      # unparseable counter: treat as exhausted, never loop
        }
        if ($attempt -ge $MaxAttempts) { [void](Move-Unique $path $rejected ("{0}.EXHAUSTED.json" -f $id)); continue }
        $stamp = [datetime]::UtcNow.ToString('yyyyMMddHHmmssfff')
        [void](Move-Unique $path $dir ("{0}.r{1}-{2}.json" -f $id, $attempt, $stamp))
      } catch {
        # never leave the file in inflight (it would block recovery): fall back to rejected with a short internal name
        try { [void](Move-Unique $path $rejected ((New-InternalId) + '.REQUEUE_FAILED.json')) } catch { Write-Output 'REQUEUE_FAILED' }
      }
    }
    Write-Output "RUN $code exit=$exit requests=$($group.Count)"
  }
  & $save
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
exit 0

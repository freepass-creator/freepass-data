param(
  [string]$RequestDir,
  [string]$EnvFile,
  [string]$TaskName = 'FreePass-Source-Requests',
  [int]$IntervalMinutes = 5,
  [switch]$Register
)
# Registers the 5-minute task that runs scripts/process-source-requests.ps1 (immediate source-cycle requests).
# Dry run by default (prints the schtasks command). No /F: an existing task is never silently overwritten.
# Rollback: schtasks /Delete /TN FreePass-Source-Requests  (requests simply stay in the directory; nothing else depends on it).
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $RequestDir) { throw 'RequestDir is required.' }
if ($IntervalMinutes -lt 1 -or $IntervalMinutes -gt 60) { throw 'IntervalMinutes must be 1..60.' }
if ($TaskName.Contains('"')) { throw 'Invalid argument quote.' }
$dir = (Resolve-Path -LiteralPath $RequestDir).Path
if ($dir.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'RequestDir must live outside the repository.' }
if ($dir.Contains('"')) { throw 'Invalid argument quote.' }
$runner = Join-Path $PSScriptRoot 'process-source-requests.ps1'
$pwsh = (Get-Command powershell.exe -ErrorAction Stop).Source
$command = '"' + $pwsh + '" -NoProfile -ExecutionPolicy Bypass -File "' + $runner + '" -RequestDir "' + $dir + '"'
if ($EnvFile) {
  $envPath = (Resolve-Path -LiteralPath $EnvFile).Path
  if ($envPath.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'EnvFile must live outside the repository.' }
  if ($envPath.Contains('"')) { throw 'Invalid argument quote.' }
  $command += ' -EnvFile "' + $envPath + '"'
}
$taskArgs = @('/Create', '/TN', $TaskName, '/SC', 'MINUTE', '/MO', "$IntervalMinutes", '/TR', $command)
if (-not $Register) { Write-Output ('DRY_RUN schtasks.exe ' + ($taskArgs -join ' ')); exit 0 }
& schtasks.exe @taskArgs
if ($LASTEXITCODE -ne 0) { throw 'Task registration failed.' }

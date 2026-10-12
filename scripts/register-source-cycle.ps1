param(
  [Parameter(Mandatory=$true)][string]$Runtime,
  [string]$TaskName = 'FreePass-Source-Cycle',
  [switch]$OnlyWhenSynced,
  [switch]$Register
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$runtimePath = (Resolve-Path -LiteralPath $Runtime).Path
$job = Join-Path $repo 'dist\src\jobs\source-cycle.js'
if (!(Test-Path -LiteralPath $job)) { throw 'Run npm.cmd run build first.' }
if ($runtimePath.Contains('"') -or $TaskName.Contains('"')) { throw 'Invalid argument quote.' }
$taskCommand = '"' + $node + '" "' + $job + '" --runtime "' + $runtimePath + '"'
if ($OnlyWhenSynced) { $taskCommand += ' --only-when-synced' }
$taskArgs = @('/Create', '/TN', $TaskName, '/SC', 'MINUTE', '/MO', '15', '/TR', $taskCommand)
# No /F: never silently overwrite an existing user task. No stored credentials or elevated account.
if (!$Register) { Write-Output ('DRY_RUN schtasks.exe ' + ($taskArgs -join ' ')); exit 0 }
& schtasks.exe @taskArgs
if ($LASTEXITCODE -ne 0) { throw 'Task registration failed.' }

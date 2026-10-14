param([string]$TaskName = 'FreePass-Source-Cycle', [switch]$Remove)
$ErrorActionPreference = 'Stop'
if (!$Remove) { Write-Output ('DRY_RUN schtasks.exe /Delete /TN "' + $TaskName + '" /F'); exit 0 }
& schtasks.exe /Delete /TN $TaskName /F
if ($LASTEXITCODE -ne 0) { throw 'Task removal failed.' }

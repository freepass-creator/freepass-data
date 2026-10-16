# 이 PC 작업 스케줄러에 «수집 15분 감시» 등록(사용자 로그온 상태, 15분마다). 읽기 전용 감시 스크립트만 실행한다.
param([string]$Repo = (Split-Path -Parent $PSScriptRoot))
$node = (Get-Command node).Source
$script = Join-Path $Repo 'scripts\collection-health-watch.mjs'
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
Register-ScheduledTask -TaskName 'FreepassData-CollectionHealthWatch' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Get-ScheduledTask -TaskName 'FreepassData-CollectionHealthWatch' | Select-Object TaskName, State

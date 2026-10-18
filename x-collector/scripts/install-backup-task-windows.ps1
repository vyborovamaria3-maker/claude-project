# Optional local Windows Task Scheduler registration. Does not run on a server.
param(
  [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')]
  [string]$At = "03:00"
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Windows Task Scheduler required" }
$node=(Get-Command node.exe -ErrorAction Stop).Source
$root=(Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backup=Join-Path $PSScriptRoot "backup-windows.cjs"
$action=New-ScheduledTaskAction -Execute $node -Argument ('"' + $backup + '"') -WorkingDirectory $root
$time=[datetime]::ParseExact($At,"HH:mm",[Globalization.CultureInfo]::InvariantCulture)
$trigger=New-ScheduledTaskTrigger -Daily -At $time
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "XCollectorPostgresBackup" -Action $action -Trigger $trigger -Settings $settings -Force -Description "Local X Collector PostgreSQL custom-format backup" | Out-Null
Write-Output "Scheduled XCollectorPostgresBackup daily at $At (local Windows time)."
Write-Output "Use Get-ScheduledTaskInfo -TaskName XCollectorPostgresBackup and restore into a test DB to verify backups."

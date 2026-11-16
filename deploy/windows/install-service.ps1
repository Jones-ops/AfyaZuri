<#
.SYNOPSIS
  Registers Afyazuri to start automatically when this Windows server boots (no Docker).

.DESCRIPTION
  Creates a Task Scheduler task that runs `node scripts\start.js` at system startup
  under a dedicated, non-administrator Windows account, and restarts it if it stops.
  PostgreSQL will not run under an administrator account, so do not use one here.

.EXAMPLE
  # From an elevated PowerShell, in the Afyazuri folder:
  .\deploy\windows\install-service.ps1 -User afyazuri

.EXAMPLE
  .\deploy\windows\install-service.ps1 -Uninstall
#>
param(
  [string]$User = 'afyazuri',
  [string]$InstallDir = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [switch]$Uninstall
)

$TaskName = 'Afyazuri'
$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
  return
}

$node = (Get-Command node).Source
if (-not (Test-Path "$InstallDir\apps\web\dist\index.html")) {
  throw "The web app is not built. Run 'npm run build' in $InstallDir first."
}
if (-not (Test-Path "$InstallDir\.env")) {
  throw "No .env found. Run 'npm run secrets' in $InstallDir first."
}

$cred = Get-Credential -UserName $User -Message "Password for the '$User' account that will run Afyazuri"

$action = New-ScheduledTaskAction -Execute $node -Argument 'scripts\start.js' -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null

# Let LAN clients reach the app (default port 4000; change if PORT differs in .env).
New-NetFirewallRule -DisplayName 'Afyazuri (HTTP/HTTPS)' -Direction Inbound -Protocol TCP -LocalPort 4000 `
  -Action Allow -Profile Domain,Private -ErrorAction SilentlyContinue | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Afyazuri registered and started. Check http://localhost:4000/ready"

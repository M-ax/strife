param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Run on a disposable CI runner.' }
if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Installer tests must be non-elevated.'
}
Write-Host 'Running installation and OTA checks without administrator membership.'
# Alternate-credential processes can inherit the runner's environment strings.
# Resolve profile paths using the actual user token instead.
$env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
$env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
$env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
$env:TMP = $env:TEMP
$env:DOTNET_CLI_HOME = $env:USERPROFILE
$env:NUGET_PACKAGES = Join-Path $env:USERPROFILE '.nuget/packages'
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
Set-Location ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')))
dotnet tool restore
if ($LASTEXITCODE) { throw 'Cannot restore update test tool.' }
& ./tests/windows/installer.ps1 -Installer $Installer
& ./tests/windows/updates.ps1

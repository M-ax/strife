# Run on a disposable Windows CI machine with prerequisites installed.
# Run as a standard user to exercise the non-elevated install path.
param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Run this installation test on a disposable CI runner (CI=true).' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage = Join-Path $root 'artifacts/installer-test'
$application = Join-Path $env:LOCALAPPDATA 'Programs/Strife'
$uninstallKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{3AF3EC03-735A-4F65-9A4D-1C611D72D812}_is1'
$registry = "HKCU:\$uninstallKey"
$machineRegistry = "HKLM:\$uninstallKey"
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Strife.lnk'
$machineShortcut = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Strife.lnk'
foreach ($path in @($registry, $machineRegistry, $application, $shortcut, $machineShortcut)) {
    if (Test-Path $path) { throw "Existing Strife installation data must not be modified by this test: $path" }
}
New-Item -ItemType Directory -Force $stage | Out-Null
$profile = Join-Path $env:LOCALAPPDATA 'Strife'
New-Item -ItemType Directory -Force $profile | Out-Null
$sentinel = Join-Path $profile ('installer-test-' + [Guid]::NewGuid().ToString('N') + '.txt')
'preserve this profile' | Set-Content $sentinel
$previousEngine = $env:STRIFE_VOICE_ENGINE
function Invoke-Setup([string]$Path, [string[]]$Arguments) {
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -notin @(0, 3010)) { throw "Setup failed with exit code $($process.ExitCode)." }
}
try {
    foreach ($pass in @('install', 'upgrade')) {
        Invoke-Setup $Installer @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/RESTARTEXITCODE=3010', "/LOG=`"$(Join-Path $stage "$pass.log")`"")
        foreach ($file in @('Strife.exe', 'voice/strife-voice.exe', 'voice/rnnoise.dll', 'voice/speexdsp.dll', 'wwwroot/index.html', 'unins000.exe')) {
            if (!(Test-Path (Join-Path $application $file))) { throw "Installer omitted $file." }
        }
        if (!(Test-Path $registry)) { throw 'Per-user Apps & Features registration is missing.' }
        if (!(Test-Path $shortcut)) { throw 'Per-user Start Menu shortcut is missing.' }
        if ((Test-Path $machineRegistry) -or (Test-Path $machineShortcut)) {
            throw 'Setup created machine-wide application registration or shortcuts.'
        }
        if (!(Test-Path $sentinel)) { throw 'Setup removed the user profile.' }
        if ($pass -eq 'install') {
            'old runtime' | Set-Content (Join-Path $application 'obsolete.dll')
            'old payload' | Set-Content (Join-Path $application 'voice/obsolete.txt')
        } elseif ((Test-Path (Join-Path $application 'obsolete.dll')) -or (Test-Path (Join-Path $application 'voice/obsolete.txt'))) {
            throw 'Upgrade left obsolete application files behind.'
        }
    }
    $env:STRIFE_VOICE_ENGINE = Join-Path $application 'voice/strife-voice.exe'
    & dotnet run --project (Join-Path $root 'tests/Strife.Tests') -c Release -- --voice-startup-only
    if ($LASTEXITCODE) { throw 'Installed voice engine failed.' }
} finally {
    $env:STRIFE_VOICE_ENGINE = $previousEngine
    $uninstaller = Join-Path $application 'unins000.exe'
    if (Test-Path $uninstaller) {
        Invoke-Setup $uninstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$(Join-Path $stage 'uninstall.log')`"")
    }
    if (!(Test-Path $sentinel)) { throw 'Uninstall removed the user profile.' }
    Remove-Item -LiteralPath $sentinel
}
if ((Test-Path (Join-Path $application 'Strife.exe')) -or (Test-Path $registry) -or (Test-Path $shortcut)) {
    throw 'Uninstall did not remove the application, registration and shortcut.'
}
Write-Host 'Installer, upgrade, packaged voice and uninstall checks passed; user profiles survived.'

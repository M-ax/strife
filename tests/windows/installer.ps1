# Run on a disposable Windows CI machine with prerequisites installed.
# Run as a standard user to exercise the non-elevated install path.
param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Run this installation test on a disposable CI runner (CI=true).' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage = Join-Path $root 'artifacts/installer-test'
$application = Join-Path $env:LOCALAPPDATA 'Programs/Strife'
$current = Join-Path $application 'current'
$uninstallKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Strife'
$legacyRegistry = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{3AF3EC03-735A-4F65-9A4D-1C611D72D812}_is1'
$registry = "HKCU:\$uninstallKey"
$machineRegistry = "HKLM:\$uninstallKey"
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Strife.lnk'
$machineShortcut = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Strife.lnk'
foreach ($path in @($registry, $legacyRegistry, $machineRegistry, $application, $shortcut, $machineShortcut)) {
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
    # A legacy per-user registration exercises the same explicit-migration guard
    # as the machine-wide registration, without requiring an elevated test.
    New-Item -Path $legacyRegistry -Force | Out-Null
    try {
        $blocked = Start-Process -FilePath $Installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
        if ($blocked.ExitCode -eq 0 -or (Test-Path $current)) { throw 'Legacy installation was not blocked.' }
    } finally { Remove-Item -LiteralPath $legacyRegistry }
    foreach ($pass in @('install', 'upgrade')) {
        Invoke-Setup $Installer @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/RESTARTEXITCODE=3010', "/LOG=`"$(Join-Path $stage "$pass.log")`"")
        foreach ($file in @('Strife.exe', 'voice/strife-voice.exe', 'voice/rnnoise.dll', 'voice/speexdsp.dll', 'wwwroot/index.html')) {
            if (!(Test-Path (Join-Path $current $file))) { throw "Installer omitted $file." }
        }
        . (Join-Path $root 'scripts/windows-dotnet.ps1')
        $frameworks = @(Get-StrifeDotNetFrameworks $current)
        $requirements = Get-Content (Join-Path $root 'artifacts/release/update-requirements.json') -Raw | ConvertFrom-Json
        foreach ($framework in $frameworks) {
            $expected = @($requirements.dotNetFrameworks | Where-Object name -CEQ $framework.name)
            if ($expected.Count -ne 1 -or $expected[0].version -ne $framework.version) {
                throw 'Installed runtime requirements differ from OTA requirements.'
            }
        }
        if (!(Test-Path (Join-Path $application 'Update.exe'))) { throw 'Updater/uninstaller is missing.' }
        if (!(Test-Path $registry)) { throw 'Per-user Apps & Features registration is missing.' }
        if (!(Test-Path $shortcut)) { throw 'Per-user Start Menu shortcut is missing.' }
        if ((Test-Path $machineRegistry) -or (Test-Path $machineShortcut)) {
            throw 'Setup created machine-wide application registration or shortcuts.'
        }
        if (!(Test-Path $sentinel)) { throw 'Setup removed the user profile.' }
        if ($pass -eq 'install') {
            'old runtime' | Set-Content (Join-Path $current 'obsolete.dll')
            'old payload' | Set-Content (Join-Path $current 'voice/obsolete.txt')
        } elseif ((Test-Path (Join-Path $current 'obsolete.dll')) -or (Test-Path (Join-Path $current 'voice/obsolete.txt'))) {
            throw 'Upgrade left obsolete application files behind.'
        }
    }
    # Launch the actual framework-dependent apphost, not `dotnet run`: otherwise
    # an SDK or the test harness could hide broken global runtime discovery.
    $previousProfile = $env:STRIFE_PROFILE
    $env:STRIFE_PROFILE = Join-Path $stage 'desktop-profile'
    $desktop = $null
    try {
        $desktop = Start-Process (Join-Path $current 'Strife.exe') -PassThru
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        $listener = $null
        do {
            if ($desktop.HasExited) { throw "Installed desktop exited early: $($desktop.ExitCode)." }
            $listener = Get-NetTCPConnection -OwningProcess $desktop.Id -State Listen -ErrorAction SilentlyContinue |
                Where-Object LocalAddress -EQ '127.0.0.1' | Select-Object -First 1
            if (!$listener) { Start-Sleep -Milliseconds 250 }
        } while (!$listener -and [DateTime]::UtcNow -lt $deadline)
        if (!$listener) { throw 'Installed desktop did not start its local web host.' }
        $page = Invoke-WebRequest "http://127.0.0.1:$($listener.LocalPort)/"
        if ($page.StatusCode -ne 200 -or $page.Content -notmatch 'Strife') { throw 'Installed desktop assets failed to load.' }
        Write-Host 'PASS: installed framework-dependent desktop launches and serves UI assets.'
    } finally {
        $env:STRIFE_PROFILE = $previousProfile
        if ($desktop) {
            if (!$desktop.HasExited) { $desktop.Kill($true); $desktop.WaitForExit() }
            $desktop.Dispose()
        }
    }
    $env:STRIFE_VOICE_ENGINE = Join-Path $current 'voice/strife-voice.exe'
    & dotnet run --project (Join-Path $root 'tests/Strife.Tests') -c Release -- --voice-startup-only
    if ($LASTEXITCODE) { throw 'Installed voice engine failed.' }
} finally {
    $env:STRIFE_VOICE_ENGINE = $previousEngine
    $uninstaller = Join-Path $application 'Update.exe'
    if (Test-Path $uninstaller) {
        Invoke-Setup $uninstaller @('uninstall', '--silent')
    }
    if (!(Test-Path $sentinel)) { throw 'Uninstall removed the user profile.' }
    Remove-Item -LiteralPath $sentinel
}
if ((Test-Path (Join-Path $application 'Strife.exe')) -or (Test-Path $registry) -or (Test-Path $shortcut)) {
    throw 'Uninstall did not remove the application, registration and shortcut.'
}
Write-Host 'Installer, upgrade, packaged voice and uninstall checks passed; user profiles survived.'

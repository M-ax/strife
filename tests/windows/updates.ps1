# Real Velopack install/download/apply/relaunch, on a disposable runner only.
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Run this test on a disposable Windows CI runner.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage = Join-Path $root 'artifacts/update-test'
$install = Join-Path $stage 'installed'
$registry = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Strife'
if (Test-Path $registry) { throw 'Existing Strife installation must not be modified.' }
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($version in @('0.1.0-preview.1', '0.1.0-preview.2')) {
    $output = Join-Path $stage $version
    dotnet publish (Join-Path $root 'tests/Strife.UpdateFixture') -c Release -r win-x64 --self-contained "-p:Version=$version" -o $output
    if ($LASTEXITCODE) { throw 'Update fixture publish failed.' }
    dotnet vpk pack --packId Strife --packVersion $version --packDir $output --mainExe Strife.UpdateFixture.exe --channel preview --delta None --shortcuts None --outputDir (Join-Path $stage "$version-pack")
    if ($LASTEXITCODE) { throw 'Update fixture packaging failed.' }
}
$setup = (Get-ChildItem (Join-Path $stage '0.1.0-preview.1-pack') -Filter '*Setup.exe').FullName
New-Item -ItemType Directory -Force (Join-Path $stage 'packages') | Out-Null
Copy-Item (Join-Path $stage '0.1.0-preview.2-pack/*-full.nupkg') (Join-Path $stage 'packages') -Force
$env:STRIFE_UPDATE_FIXTURE = $stage
try {
    foreach ($restart in @('false', 'true')) {
        $env:STRIFE_UPDATE_RESTART = $restart
        $cache = Join-Path $stage 'cache'
        if (Test-Path $cache) { Remove-Item $cache -Recurse -Force }
        $launches = Join-Path $stage 'launches.txt'
        if (Test-Path $launches) { Remove-Item $launches }
        $process = Start-Process $setup -ArgumentList "--silent --installto `"$install`"" -Wait -PassThru
        if ($process.ExitCode) { throw 'Fixture install failed.' }
        $process = Start-Process (Join-Path $install 'current/Strife.UpdateFixture.exe') -Wait -PassThru
        if ($process.ExitCode) { throw "Updater fixture failed: $($process.ExitCode)" }
        $deadline = [DateTime]::UtcNow.AddMinutes(2)
        do {
            Start-Sleep -Milliseconds 500
            $installed = (Get-ItemProperty $registry -ErrorAction SilentlyContinue).DisplayVersion
        } while ($installed -ne '0.1.0-preview.2' -and [DateTime]::UtcNow -lt $deadline)
        if ($installed -ne '0.1.0-preview.2') { throw 'Update did not install after exit.' }
        if ($restart -eq 'true') {
            do {
                Start-Sleep -Milliseconds 200
                $starts = @(Get-Content $launches)
            } while ($starts -notcontains '0.1.0-preview.2' -and [DateTime]::UtcNow -lt $deadline)
            if ($starts -notcontains '0.1.0-preview.2') { throw 'Update did not restart.' }
        } else {
            Start-Sleep -Seconds 3
            if (@(Get-Content $launches).Count -ne 1) { throw 'Ordinary exit unexpectedly relaunched the app.' }
        }
        $remove = Start-Process (Join-Path $install 'Update.exe') -ArgumentList 'uninstall', '--silent' -Wait -PassThru
        if ($remove.ExitCode) { throw 'Fixture uninstall failed.' }
        Write-Host "PASS: real signed updater download, install-on-exit, restart=$restart"
    }
} finally {
    $env:STRIFE_UPDATE_FIXTURE = $null
    $env:STRIFE_UPDATE_RESTART = $null
    if (Test-Path (Join-Path $install 'Update.exe')) {
        Start-Process (Join-Path $install 'Update.exe') -ArgumentList 'uninstall', '--silent' -Wait
    }
}

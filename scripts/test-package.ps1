param([Parameter(Mandatory)][ValidateSet('win-x64', 'linux-x64', 'osx-x64', 'osx-arm64')][string]$Runtime)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-common.ps1')
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $root 'artifacts/Strife/release.json') -Raw | ConvertFrom-Json).version
$stage = Join-Path $root 'artifacts/package-test'
Reset-StrifeStagingDirectory $stage
$previousEngine = $env:STRIFE_VOICE_ENGINE
try {
    if ($IsWindows) {
        Expand-Archive (Join-Path $root "artifacts/release/Strife-$version-$Runtime.zip") $stage
        $env:STRIFE_VOICE_ENGINE = Join-Path $stage 'voice/strife-voice.exe'
    } elseif ($IsMacOS) {
        & ditto -x -k (Join-Path $root "artifacts/release/Strife-$version-$Runtime.zip") $stage
        if ($LASTEXITCODE) { throw 'App archive extraction failed.' }
        $app = Join-Path $stage 'Strife.app'
        & codesign --verify --deep --strict $app
        if ($LASTEXITCODE) { throw 'Extracted app signature is invalid.' }
        $env:STRIFE_VOICE_ENGINE = Join-Path $app 'Contents/MacOS/voice/StrifeVoice.app/Contents/MacOS/Mumble'
        foreach ($binary in @($env:STRIFE_VOICE_ENGINE, (Join-Path $app 'Contents/MacOS/PhotinoX.Native.dylib'))) {
            # Universal dylibs have a filename header for each architecture.
            # Only indented lines describe dependencies; headers contain the
            # staging path and must not be mistaken for a linked build path.
            $dependencies = @(& otool -L $binary) | Where-Object { $_ -match '^\s+' }
            if ($LASTEXITCODE) { throw 'Cannot inspect macOS dependencies.' }
            if ($dependencies -match '/opt/homebrew/|/usr/local/|/Users/runner/|/artifacts/') { throw "Nonportable macOS dependency: $dependencies" }
        }
    } else {
        & tar -xzf (Join-Path $root "artifacts/release/Strife-$version-$Runtime.tar.gz") -C $stage
        if ($LASTEXITCODE) { throw 'Linux archive extraction failed.' }
        $env:STRIFE_VOICE_ENGINE = Join-Path $stage 'Strife/voice/strife-voice'
        foreach ($binary in @($env:STRIFE_VOICE_ENGINE, (Join-Path $stage 'Strife/PhotinoX.Native.so'))) {
            $dependencies = @(& ldd $binary)
            if ($LASTEXITCODE) { throw "Cannot inspect Linux dependencies for $binary." }
            $missing = $dependencies | Where-Object { $_ -match 'not found' }
            if ($missing) { throw "Missing Linux dependencies for ${binary}: $($missing -join ', ')" }
        }
    }
    $arguments = @('run', '--project', (Join-Path $root 'tests/Strife.Tests'), '-c', 'Release', '--', '--voice-startup-only')
    if ($IsLinux) { & xvfb-run -a dotnet @arguments } else { & dotnet @arguments }
    if ($LASTEXITCODE) { throw 'Packaged voice startup failed.' }
    if ($IsMacOS) {
        # Exercise .NET's app-local lookup through the bundle's resource links,
        # and load the real desktop shell after extracting the shipped ZIP.
        $profile = Join-Path $stage 'desktop-profile'
        $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $app 'Contents/MacOS/Strife'))
        $start.UseShellExecute = $false
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.Environment['STRIFE_PROFILE'] = $profile
        $desktop = [Diagnostics.Process]::Start($start)
        $stdout = $desktop.StandardOutput.ReadToEndAsync()
        $stderr = $desktop.StandardError.ReadToEndAsync()
        try {
            if ($desktop.WaitForExit(8000)) {
                throw "Packaged desktop exited early: $($stderr.GetAwaiter().GetResult())"
            }
            $listeners = @(& lsof -nP -a -p $desktop.Id -iTCP -sTCP:LISTEN)
            if ($LASTEXITCODE) { throw 'Packaged desktop did not open its local UI server.' }
            $port = [regex]::Match(($listeners -join "`n"), '127\.0\.0\.1:(\d+)').Groups[1].Value
            if (!$port) { throw 'Cannot locate the packaged desktop UI server.' }
            $page = Invoke-WebRequest "http://127.0.0.1:$port/"
            if ($page.StatusCode -ne 200 -or $page.Content -notmatch 'Strife') { throw 'Packaged desktop assets failed to load.' }
            Write-Host 'PASS: extracted macOS desktop launches and serves its UI assets'
        } finally {
            if (!$desktop.HasExited) { $desktop.Kill($true); $desktop.WaitForExit() }
            $desktop.Dispose()
        }
    }
} finally { $env:STRIFE_VOICE_ENGINE = $previousEngine }

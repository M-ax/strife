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
            $dependencies = @(& otool -L $binary) | Select-Object -Skip 1
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
} finally { $env:STRIFE_VOICE_ENGINE = $previousEngine }

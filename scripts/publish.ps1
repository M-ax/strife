#requires -Version 7.0
param(
    [switch]$BuildVoice,
    [ValidateSet('win-x64', 'linux-x64', 'osx-x64', 'osx-arm64')][string]$Runtime,
    [string]$Version,
    [string]$OutputDirectory,
    [string]$VoiceDirectory,
    [switch]$IncludeDevelopmentStreaming,
    [string]$StreamingDirectory,
    [switch]$NoPackage,
    [string]$InnoSetupCompiler,
    [string]$PrerequisiteDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-common.ps1')
$root = Split-Path $PSScriptRoot -Parent
if (!$Runtime) { $Runtime = Get-StrifeRuntime }
if ($Runtime -ne (Get-StrifeRuntime)) { throw 'Publish on the target OS and architecture: the voice engine and packaging tools are native.' }
$Version = Get-StrifeVersion $Version
if ($StreamingDirectory -and !$IncludeDevelopmentStreaming) { throw 'StreamingDirectory requires -IncludeDevelopmentStreaming.' }
if ($IncludeDevelopmentStreaming) {
    if ($Runtime -ne 'win-x64' -or $Version -notmatch '-') { throw 'Development streaming requires a Windows prerelease package.' }
    . (Join-Path $PSScriptRoot 'streaming-package.ps1')
    $streaming = if ($StreamingDirectory) { [IO.Path]::GetFullPath($StreamingDirectory) } else { Join-Path $root 'artifacts/streaming' }
    Test-StrifeStreamingPayload -Directory $streaming -Smoke
}
if ($BuildVoice) { & (Join-Path $PSScriptRoot 'build-voice.ps1') }
$voice = if ($VoiceDirectory) { [IO.Path]::GetFullPath($VoiceDirectory) } else { Join-Path $root 'artifacts/voice' }
$voiceExecutable = if ($IsWindows) { 'strife-voice.exe' } elseif ($IsMacOS) { 'StrifeVoice.app/Contents/MacOS/Mumble' } else { 'strife-voice' }
$required = @($voiceExecutable, 'MUMBLE-LICENSE', 'RNNOISE-LICENSE', 'build-info.json')
if ($IsWindows) { $required += @('rnnoise.dll', 'speexdsp.dll') }
foreach ($file in $required) {
    if (!(Test-Path (Join-Path $voice $file))) { throw "Missing native payload $file. Run ./scripts/build-voice.ps1 first." }
}
$buildInfo = Get-Content (Join-Path $voice 'build-info.json') -Raw | ConvertFrom-Json
if ($buildInfo.runtime -ne $Runtime) { throw "Voice runtime $($buildInfo.runtime) does not match $Runtime." }
$output = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $root 'artifacts/Strife' }
if ($OutputDirectory) {
    if ((Test-Path $output) -and (Get-ChildItem -LiteralPath $output -Force | Select-Object -First 1)) {
        throw 'OutputDirectory must be empty, so stale files cannot enter a release.'
    }
    New-Item -ItemType Directory -Path $output -Force | Out-Null
} else { Reset-StrifeStagingDirectory $output }
& dotnet publish (Join-Path $root 'src/Strife.Desktop/Strife.Desktop.csproj') -c Release -r $Runtime --self-contained true "-p:Version=$Version" -p:DebugType=None -p:DebugSymbols=false -o $output
if ($LASTEXITCODE) { throw 'Desktop publish failed.' }
if ($IsMacOS) {
    & ditto $voice (Join-Path $output 'voice')
    if ($LASTEXITCODE) { throw 'Voice staging failed.' }
} else { Copy-Item -LiteralPath $voice -Destination (Join-Path $output 'voice') -Recurse -Force }
if ($IncludeDevelopmentStreaming) {
    Copy-Item -LiteralPath $streaming -Destination (Join-Path $output 'streaming') -Recurse
    Test-StrifeStreamingPayload -Directory (Join-Path $output 'streaming') -Smoke
}
Copy-Item (Join-Path $root 'README.md'), (Join-Path $root 'THIRD-PARTY-NOTICES.md') $output -Force
Copy-Item (Join-Path $root 'docs') $output -Recurse -Force
@{ version = $Version; runtime = $Runtime; voiceRevision = $buildInfo.revision;
    developmentStreaming = [bool]$IncludeDevelopmentStreaming } | ConvertTo-Json | Set-Content (Join-Path $output 'release.json')
if (!$NoPackage) {
    if ($IsWindows) {
        & (Join-Path $PSScriptRoot 'package-windows.ps1') -PublishDirectory $output -Version $Version -InnoSetupCompiler $InnoSetupCompiler -PrerequisiteDirectory $PrerequisiteDirectory
    } else {
        & (Join-Path $PSScriptRoot 'package-unix.ps1') -PublishDirectory $output -Runtime $Runtime -Version $Version
    }
}
Write-Host "Published Strife $Version ($Runtime): $output"

param([switch]$BuildVoice, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if ($BuildVoice) { & (Join-Path $PSScriptRoot 'build-voice.ps1') }
$voice = Join-Path $root 'artifacts/voice'
if (!(Test-Path (Join-Path $voice 'strife-voice.exe')) -or !(Test-Path (Join-Path $voice 'rnnoise.dll'))) {
    throw 'Build the native engine first: ./scripts/build-voice.ps1'
}
$output = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $root 'artifacts/Strife' }
& dotnet publish (Join-Path $root 'src/Strife.Desktop/Strife.Desktop.csproj') -c Release -r win-x64 --self-contained true -o $output
if ($LASTEXITCODE) { throw 'Desktop publish failed.' }
New-Item -ItemType Directory -Force (Join-Path $output 'voice') | Out-Null
Copy-Item (Join-Path $voice '*') (Join-Path $output 'voice') -Recurse -Force
Copy-Item (Join-Path $root 'README.md') $output -Force
Copy-Item (Join-Path $root 'THIRD-PARTY-NOTICES.md') $output -Force
New-Item -ItemType Directory -Force (Join-Path $output 'docs') | Out-Null
Copy-Item (Join-Path $root 'docs/*') (Join-Path $output 'docs') -Recurse -Force
Write-Host "Run $(Join-Path $output 'Strife.exe')"

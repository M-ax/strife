#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/windows-dotnet.ps1')
$stage = Join-Path (Split-Path $PSScriptRoot -Parent) ('artifacts/dotnet-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $stage | Out-Null
function Reject([scriptblock]$Action) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    if (!$rejected) { throw 'Expected invalid runtime payload to be rejected.' }
}
function Write-Options($Options) {
    @{ runtimeOptions = $Options } | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $stage 'Strife.runtimeconfig.json')
}
try {
    $frameworks = @(
        @{ name = 'Microsoft.NETCore.App'; version = '10.0.2' },
        @{ name = 'Microsoft.AspNetCore.App'; version = '10.0.2' }
    )
    Write-Options @{ frameworks = $frameworks; rollForward = 'LatestPatch' }
    if (@(Get-StrifeDotNetFrameworks $stage).Count -ne 2) { throw 'Expected both frameworks.' }
    Reject { Assert-StrifePortableRuntime $stage }
    Write-Options @{ frameworks = $frameworks; rollForward = 'LatestMajor' }
    Reject { Get-StrifeDotNetFrameworks $stage }
    Write-Options @{ frameworks = @($frameworks[0], $frameworks[0]); rollForward = 'LatestPatch' }
    Reject { Get-StrifeDotNetFrameworks $stage }
    Write-Options @{ includedFrameworks = $frameworks }
    Reject { Assert-StrifePortableRuntime $stage }
    Set-Content (Join-Path $stage 'coreclr.dll') 'test runtime sentinel'
    Assert-StrifePortableRuntime $stage
    Reject { Get-StrifeDotNetFrameworks $stage }
    Write-Options @{ frameworks = $frameworks; rollForward = 'LatestPatch' }
    Reject { Get-StrifeDotNetFrameworks $stage }

    $metadata = @{ releases = @(
        foreach ($version in @('10.0.1', '10.0.4', '10.0.5-preview.1', '10.1.0', '11.0.0')) {
            @{
                runtime = @{
                    version = $version
                    files = @(
                        @{ rid = 'win-x86'; url = "https://example.invalid/$version-x86.exe"; hash = ('a' * 128) },
                        @{ rid = 'win-x64'; url = "https://example.invalid/$version.exe"; hash = ('b' * 128) },
                        @{ rid = 'win-x64'; url = "https://example.invalid/$version.zip"; hash = ('c' * 128) }
                    )
                }
            }
        }
    ) }
    $download = Get-StrifeDotNetDownload ([pscustomobject]$frameworks[0]) ([pscustomobject]$metadata)
    if ($download.url -ne 'https://example.invalid/10.0.4.exe') { throw 'Did not select the latest compatible stable x64 installer.' }
    Reject { Get-StrifeDotNetDownload ([pscustomobject]@{ name = 'Microsoft.NETCore.App'; version = '10.0.9' }) ([pscustomobject]$metadata) }
    Reject { Get-StrifeDotNetDownload ([pscustomobject]$frameworks[1]) ([pscustomobject]$metadata) }
    $metadata.releases[1].runtime.files[1].hash = 'invalid'
    Reject { Get-StrifeDotNetDownload ([pscustomobject]$frameworks[0]) ([pscustomobject]$metadata) }
    Write-Host 'PASS: framework-dependent and portable payload validation, stable x64 runtime selection and rejection cases.'
} finally { Remove-Item -LiteralPath $stage -Recurse -Force }

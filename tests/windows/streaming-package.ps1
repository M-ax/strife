#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $root 'scripts/streaming-package.ps1')
$original = Join-Path $root 'artifacts/streaming'
Test-StrifeStreamingPayload -Directory $original -Smoke
$temporary = Join-Path $root ('artifacts/streaming-package-test-' + [Guid]::NewGuid().ToString('N'))
Copy-Item -LiteralPath $original -Destination $temporary -Recurse
function Reject-Payload([string]$name) {
    $rejected = $false
    try { Test-StrifeStreamingPayload -Directory $temporary } catch { $rejected = $true }
    if (!$rejected) { throw "FAIL: $name" }
    Write-Output "PASS: $name"
}
try {
    $manifestPath = Join-Path $temporary 'build-info.json'
    $json = Get-Content $manifestPath -Raw
    [IO.File]::WriteAllText((Join-Path $temporary 'unexpected.txt'), 'unexpected')
    Reject-Payload 'unlisted files cannot enter a package'
    Remove-Item (Join-Path $temporary 'unexpected.txt')
    $manifest = $json | ConvertFrom-Json
    $manifest.files[0].path = '../escape'
    $manifest | ConvertTo-Json -Depth 5 | Set-Content $manifestPath
    Reject-Payload 'manifest cannot escape payload'
    Set-Content $manifestPath $json
    [IO.File]::AppendAllText((Join-Path $temporary 'source/main.cpp'), "`n// changed")
    Reject-Payload 'changed source/binary hashes cannot enter a package'
    Write-Output 'PASS: clean payload startup with system-only PATH'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}

#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'native/voice-build.ps1')
. (Join-Path $root 'scripts/release-common.ps1')
$fixture = Join-Path $root ('artifacts/native-build-test-' + [Guid]::NewGuid().ToString('N'))
$count = 0
function Check([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw "FAIL: $Message" }
    $script:count++
    Write-Host "PASS: $Message"
}
function Reject([scriptblock]$Action, [string]$Message) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Check $rejected $Message
}
try {
    foreach ($file in @('native/bridge.cpp', 'native/voice-build.ps1', 'native/fix.patch',
        'scripts/build-voice.ps1', 'scripts/prepare-release.ps1')) {
        Write-Changed (Join-Path $fixture $file) "original`n"
    }
    $revision = 'a' * 40
    Write-Changed (Join-Path $fixture 'packaging/native-dependencies.json') (@{ mumbleRevision = $revision } | ConvertTo-Json)
    $hash = Get-StrifeVoiceBuildHash $fixture
    Check ($hash -cmatch '^[a-f0-9]{64}$' -and $hash -eq (Get-StrifeVoiceBuildHash $fixture)) 'native hash is deterministic'
    foreach ($file in @('README.md', 'docs/releases.md', 'package.json', 'src/Host.cs', 'scripts/publish.ps1',
        'scripts/release-common.ps1', '.github/workflows/publish.yml')) {
        Write-Changed (Join-Path $fixture $file) "app-only change`n"
    }
    Check ($hash -eq (Get-StrifeVoiceBuildHash $fixture)) 'app, documentation, packaging and workflow changes preserve native inputs'
    foreach ($file in @('native/bridge.cpp', 'native/voice-build.ps1', 'native/fix.patch',
        'scripts/build-voice.ps1', 'scripts/prepare-release.ps1', 'packaging/native-dependencies.json')) {
        $path = Join-Path $fixture $file
        $old = [IO.File]::ReadAllText($path)
        [IO.File]::WriteAllText($path, $old + "`nchanged")
        Check ($hash -ne (Get-StrifeVoiceBuildHash $fixture)) "$file invalidates native inputs"
        [IO.File]::WriteAllText($path, $old)
    }
    $extra = Join-Path $fixture 'native/extra.h'
    Write-Changed $extra 'extra'
    Check ($hash -ne (Get-StrifeVoiceBuildHash $fixture)) 'new native files invalidate the cache'
    Remove-Item -LiteralPath $extra
    Check ($hash -eq (Get-StrifeVoiceBuildHash $fixture)) 'removing the extra file restores the original input hash'
    $bridge = Join-Path $fixture 'native/bridge.cpp'
    [IO.File]::WriteAllText($bridge, "original`r`n")
    Check ($hash -eq (Get-StrifeVoiceBuildHash $fixture)) 'equivalent Windows and Unix line endings have the same fingerprint'
    $valid = @{ runtime = 'win-x64'; revision = $revision; nativeInputsSha256 = $hash }
    Assert-StrifeVoiceBuildInfo $fixture $valid 'win-x64'
    Check $true 'matching native build metadata is accepted'
    Reject { Assert-StrifeVoiceBuildInfo $fixture @{ runtime = 'win-x64'; revision = $revision } 'win-x64' } 'old metadata without native provenance is rejected'
    Reject { Assert-StrifeVoiceBuildInfo $fixture @{ runtime = 'win-x64'; revision = $revision; nativeInputsSha256 = ('0' * 64) } 'win-x64' } 'stale native metadata is rejected'
    Reject { Assert-StrifeVoiceBuildInfo $fixture $valid 'linux-x64' } 'a different runtime is rejected'
    Reject { Assert-StrifeVoiceBuildInfo $fixture @{ runtime = 'win-x64'; revision = ('b' * 40); nativeInputsSha256 = $hash } 'win-x64' } 'a different Mumble revision is rejected'

    $upstream = Join-Path $fixture 'upstream'
    $snapshot = Join-Path $fixture 'snapshot'
    $patch = Join-Path $fixture 'fixture.patch'
    $paths = @(& git -C $root apply --numstat (Join-Path $root 'native/mumble-xinput-reconnect.patch') |
        ForEach-Object { $_.Split("`t")[-1] })
    if ($LASTEXITCODE -or $paths.Count -ne 8) { throw 'Unexpected backport file set.' }
    foreach ($file in $paths) { Write-Changed (Join-Path $upstream $file) "original`n" }
    $diff = @'
diff --git a/src/mumble/XboxInput.cpp b/src/mumble/XboxInput.cpp
--- a/src/mumble/XboxInput.cpp
+++ b/src/mumble/XboxInput.cpp
@@ -1 +1 @@
-original
+fixed
'@ + "`n"
    [IO.File]::WriteAllText($patch, $diff.Replace("`r`n", "`n"))
    Update-StrifeXInputSources $fixture $upstream $snapshot $patch
    $target = Join-Path $snapshot 'src/mumble/XboxInput.cpp'
    Check ([IO.File]::ReadAllText($target) -ceq "fixed`n") 'the patch is applied to the private snapshot'
    Check ([IO.File]::ReadAllText((Join-Path $upstream 'src/mumble/XboxInput.cpp')) -ceq "original`n") 'the source checkout is never patched'
    [IO.File]::WriteAllText($patch, $diff.Replace("`r`n", "`n").Replace("`n", "`r`n"))
    [IO.File]::WriteAllText((Join-Path $upstream 'src/mumble/XboxInput.cpp'), "original`r`n")
    Update-StrifeXInputSources $fixture $upstream $snapshot $patch
    Check ([IO.File]::ReadAllText($target) -ceq "fixed`n") 'CRLF patches and upstream files produce the same LF snapshot'
    Check ([IO.File]::ReadAllText((Join-Path $upstream 'src/mumble/XboxInput.cpp')) -ceq "original`r`n") 'Windows source line endings remain untouched'
    [IO.File]::SetLastWriteTimeUtc($target, [DateTime]::new(2001, 1, 1, 0, 0, 0, [DateTimeKind]::Utc))
    $written = [IO.File]::GetLastWriteTimeUtc($target)
    Update-StrifeXInputSources $fixture $upstream $snapshot $patch
    Check ([IO.File]::GetLastWriteTimeUtc($target) -eq $written) 'repeat preparation does not stack patches or touch unchanged files'
    [IO.File]::WriteAllText($patch, $diff.Replace('+fixed', '+updated').Replace("`r`n", "`n"))
    Update-StrifeXInputSources $fixture $upstream $snapshot $patch
    Check ([IO.File]::ReadAllText($target) -ceq "updated`n") 'a changed patch is rebuilt from pristine source'
    [IO.File]::WriteAllText((Join-Path $upstream 'src/mumble/XboxInput.cpp'), "unexpected`n")
    Reject { Update-StrifeXInputSources $fixture $upstream $snapshot $patch } 'unexpected upstream context fails rather than silently skipping the patch'
    Check ([IO.File]::ReadAllText($target) -ceq "updated`n") 'a failed patch leaves the previous snapshot untouched'
    Write-Host "$count native build checks passed."
} finally {
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}

#requires -Version 7.0
param(
    [Parameter(Mandatory)][ValidateSet('win-x64','linux-x64','osx-x64','osx-arm64')][string]$Runtime,
    [switch]$CheckOnly,
    [string]$ArchiveDirectory,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'release-common.ps1')
. (Join-Path $root 'native/voice-build.ps1')
$baseline = Get-Content (Join-Path $root 'packaging/voice-release.json') -Raw | ConvertFrom-Json
if ($baseline.sourceRef -notmatch '^[a-f0-9]{40}$') { throw 'Invalid voice recovery source ref.' }
function Write-Result([string]$Name, [string]$Value) {
    Write-Host "$Name=$Value"
    if ($env:GITHUB_OUTPUT) { "$Name=$Value" >> $env:GITHUB_OUTPUT }
}
# These are exactly the inputs used by the compiled Mumble Actions cache.
& git -C $root cat-file -e "$($baseline.sourceRef)^{commit}" 2>$null
if ($LASTEXITCODE) {
    & git -C $root fetch --no-tags --depth=1 origin $baseline.sourceRef
    if ($LASTEXITCODE) { throw 'Cannot verify the voice recovery source.' }
}
& git -C $root diff --quiet $baseline.sourceRef -- native scripts/build-voice.ps1 scripts/prepare-release.ps1 packaging/native-dependencies.json
$diffStatus = $LASTEXITCODE
if ($diffStatus -gt 1) { throw 'Cannot compare native cache inputs.' }
if (@(& git -C $root ls-files --others --exclude-standard -- native).Count) { $diffStatus = 1 }
if ($diffStatus -ne 0) {
    if (!$CheckOnly) { throw 'Native cache inputs changed; compile a fresh voice engine.' }
    Write-Result eligible false
    exit 0
}
if ($CheckOnly) {
    Write-Result eligible true
    Write-Result run-id $baseline.runId
    Write-Result artifact "Strife-$Runtime"
    exit 0
}
if ($Runtime -ne (Get-StrifeRuntime)) { throw 'Recover voice on its target OS and architecture.' }
$entry = $baseline.archives.$Runtime
if (!$entry -or $entry.filename -notmatch '^Strife-[\w.-]+\.(zip|tar\.gz)$' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') {
    throw 'Invalid pinned voice archive.'
}
$archive = Join-Path ([IO.Path]::GetFullPath($ArchiveDirectory)) $entry.filename
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $entry.sha256) { throw 'Voice donor archive hash mismatch.' }
$destination = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $root 'artifacts/voice' }
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $root 'artifacts')) + [IO.Path]::DirectorySeparatorChar
if (!$destination.StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Voice recovery must stay under artifacts.' }
if ((Test-Path $destination) -and @(Get-ChildItem -LiteralPath $destination -Force).Count) {
    throw 'Refusing to overwrite an existing voice payload.'
}
$stage = Join-Path $root ('artifacts/voice-recovery-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $stage | Out-Null
try {
    if ($IsWindows) {
        Expand-Archive -LiteralPath $archive -DestinationPath $stage
        $source = Join-Path $stage 'voice'
    } elseif ($IsMacOS) {
        & ditto -x -k $archive $stage
        if ($LASTEXITCODE) { throw 'Cannot extract voice donor.' }
        $source = Join-Path $stage 'Strife.app/Contents/Resources/voice'
    } else {
        & tar -xzf $archive -C $stage
        if ($LASTEXITCODE) { throw 'Cannot extract voice donor.' }
        $source = Join-Path $stage 'Strife/voice'
    }
    $info = Get-Content (Join-Path $source 'build-info.json') -Raw | ConvertFrom-Json
    Assert-StrifeVoiceBuildInfo $root $info $Runtime
    New-Item -ItemType Directory -Force $destination | Out-Null
    if ($IsMacOS) {
        # The shipped bundle links Resources/voice to Contents/Helpers. Restore
        # the original standalone cache layout before repackaging/signing.
        $item = Get-Item -LiteralPath (Join-Path $source 'StrifeVoice.app') -Force
        if (!$item.LinkType) { throw 'Unexpected voice app layout in the donor package.' }
        foreach ($resource in Get-ChildItem -LiteralPath $source -Force | Where-Object Name -ne 'StrifeVoice.app') {
            & ditto $resource.FullName (Join-Path $destination $resource.Name)
            if ($LASTEXITCODE) { throw 'Cannot copy recovered voice resources.' }
        }
        & ditto (Join-Path $stage 'Strife.app/Contents/Helpers/StrifeVoice.app') (Join-Path $destination 'StrifeVoice.app')
        if ($LASTEXITCODE) { throw 'Cannot restore the voice app.' }
    } elseif ($IsLinux) {
        & cp -a "$source/." $destination
        if ($LASTEXITCODE) { throw 'Cannot copy recovered voice payload.' }
    } else {
        Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $destination -Recurse
    }
    Write-Result restored true
    Write-Host "Recovered the unchanged pinned voice engine from $($baseline.version); normal package/startup checks still apply."
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force
}

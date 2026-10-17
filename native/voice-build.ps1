# These inputs match the compiled voice cache and release-recovery scopes.
function Get-StrifeVoiceBuildHash([string]$Root) {
    $paths = @(
        Get-ChildItem -LiteralPath (Join-Path $Root 'native') -File -Recurse |
            ForEach-Object { [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/') }
        'scripts/build-voice.ps1'
        'scripts/prepare-release.ps1'
        'packaging/native-dependencies.json'
    )
    [Array]::Sort($paths, [StringComparer]::Ordinal)
    $sha = [Security.Cryptography.SHA256]::Create()
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $entries = [Text.StringBuilder]::new("strife-voice-inputs-v1`n")
    try {
        foreach ($path in $paths) {
            $bytes = [IO.File]::ReadAllBytes((Join-Path $Root $path))
            if ([IO.Path]::GetExtension($path) -in @('.cpp', '.h', '.ps1', '.json', '.md', '.patch')) {
                # Git checkouts on Windows may use CRLF for the same source.
                $text = $utf8.GetString($bytes).TrimStart([char]0xfeff).Replace("`r`n", "`n")
                $bytes = $utf8.GetBytes($text)
            }
            $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
            [void]$entries.Append("$path`0$hash`n")
        }
        return [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($entries.ToString()))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Write-Changed([string]$Path, [string]$Content) {
    if (!(Test-Path -LiteralPath $Path) -or [IO.File]::ReadAllText($Path) -cne $Content) {
        [void][IO.Directory]::CreateDirectory((Split-Path $Path -Parent))
        [IO.File]::WriteAllText($Path, $Content)
    }
}

function Update-StrifeXInputSources(
    [string]$Root, [string]$MumbleSource, [string]$Snapshot, [string]$PatchPath
) {
    if (!$PatchPath) { $PatchPath = Join-Path $Root 'native/mumble-xinput-reconnect.patch' }
    $files = @(
        'src/mumble/GlobalShortcut_win.cpp', 'src/mumble/GlobalShortcut_win.h',
        'src/mumble/XboxInput.cpp', 'src/mumble/XboxInput.h',
        'src/tests/CMakeLists.txt', 'src/tests/TestXboxInput/CMakeLists.txt',
        'src/tests/TestXboxInput/TestXboxInput.cpp', 'src/tests/TestXboxInput/README.md'
    )
    $stage = Join-Path $Root ('artifacts/xinput-patch-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($stage)
    try {
        foreach ($file in $files) {
            $original = Join-Path $MumbleSource $file
            if (Test-Path -LiteralPath $original) {
                Write-Changed (Join-Path $stage $file) ([IO.File]::ReadAllText($original).Replace("`r`n", "`n"))
            }
        }
        $gitRoot = (& git -C $Root rev-parse --show-toplevel).Trim()
        if ($LASTEXITCODE) { throw 'Cannot locate the Strife checkout for native patch application.' }
        $relativeStage = [IO.Path]::GetRelativePath($gitRoot, $stage).Replace('\', '/')
        & git -C $gitRoot apply --check "--directory=$relativeStage" $PatchPath
        if ($LASTEXITCODE) { throw 'The XInput backport does not match the pinned Mumble source.' }
        & git -C $gitRoot apply "--directory=$relativeStage" $PatchPath
        if ($LASTEXITCODE) { throw 'Cannot apply the XInput reconnect backport.' }
        # Always patch pristine inputs, then preserve unchanged snapshot timestamps.
        $contents = @{}
        foreach ($file in $files) { $contents[$file] = [IO.File]::ReadAllText((Join-Path $stage $file)).Replace("`r`n", "`n") }
        foreach ($file in $files) { Write-Changed (Join-Path $Snapshot $file) $contents[$file] }
    } finally { Remove-Item -LiteralPath $stage -Recurse -Force }
}

function Get-StrifeVersion([string]$Version) {
    if (!$Version) {
        $Version = (Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
    }
    $Version = $Version -creplace '^v', ''
    if ($Version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?\z') {
        throw 'Release version must be MAJOR.MINOR.PATCH with an optional prerelease suffix (and optional v prefix).'
    }
    foreach ($part in ($Version.Split('-')[0].Split('.'))) {
        if ([long]$part -gt 65535) { throw 'Version components must fit Windows version resources (0-65535).' }
    }
    return $Version
}

function Get-StrifeRuntime {
    $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    if ($IsWindows) { return "win-$architecture" }
    if ($IsMacOS) { return "osx-$architecture" }
    if ($IsLinux) { return "linux-$architecture" }
    throw 'Strife supports Windows, macOS and Linux.'
}

function Reset-StrifeStagingDirectory([string]$Path) {
    $artifacts = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts')) + [IO.Path]::DirectorySeparatorChar
    $target = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if (!$target.StartsWith($artifacts, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Only a child of this checkout''s artifacts directory can be reset.'
    }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
}

#requires -Version 7.0
# Fetch the same native toolchains used by upstream Mumble, with pinned hashes.
param([Parameter(Mandatory)][ValidateSet('win-x64', 'linux-x64', 'osx-x64', 'osx-arm64')][string]$Runtime)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$config = Get-Content (Join-Path $root 'packaging/native-dependencies.json') -Raw | ConvertFrom-Json
$dependency = $config.environments.$Runtime
$source = Join-Path $root 'artifacts/upstream/mumble'
if (!(Test-Path $source)) {
    & git clone --no-checkout https://github.com/mumble-voip/mumble.git $source
    if ($LASTEXITCODE) { throw 'Mumble clone failed.' }
}
& git -C $source checkout --detach $config.mumbleRevision
if ($LASTEXITCODE) { throw 'Mumble checkout failed.' }
& git -C $source submodule update --init --recursive --depth 1
if ($LASTEXITCODE) { throw 'Mumble submodule checkout failed.' }
$destination = Join-Path $root 'artifacts/build-env'
$stamp = Join-Path $destination '.strife-environment'
if (Test-Path $stamp) {
    if ((Get-Content $stamp -Raw).Trim() -ne $dependency.sha256) { throw 'Cached native environment has changed. Use a clean artifacts/build-env directory.' }
    return
}
$download = Join-Path $root "artifacts/$($dependency.archive)"
if (!(Test-Path $download)) {
    Invoke-WebRequest "https://github.com/mumble-voip/vcpkg/releases/download/$($config.environmentRelease)/$($dependency.archive)" -OutFile $download
}
if ((Get-FileHash $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $dependency.sha256) { throw 'Native environment checksum mismatch.' }
$extract = Join-Path $root ('artifacts/extract-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $extract, $destination | Out-Null
if ($IsWindows) { & 7z x $download "-o$extract" -y | Out-Null } else { & tar -xf $download -C $extract }
if ($LASTEXITCODE) { throw 'Native environment extraction failed.' }
$items = @(Get-ChildItem -LiteralPath $extract -Force)
$payload = if ($items.Count -eq 1 -and $items[0].PSIsContainer) { $items[0].FullName } else { $extract }
# Validate both resolved paths before moving any extracted directories.
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $root 'artifacts')) + [IO.Path]::DirectorySeparatorChar
foreach ($path in @($payload, $destination)) {
    if (![IO.Path]::GetFullPath($path).StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Native toolchain staging must remain inside artifacts.'
    }
}
Get-ChildItem -LiteralPath $payload -Force | Move-Item -Destination $destination
if (!(Test-Path (Join-Path $destination 'scripts/buildsystems/vcpkg.cmake'))) { throw 'Native environment does not contain a vcpkg toolchain.' }
$dependency.sha256 | Set-Content $stamp

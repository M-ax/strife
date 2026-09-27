param(
    [Parameter(Mandatory)][string]$PublishDirectory,
    [Parameter(Mandatory)][ValidateSet('linux-x64', 'osx-x64', 'osx-arm64')][string]$Runtime,
    [string]$Version
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-common.ps1')
if ($Runtime -ne (Get-StrifeRuntime)) { throw 'Package on the target OS and architecture.' }
$root = Split-Path $PSScriptRoot -Parent
$Version = Get-StrifeVersion $Version
$PublishDirectory = [IO.Path]::GetFullPath($PublishDirectory)
if (!(Test-Path (Join-Path $PublishDirectory 'Strife'))) { throw 'Publish Strife before packaging it.' }
$release = Join-Path $root 'artifacts/release'
New-Item -ItemType Directory -Force $release | Out-Null
$stage = Join-Path $root "artifacts/package-$Runtime"
Reset-StrifeStagingDirectory $stage
if ($IsMacOS) {
    $app = Join-Path $stage 'Strife.app'
    $contents = Join-Path $app 'Contents'
    New-Item -ItemType Directory -Force (Join-Path $contents 'Resources') | Out-Null
    & ditto $PublishDirectory (Join-Path $contents 'MacOS')
    if ($LASTEXITCODE) { throw 'App bundle staging failed.' }
    $plist = (Get-Content (Join-Path $root 'packaging/macos/Info.plist') -Raw).Replace('@VERSION@', $Version.Split('-')[0])
    [IO.File]::WriteAllText((Join-Path $contents 'Info.plist'), $plist)
    $iconset = Join-Path $stage 'Strife.iconset'
    New-Item -ItemType Directory $iconset | Out-Null
    foreach ($size in @(16, 32, 128, 256, 512)) {
        foreach ($scale in @(1, 2)) {
            $suffix = if ($scale -eq 2) { '@2x' } else { '' }
            & sips -z ($size * $scale) ($size * $scale) (Join-Path $PublishDirectory 'wwwroot/assets/strife.png') --out (Join-Path $iconset "icon_${size}x${size}$suffix.png") | Out-Null
            if ($LASTEXITCODE) { throw 'macOS icon rendering failed.' }
        }
    }
    & iconutil -c icns $iconset -o (Join-Path $contents 'Resources/strife.icns')
    if ($LASTEXITCODE) { throw 'macOS icon packaging failed.' }
    # Give the sidecar its own identity and microphone usage description.
    $helpers = Join-Path $contents 'Helpers'
    New-Item -ItemType Directory $helpers | Out-Null
    $voiceApp = Join-Path $helpers 'StrifeVoice.app'
    Move-Item -LiteralPath (Join-Path $contents 'MacOS/voice/StrifeVoice.app') -Destination $voiceApp
    & ln -s '../../Helpers/StrifeVoice.app' (Join-Path $contents 'MacOS/voice/StrifeVoice.app')
    if ($LASTEXITCODE) { throw 'Cannot link the voice app.' }
    # codesign treats everything in MacOS as native code. Managed assemblies,
    # configuration, web assets and notices belong in Resources. Relative links
    # preserve .NET's app-local lookup paths without signing PE files as Mach-O.
    # https://developer.apple.com/library/archive/technotes/tn2206/_index.html
    foreach ($item in Get-ChildItem -LiteralPath (Join-Path $contents 'MacOS')) {
        if (!$item.PSIsContainer -and $item.Name -eq 'Strife') { continue }
        if (!$item.PSIsContainer -and ($item.Extension -eq '.dylib' -or $item.Name -eq 'createdump')) {
            # .NET resolves Strife.dll to Resources and searches for its runtime
            # and native imports there. Keep native code in MacOS, linking back
            # from the managed assembly's directory for self-contained lookup.
            & ln -s "../MacOS/$($item.Name)" (Join-Path $contents "Resources/$($item.Name)")
            if ($LASTEXITCODE) { throw "Cannot link native library: $($item.Name)" }
            continue
        }
        Move-Item -LiteralPath $item.FullName -Destination (Join-Path $contents "Resources/$($item.Name)")
        & ln -s "../Resources/$($item.Name)" $item.FullName
        if ($LASTEXITCODE) { throw "Cannot link resource: $($item.Name)" }
    }
    & /usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier io.github.m-ax.strife.voice' (Join-Path $voiceApp 'Contents/Info.plist')
    if ($LASTEXITCODE) { throw 'Cannot set the voice bundle identifier.' }
    # Ad-hoc signing preserves executable integrity on Apple Silicon. Developer
    # ID signing/notarization requires the publisher's Apple credentials.
    # Sign nested code first; signing the outer app also signs its main executable.
    foreach ($binary in Get-ChildItem $contents -Recurse -File | Where-Object { !$_.LinkType -and ($_.Extension -eq '.dylib' -or $_.Name -in @('createdump', 'Mumble')) }) {
        & codesign --force --sign - $binary.FullName
        if ($LASTEXITCODE) { throw "Ad-hoc signing failed: $($binary.Name)" }
    }
    & codesign --force --sign - $voiceApp
    if ($LASTEXITCODE) { throw 'Voice app signing failed.' }
    & codesign --force --sign - $app
    if ($LASTEXITCODE) { throw 'App signing failed.' }
    & codesign --verify --deep --strict $app
    if ($LASTEXITCODE) { throw 'App signature verification failed.' }
    & plutil -lint (Join-Path $contents 'Info.plist')
    if ($LASTEXITCODE) { throw 'Invalid app metadata.' }
    & ditto -c -k --sequesterRsrc --keepParent $app (Join-Path $release "Strife-$Version-$Runtime.zip")
    if ($LASTEXITCODE) { throw 'macOS archive failed.' }
} else {
    Copy-Item -LiteralPath $PublishDirectory -Destination (Join-Path $stage 'Strife') -Recurse
    & chmod +x (Join-Path $stage 'Strife/Strife') (Join-Path $stage 'Strife/voice/strife-voice')
    if ($LASTEXITCODE) { throw 'Cannot set executable permissions.' }
    & tar -czf (Join-Path $release "Strife-$Version-$Runtime.tar.gz") -C $stage Strife
    if ($LASTEXITCODE) { throw 'Linux archive failed.' }
}

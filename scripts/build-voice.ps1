#requires -Version 7.0
param(
    [string]$MumbleSource = $env:STRIFE_MUMBLE_SOURCE,
    [string]$VcpkgRoot = $env:STRIFE_VCPKG_ROOT,
    [string]$Generator,
    [int]$Parallel = 4,
    [switch]$PrepareOnly,
    [switch]$WithServer,
    [switch]$RefreshSource
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-common.ps1')
$root = Split-Path $PSScriptRoot -Parent
if (!$MumbleSource) {
    $MumbleSource = Join-Path $root 'artifacts/upstream/mumble'
    if ($IsWindows -and !(Test-Path $MumbleSource)) { $MumbleSource = 'C:\Users\Max\CLionProjects\mumble' }
}
if (!$VcpkgRoot) {
    $VcpkgRoot = Join-Path $root 'artifacts/build-env'
    if ($IsWindows -and !(Test-Path $VcpkgRoot)) { $VcpkgRoot = 'C:\Users\Max\Source\vcpkg-master' }
}
$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$triplet = if ($IsWindows) { 'x64-windows-static-md' } elseif ($IsMacOS) { "$architecture-osx" } else { "$architecture-linux" }
if (!$Generator) { $Generator = if ($IsWindows) { 'Visual Studio 18 2026' } else { 'Ninja' } }
$source = Join-Path $root 'artifacts/mumble-source'
$build = Join-Path $root 'artifacts/mumble-build'
if (!(Test-Path (Join-Path $MumbleSource 'src/mumble/main.cpp'))) { throw 'MumbleSource must be a Mumble source checkout.' }
if (!(Test-Path (Join-Path $MumbleSource '3rdparty/rnnoise-src/COPYING'))) { throw 'Initialize the Mumble submodules first: git submodule update --init --recursive' }
New-Item -ItemType Directory -Force $source | Out-Null
$stamp = Join-Path $root 'artifacts/mumble-revision.txt'
$revision = (& git -C $MumbleSource rev-parse HEAD).Trim()
if ($LASTEXITCODE) { throw 'Cannot resolve Mumble source revision.' }
if (!(Test-Path $stamp) -or $RefreshSource) {
    if ($IsWindows) {
        & robocopy $MumbleSource $source /E /XD .git .idea .junie .ollamassist cmake-build-debug build /XF asdf.txt /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "Source copy failed: $LASTEXITCODE" }
    } else {
        Get-ChildItem -LiteralPath $MumbleSource -Force | Where-Object { $_.Name -notin @('.git', '.idea', 'build', 'cmake-build-debug') } |
            Copy-Item -Destination $source -Recurse -Force
    }
    $revision | Set-Content $stamp
} elseif ((Get-Content $stamp -Raw).Trim() -ne $revision) {
    throw 'Mumble HEAD changed. Use -RefreshSource to update the private source snapshot.'
}
function Write-Changed([string]$Path, [string]$Content) {
    if (!(Test-Path $Path) -or [IO.File]::ReadAllText($Path) -cne $Content) {
        [IO.File]::WriteAllText($Path, $Content)
    }
}
foreach ($name in @('StrifeBridge.h', 'StrifeBridge.cpp')) {
    Write-Changed (Join-Path $source "src/mumble/$name") ([IO.File]::ReadAllText((Join-Path $root "native/$name")))
}
$mainPath = Join-Path $source 'src/mumble/main.cpp'
$main = [IO.File]::ReadAllText((Join-Path $MumbleSource 'src/mumble/main.cpp')).Replace([string][char]13, '')
$loadAnchor = [char]9 + 'if (!Global::get().migratedDBPath.isEmpty()) {'
$loopAnchor = [char]9 + 'if (!Global::get().bQuit)' + [char]10 + [char]9 + [char]9 + 'res = a.exec();'
$rpcAnchor = 'SocketRPC *srpc = new SocketRPC(QLatin1String("Mumble"));'
if (!$main.Contains($loadAnchor) -or !$main.Contains($loopAnchor) -or !$main.Contains($rpcAnchor)) { throw 'Mumble startup changed; review the Strife bridge integration.' }
$main = '#include "StrifeBridge.h"' + [char]10 + $main.Replace($loadAnchor, [char]9 + 'initializeStrifeSettings();' + [char]10 + $loadAnchor).Replace($loopAnchor, [char]9 + 'startStrifeBridge();' + [char]10 + $loopAnchor)
$main = $main.Replace($rpcAnchor, 'SocketRPC *srpc = qEnvironmentVariableIsEmpty("STRIFE_PIPE") ? new SocketRPC(QLatin1String("Mumble")) : nullptr;')
Write-Changed $mainPath $main
$windowHeader = [IO.File]::ReadAllText((Join-Path $MumbleSource 'src/mumble/MainWindow.h'))
$visibilityAnchor = [char]9 + 'void showRaiseWindow();'
if (!$windowHeader.Contains($visibilityAnchor)) { throw 'Mumble main window changed; review the visibility override.' }
Write-Changed (Join-Path $source 'src/mumble/MainWindow.h') ($windowHeader.Replace($visibilityAnchor,
    [char]9 + 'void setVisible(bool visible) override;' + [Environment]::NewLine + $visibilityAnchor))
$windowSource = [IO.File]::ReadAllText((Join-Path $MumbleSource 'src/mumble/MainWindow.cpp'))
$raiseAnchor = 'void MainWindow::showRaiseWindow() {'
if (!$windowSource.Contains($raiseAnchor)) { throw 'Mumble activation changed; review hidden window handling.' }
# Accepted settings enqueue a raise after the dialog closes. Never enqueue it
# in Strife mode, even when the source is a tray action or global shortcut.
Write-Changed (Join-Path $source 'src/mumble/MainWindow.cpp') ($windowSource.Replace($raiseAnchor,
    $raiseAnchor + [Environment]::NewLine + [char]9 + 'if (!qEnvironmentVariableIsEmpty("STRIFE_PIPE")) return;'))
$settingsPath = Join-Path $source 'src/mumble/Settings.h'
$settings = [IO.File]::ReadAllText((Join-Path $MumbleSource 'src/mumble/Settings.h'))
$defaultNoise = 'NoiseCancel noiseCancelMode     = NoiseCancelSpeex;'
if (!$settings.Contains($defaultNoise)) { throw 'Mumble noise defaults changed; review RNNoise initialization.' }
Write-Changed $settingsPath ($settings.Replace($defaultNoise, 'NoiseCancel noiseCancelMode     = NoiseCancelRNN;'))
$cmakeAddition = @'

# Strife control adapter; audio and transport code remain upstream.
if(NOT rnnoise)
  message(FATAL_ERROR "Strife requires RNNoise")
endif()
target_sources(mumble_client_object_lib PRIVATE StrifeBridge.cpp StrifeBridge.h)
'@
Write-Changed (Join-Path $source 'src/mumble/CMakeLists.txt') ([IO.File]::ReadAllText((Join-Path $MumbleSource 'src/mumble/CMakeLists.txt')) + [Environment]::NewLine + $cmakeAddition)
if ($PrepareOnly) { return }
$toolchain = Join-Path $VcpkgRoot 'scripts/buildsystems/vcpkg.cmake'
if (!(Test-Path $toolchain)) { throw 'Pass -VcpkgRoot pointing to vcpkg with the Mumble dependencies installed.' }
$server = if ($WithServer) { 'ON' } else { 'OFF' }
$platformOptions = @()
if ($IsWindows -and $Generator -like 'Visual Studio*') { $platformOptions += @('-A', 'x64') }
if ($IsMacOS) { $platformOptions += "-DCMAKE_OSX_ARCHITECTURES=$(if ($architecture -eq 'arm64') { 'arm64' } else { 'x86_64' })" }
& cmake -S $source -B $build -G $Generator @platformOptions "-DCMAKE_TOOLCHAIN_FILE=$toolchain" "-DVCPKG_TARGET_TRIPLET=$triplet" '-Dstatic=ON' '-DCMAKE_BUILD_TYPE=Release' '-Dzeroconf=OFF' '-Dice=OFF' '-Ddbus=OFF' '-Dspeechd=OFF' '-DSOCI_MYSQL=OFF' '-DSOCI_POSTGRESQL=OFF' "-Dserver=$server" '-Dclient=ON' '-Drnnoise=ON' '-Dbundled-rnnoise=ON' '-Doverlay=OFF' '-Dplugins=OFF' '-Dpackaging=OFF' '-Dtests=OFF' '-Dupdate=OFF' '-Dcrash-report=OFF' '-Dwarnings-as-errors=OFF' '-Dlto=OFF' '-Dbundled-cli11=OFF' '-Dbundled-spdlog=OFF'
if ($LASTEXITCODE) { throw 'Native configuration failed.' }
$targets = @('mumble')
if ($WithServer) { $targets += 'mumble-server' }
& cmake --build $build --config Release --target $targets --parallel $Parallel
if ($LASTEXITCODE) { throw 'Native build failed.' }
$destination = Join-Path $root 'artifacts/voice'
Reset-StrifeStagingDirectory $destination
if ($IsWindows) {
    $exe = Join-Path $build 'Release/mumble.exe'
    if (!(Test-Path $exe)) { $exe = Join-Path $build 'mumble.exe' }
    Copy-Item $exe (Join-Path $destination 'strife-voice.exe') -Force
    Copy-Item (Join-Path (Split-Path $exe) '*.dll') $destination -Force
} elseif ($IsMacOS) {
    & ditto (Join-Path $build 'Mumble.app') (Join-Path $destination 'StrifeVoice.app')
    if ($LASTEXITCODE) { throw 'Voice app staging failed.' }
} else {
    Copy-Item (Join-Path $build 'mumble') (Join-Path $destination 'strife-voice') -Force
    & chmod +x (Join-Path $destination 'strife-voice')
    if ($LASTEXITCODE) { throw 'Cannot make the voice engine executable.' }
}
Copy-Item (Join-Path $MumbleSource 'LICENSE') (Join-Path $destination 'MUMBLE-LICENSE') -Force
Copy-Item (Join-Path $MumbleSource '3rdparty/rnnoise-src/COPYING') (Join-Path $destination 'RNNOISE-LICENSE') -Force
Copy-Item (Join-Path $MumbleSource '3rdPartyLicenses') $destination -Recurse -Force
Copy-Item (Join-Path $root 'artifacts/mumble-revision.txt') $destination -Force
$licenseDirectory = Join-Path $destination 'dependency-licenses'
New-Item -ItemType Directory -Force $licenseDirectory | Out-Null
Get-ChildItem (Join-Path $VcpkgRoot "installed/$triplet/share") -Directory | ForEach-Object {
    $copyright = Join-Path $_.FullName 'copyright'
    if (Test-Path $copyright) { Copy-Item $copyright (Join-Path $licenseDirectory "$($_.Name).txt") -Force }
}
@{ runtime = if ($IsWindows) { 'win-x64' } elseif ($IsMacOS) { "osx-$architecture" } else { "linux-$architecture" }; revision = $revision } |
    ConvertTo-Json | Set-Content (Join-Path $destination 'build-info.json')
Write-Host "Voice engine ready: $destination"

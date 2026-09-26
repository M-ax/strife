param(
    [string]$MumbleSource = 'C:\Users\Max\CLionProjects\mumble',
    [string]$VcpkgRoot = 'C:\Users\Max\Source\vcpkg-master',
    [switch]$PrepareOnly,
    [switch]$WithServer,
    [switch]$RefreshSource
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'artifacts/mumble-source'
$build = Join-Path $root 'artifacts/mumble-build'
if (!(Test-Path (Join-Path $MumbleSource 'src/mumble/main.cpp'))) { throw 'MumbleSource must be a Mumble source checkout.' }
if (!(Test-Path (Join-Path $MumbleSource '3rdparty/rnnoise-src/COPYING'))) { throw 'Initialize the Mumble submodules first: git submodule update --init --recursive' }
New-Item -ItemType Directory -Force $source | Out-Null
$stamp = Join-Path $root 'artifacts/mumble-revision.txt'
$revision = (& git -C $MumbleSource rev-parse HEAD).Trim()
if ($LASTEXITCODE) { throw 'Cannot resolve Mumble source revision.' }
if (!(Test-Path $stamp) -or $RefreshSource) {
    & robocopy $MumbleSource $source /E /XD .git .idea .junie .ollamassist cmake-build-debug build /XF asdf.txt /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Source copy failed: $LASTEXITCODE" }
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
& cmake -S $source -B $build -G 'Visual Studio 18 2026' -A x64 "-DCMAKE_TOOLCHAIN_FILE=$toolchain" '-DVCPKG_TARGET_TRIPLET=x64-windows-static-md' '-Dstatic=ON' '-DCMAKE_BUILD_TYPE=Release' '-Dzeroconf=OFF' '-Dice=OFF' '-Ddbus=OFF' '-DSOCI_MYSQL=OFF' '-DSOCI_POSTGRESQL=OFF' "-Dserver=$server" '-Dclient=ON' '-Drnnoise=ON' '-Dbundled-rnnoise=ON' '-Doverlay=OFF' '-Dplugins=OFF' '-Dpackaging=OFF' '-Dtests=OFF' '-Dupdate=OFF' '-Dcrash-report=OFF' '-Dwarnings-as-errors=OFF' '-Dlto=OFF' '-Dbundled-cli11=OFF' '-Dbundled-spdlog=OFF'
if ($LASTEXITCODE) { throw 'Native configuration failed.' }
$targets = @('mumble')
if ($WithServer) { $targets += 'mumble-server' }
& cmake --build $build --config Release --target $targets --parallel 8
if ($LASTEXITCODE) { throw 'Native build failed.' }
$destination = Join-Path $root 'artifacts/voice'
New-Item -ItemType Directory -Force $destination | Out-Null
$exe = Get-ChildItem $build -Recurse -Filter mumble.exe | Where-Object { $_.FullName -match 'Release' } | Select-Object -First 1
if (!$exe) { throw 'No Mumble executable was produced.' }
Copy-Item $exe.FullName (Join-Path $destination 'strife-voice.exe') -Force
Get-ChildItem $build -Recurse -Filter '*.dll' | Where-Object { $_.FullName -match 'Release' } | ForEach-Object { Copy-Item $_.FullName $destination -Force }
Copy-Item (Join-Path $MumbleSource 'LICENSE') (Join-Path $destination 'MUMBLE-LICENSE') -Force
Copy-Item (Join-Path $MumbleSource '3rdparty/rnnoise-src/COPYING') (Join-Path $destination 'RNNOISE-LICENSE') -Force
Copy-Item (Join-Path $MumbleSource '3rdPartyLicenses') $destination -Recurse -Force
Copy-Item (Join-Path $root 'artifacts/mumble-revision.txt') $destination -Force
Write-Host "Voice engine ready: $destination"

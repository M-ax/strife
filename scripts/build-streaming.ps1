#requires -Version 7.0
param([string]$ObsSource = (Join-Path $env:USERPROFILE 'WebstormProjects/helltube/apps/obs-studio'))
$ErrorActionPreference = 'Stop'
if (!$IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'The streaming prototype requires Windows x64.' }
$root = Split-Path $PSScriptRoot -Parent
$ObsSource = [IO.Path]::GetFullPath($ObsSource)
$revision = 'b5bfb79093e26ce4b0e71d999f59b6b22f961121'
if ((& git -C $ObsSource rev-parse HEAD) -ne $revision) { throw 'OBS source does not match the tested revision.' }
$cmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (!$cmake) { $cmake = Join-Path $env:ProgramFiles 'CMake/bin/cmake.exe' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$dumpbin = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe' | Select-Object -First 1
if (!$dumpbin) { throw 'Visual Studio C++ tools are required.' }
$build = Join-Path $root 'artifacts/streaming-build'
$whip = Join-Path $build 'whip'
New-Item -ItemType Directory -Force $whip | Out-Null
foreach ($name in @('obs-webrtc.cpp','whip-output.cpp','whip-output.h','whip-service.cpp','whip-service.h','whip-utils.h')) {
    $content = & git -C $ObsSource show "${revision}:plugins/obs-webrtc/$name"
    if ($LASTEXITCODE) { throw "Cannot read pinned WHIP source $name" }
    [IO.File]::WriteAllText((Join-Path $whip $name), ($content -join "`n") + "`n")
}
$outputFile = Join-Path $whip 'whip-output.cpp'
$outputCode = [IO.File]::ReadAllText($outputFile)
# Disable credential-bearing redirects and constrain DELETE resources to the original origin.
$originCheck = @'
#include <cctype>
static bool strife_same_origin(const std::string &endpoint, const std::string &resource)
{
    CURLU *a = curl_url(), *b = curl_url();
    bool same = !curl_url_set(a, CURLUPART_URL, endpoint.c_str(), 0) && !curl_url_set(b, CURLUPART_URL, resource.c_str(), 0);
    for (auto part : {CURLUPART_SCHEME, CURLUPART_HOST, CURLUPART_PORT}) {
        char *x = nullptr, *y = nullptr;
        if (curl_url_get(a, part, &x, CURLU_DEFAULT_PORT) || curl_url_get(b, part, &y, CURLU_DEFAULT_PORT)) same = false;
        else {
            std::string sx(x), sy(y);
            std::transform(sx.begin(), sx.end(), sx.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            std::transform(sy.begin(), sy.end(), sy.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            same = same && sx == sy;
        }
        curl_free(x); curl_free(y);
    }
    char *user = nullptr;
    if (!curl_url_get(b, CURLUPART_USER, &user, 0)) same = false;
    curl_free(user); curl_url_cleanup(a); curl_url_cleanup(b);
    return same;
}
'@
foreach ($anchor in @('CURLOPT_FOLLOWLOCATION, 1L', 'CURLOPT_UNRESTRICTED_AUTH, 1L', 'resource_url = url;')) {
    if (!$outputCode.Contains($anchor)) { throw "Pinned WHIP patch anchor missing: $anchor" }
}
$outputCode = $outputCode.Replace('#include "whip-output.h"', '#include "whip-output.h"' + "`n" + $originCheck)
$outputCode = $outputCode.Replace('CURLOPT_FOLLOWLOCATION, 1L', 'CURLOPT_FOLLOWLOCATION, 0L').Replace('CURLOPT_UNRESTRICTED_AUTH, 1L', 'CURLOPT_UNRESTRICTED_AUTH, 0L')
$outputCode = $outputCode.Replace('resource_url = url;', @'
if (!strife_same_origin(endpoint_url, url)) {
    curl_free(url); curl_url_cleanup(url_builder); doCleanup(false);
    obs_output_set_last_error(output, "WHIP returned a resource outside the authorized server.");
    return false;
}
resource_url = url;
'@)
$codecAnchor = 'video_description.addH264Codec(video_payload_type);'
if (!$outputCode.Contains($codecAnchor)) { throw 'Pinned WHIP H.264 patch anchor missing.' }
$outputCode = $outputCode.Replace('#include "whip-output.h"', "#include `"whip-output.h`"`n#include <obs-avc.h>`n#include <util/bmem.h>")
$outputCode = $outputCode.Replace($codecAnchor, @'
// Strife validates an actual locally encoded packet before issuing credentials.
// Hardware SPS may not exist again until the publishing encoder emits a packet.
const std::string profile = obs_data_get_string(settings, "strife_profile_level_id");
if (profile.size() != 6 || profile.substr(0, 2) != "42" ||
    !std::all_of(profile.begin(), profile.end(), [](unsigned char c) { return std::isxdigit(c); }))
    throw std::runtime_error("Missing validated H.264 encoder profile/level.");
video_description.addH264Codec(video_payload_type,
    std::string("profile-level-id=") + profile + ";packetization-mode=1;level-asymmetry-allowed=1");
'@)
[IO.File]::WriteAllText($outputFile, $outputCode)
$wasapi = Join-Path $build 'wasapi'
New-Item -ItemType Directory -Force $wasapi | Out-Null
foreach ($name in @('win-wasapi.cpp','wasapi-notify.cpp','wasapi-notify.hpp','enum-wasapi.cpp','enum-wasapi.hpp','plugin-main.cpp')) {
    $content = & git -C $ObsSource show "${revision}:plugins/win-wasapi/$name"
    if ($LASTEXITCODE) { throw "Cannot read pinned WASAPI source $name" }
    [IO.File]::WriteAllText((Join-Path $wasapi $name), ($content -join "`n") + "`n")
}
$audioFile = Join-Path $wasapi 'win-wasapi.cpp'
$audioCode = [IO.File]::ReadAllText($audioFile)
$windowLookup = 'hwnd = ms_find_window\(INCLUDE_MINIMIZED, priority, window_class\.c_str\(\), title\.c_str\(\),\s*executable\.c_str\(\)\);'
if ([regex]::Matches($audioCode, $windowLookup).Count -ne 1) { throw 'Pinned WASAPI identity patch anchor missing.' }
$audioCode = "#include `"wasapi-pin.hpp`"`n" + [regex]::Replace($audioCode, $windowLookup, 'hwnd = strifeAudioWindow(source);')
[IO.File]::WriteAllText($audioFile, $audioCode)
[IO.File]::AppendAllText((Join-Path $wasapi 'plugin-main.cpp'), "`nextern `"C`" __declspec(dllexport) int strife_audio_identity_version() { return 1; }`n")
[IO.File]::AppendAllText((Join-Path $whip 'obs-webrtc.cpp'), "`nextern `"C`" __declspec(dllexport) int strife_whip_quality_version() { return 3; }`n")
# The OBS SDK must first be configured using Helltube's obs:setup / upstream CMake preset.
& $cmake --build (Join-Path $ObsSource 'build_x64') --config RelWithDebInfo --target libobs libobs-d3d11 libobs-winrt obs-x264 obs-ffmpeg obs-nvenc obs-qsv11 win-capture win-wasapi --parallel 4
if ($LASTEXITCODE) { throw 'OBS dependencies failed to build.' }
& $cmake -S (Join-Path $root 'streaming') -B $build -G 'Visual Studio 18 2026' -A x64 "-DOBS_SOURCE=$ObsSource" "-DWHIP_SOURCE=$whip" "-DWASAPI_SOURCE=$wasapi"
if ($LASTEXITCODE) { throw 'Streaming configure failed.' }
& $cmake --build $build --config RelWithDebInfo --parallel 4
if ($LASTEXITCODE) { throw 'Streaming build failed.' }
$runtime = Join-Path $ObsSource 'build_x64/rundir/RelWithDebInfo'
$destination = [IO.Path]::GetFullPath((Join-Path $root 'artifacts/streaming'))
# Fixed staging directory only; never remove or modify the OBS checkout or voice payload.
if ($destination -ne [IO.Path]::GetFullPath((Join-Path $root 'artifacts/streaming'))) { throw 'Invalid staging destination.' }
if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
New-Item -ItemType Directory -Force "$destination/bin/64bit", "$destination/obs-plugins/64bit", "$destination/data/obs-plugins" | Out-Null
Copy-Item -LiteralPath "$build/RelWithDebInfo/strife-stream.exe" -Destination "$destination/bin/64bit"
Copy-Item -LiteralPath "$build/RelWithDebInfo/obs-webrtc.dll" -Destination "$destination/obs-plugins/64bit"
Copy-Item -LiteralPath "$build/RelWithDebInfo/win-wasapi.dll" -Destination "$destination/obs-plugins/64bit"
$plugins = @('obs-webrtc','obs-x264','obs-ffmpeg','obs-nvenc','obs-qsv11','win-capture','win-wasapi')
foreach ($plugin in $plugins) {
    if ($plugin -notin @('obs-webrtc','win-wasapi')) { Copy-Item -LiteralPath "$runtime/obs-plugins/64bit/$plugin.dll" -Destination "$destination/obs-plugins/64bit" }
    Copy-Item -LiteralPath "$runtime/data/obs-plugins/$plugin" -Destination "$destination/data/obs-plugins" -Recurse
}
Copy-Item -LiteralPath "$runtime/data/libobs" -Destination "$destination/data" -Recurse
# libobs-winrt is dynamically loaded. Capture helper EXEs/DLLs are retained in plugin data.
foreach ($name in @('libobs-d3d11.dll','libobs-winrt.dll')) { Copy-Item -LiteralPath "$runtime/bin/64bit/$name" -Destination "$destination/bin/64bit" }
foreach ($name in @('obs-amf-test.exe','obs-nvenc-test.exe','obs-qsv-test.exe')) {
    Copy-Item -LiteralPath "$runtime/bin/64bit/$name" -Destination "$destination/bin/64bit"
}
$pending = [Collections.Generic.Queue[string]]::new()
Get-ChildItem -LiteralPath $destination -Recurse -File | Where-Object Extension -in @('.exe','.dll') | ForEach-Object { $pending.Enqueue($_.FullName) }
$seen = @{}
while ($pending.Count) {
    $binary = $pending.Dequeue()
    if ($seen[$binary]) { continue }; $seen[$binary] = $true
    foreach ($line in (& $dumpbin /dependents $binary)) {
        if ($line -match '^\s+([\w.-]+\.dll)\s*$') {
            $name = $Matches[1]; $library = Join-Path "$runtime/bin/64bit" $name
            if ((Test-Path -LiteralPath $library) -and !(Test-Path -LiteralPath "$destination/bin/64bit/$name")) {
                Copy-Item -LiteralPath $library -Destination "$destination/bin/64bit"
                $pending.Enqueue((Join-Path "$destination/bin/64bit" $name))
            }
        }
    }
}
Get-ChildItem -LiteralPath $destination -Recurse -File | Where-Object Extension -in @('.pdb','.lib','.exp') | Remove-Item -Force
Copy-Item -LiteralPath (Join-Path $ObsSource 'COPYING') -Destination "$destination/OBS-LICENSE"
Copy-Item -LiteralPath (Join-Path $root 'streaming') -Destination "$destination/source" -Recurse
Copy-Item -LiteralPath $PSCommandPath -Destination "$destination/source/build-streaming.ps1"
@{ revision = $revision; runtime = 'win-x64'; prototype = $true; builtAt = [DateTime]::UtcNow.ToString('o');
    files = @(Get-ChildItem -LiteralPath $destination -Recurse -File | ForEach-Object { @{path=[IO.Path]::GetRelativePath($destination,$_.FullName); sha256=(Get-FileHash -LiteralPath $_.FullName).Hash} })
} | ConvertTo-Json -Depth 4 | Set-Content "$destination/build-info.json"
Write-Host 'Built development streaming payload. Release distribution still requires dependency/source licensing and platform packaging validation.'

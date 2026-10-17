param(
    [Parameter(Mandatory)][string]$PublishDirectory,
    [string]$InstalledDirectory,
    [string]$Version,
    [string]$InnoSetupCompiler,
    [string]$PrerequisiteDirectory,
    [switch]$PortableOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-common.ps1')
if (!$IsWindows) { throw 'The Windows installer must be built on Windows.' }
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'windows-dotnet.ps1')
$Version = Get-StrifeVersion $Version
$PublishDirectory = [IO.Path]::GetFullPath($PublishDirectory)
if (!(Test-Path (Join-Path $PublishDirectory 'Strife.exe'))) { throw 'Publish Strife before packaging it.' }
Assert-StrifePortableRuntime $PublishDirectory
$release = Join-Path $root 'artifacts/release'
New-Item -ItemType Directory -Force $release | Out-Null
if ($PortableOnly) {
    Compress-Archive -Path (Join-Path $PublishDirectory '*') -DestinationPath (Join-Path $release "Strife-$Version-win-x64.zip") -Force
    Write-Host 'Created portable archive only; no installer was built.'
    return
}
if (!$InstalledDirectory) { throw 'InstalledDirectory is required for framework-dependent Setup and OTA packaging.' }
$InstalledDirectory = [IO.Path]::GetFullPath($InstalledDirectory)
if ($InstalledDirectory -eq $PublishDirectory -or !(Test-Path (Join-Path $InstalledDirectory 'Strife.exe'))) {
    throw 'Setup requires a separate published installed payload.'
}
$frameworks = @(Get-StrifeDotNetFrameworks $InstalledDirectory)
if (!$InnoSetupCompiler) {
    $compiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    $candidates = @(
        $(if ($compiler) { $compiler.Source }),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6/ISCC.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs/Inno Setup 6/ISCC.exe'),
        (Join-Path $root 'artifacts/tools/InnoSetup/ISCC.exe')
    )
    $InnoSetupCompiler = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (!$InnoSetupCompiler -or !(Test-Path $InnoSetupCompiler)) { throw 'Install Inno Setup 6 (6.3 or newer), or pass -InnoSetupCompiler with the path to ISCC.exe.' }
$prerequisites = if ($PrerequisiteDirectory) { [IO.Path]::GetFullPath($PrerequisiteDirectory) } else { Join-Path $root 'artifacts/prerequisites' }
New-Item -ItemType Directory -Force $prerequisites | Out-Null
$downloads = @{
    'MicrosoftEdgeWebView2RuntimeInstallerX64.exe' = 'https://go.microsoft.com/fwlink/?linkid=2124701'
    'VC_redist.x64.exe' = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
}
$dotNetFiles = @{}
foreach ($framework in $frameworks) {
    $required = [version]$framework.version
    $metadata = Invoke-RestMethod "https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/$($required.Major).$($required.Minor)/releases.json"
    $file = Get-StrifeDotNetDownload $framework $metadata
    $name = if ($framework.name -eq 'Microsoft.NETCore.App') { 'dotnet-runtime.exe' } else { 'aspnetcore-runtime.exe' }
    $downloads[$name] = $file.url
    $dotNetFiles[$name] = $file
}
$downloadMetadata = @{}
foreach ($name in $downloads.Keys) {
    $path = Join-Path $prerequisites $name
    # Resolve the moving Microsoft link while downloading: the final CDN URL and
    # hash must describe the same signed bytes, never an older cached installer.
    $response = Invoke-WebRequest $downloads[$name] -OutFile $path -PassThru
    $url = $response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
    if (!$url -or !$url.StartsWith('https://') -or $url -match '[''"\r\n]') {
        throw "Prerequisite $name did not resolve to a safe HTTPS CDN URL."
    }
    $signature = Get-AuthenticodeSignature -FilePath $path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') {
        throw "Prerequisite $name does not have a valid Microsoft Authenticode signature."
    }
    if ($dotNetFiles.ContainsKey($name) -and (Get-FileHash $path -Algorithm SHA512).Hash -ne $dotNetFiles[$name].hash) {
        throw "Prerequisite $name does not match Microsoft's release metadata."
    }
    $downloadMetadata[$name] = @{ url = $url; sha256 = (Get-FileHash $path -Algorithm SHA256).Hash }
}
$redistVersion = (Get-Item (Join-Path $prerequisites 'VC_redist.x64.exe')).VersionInfo.FileVersion
$redistVersion = [regex]::Match($redistVersion, '\d+\.\d+\.\d+\.\d+').Value
if (!$redistVersion) { throw 'Cannot determine the bundled Visual C++ runtime version.' }
$channel = if ($Version.Contains('-')) { 'preview' } else { 'stable' }
$velopack = Join-Path $root 'artifacts/velopack'
Reset-StrifeStagingDirectory $velopack
& dotnet tool restore
if ($LASTEXITCODE) { throw 'Cannot restore pinned Velopack packaging tools.' }
& dotnet vpk pack --packId Strife --packVersion $Version --packDir $InstalledDirectory --mainExe Strife.exe --packTitle Strife --packAuthors Strife --channel $channel --runtime win-x64 --delta None --shortcuts StartMenuRoot --icon (Join-Path $root 'src/Strife.Desktop/wwwroot/assets/strife.ico') --outputDir $velopack
if ($LASTEXITCODE) { throw 'Velopack packaging failed.' }
$payloadSetup = @(Get-ChildItem $velopack -Filter '*Setup.exe')
$package = @(Get-ChildItem $velopack -Filter '*-full.nupkg')
if ($payloadSetup.Count -ne 1 -or $package.Count -ne 1) { throw 'Expected one Velopack installer and full update package.' }
Copy-Item $package[0].FullName (Join-Path $release "Strife-$Version-full.nupkg")
@{ minimumVcRuntime = $redistVersion; dotNetFrameworks = $frameworks } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $release 'update-requirements.json')
$vc = $downloadMetadata['VC_redist.x64.exe']
$webview = $downloadMetadata['MicrosoftEdgeWebView2RuntimeInstallerX64.exe']
$runtimeDefines = @()
foreach ($framework in $frameworks) {
    $prefix = if ($framework.name -eq 'Microsoft.NETCore.App') { 'DotNet' } else { 'AspNet' }
    $name = if ($prefix -eq 'DotNet') { 'dotnet-runtime.exe' } else { 'aspnetcore-runtime.exe' }
    $download = $downloadMetadata[$name]
    $runtimeDefines += "/D${prefix}Version=$($framework.version)", "/D${prefix}Url=$($download.url)", "/D${prefix}SHA256=$($download.sha256)"
}
& $InnoSetupCompiler "/DAppVersion=$Version" "/DAppNumericVersion=$($Version.Split('-')[0]).0" "/DVelopackSetup=$($payloadSetup[0].FullName)" "/DReleaseDir=$release" "/DVCRedistVersion=$redistVersion" "/DVCRedistUrl=$($vc.url)" "/DVCRedistSHA256=$($vc.sha256)" "/DWebViewUrl=$($webview.url)" "/DWebViewSHA256=$($webview.sha256)" @runtimeDefines (Join-Path $root 'packaging/windows/Strife.iss')
if ($LASTEXITCODE) { throw 'Windows installer compilation failed.' }
$installer = Join-Path $release "Strife-$Version-win-x64-Setup.exe"
if (!(Test-Path $installer)) { throw 'Inno Setup did not produce the expected installer.' }
Compress-Archive -Path (Join-Path $PublishDirectory '*') -DestinationPath (Join-Path $release "Strife-$Version-win-x64.zip") -Force
Write-Host "Installer: $installer"

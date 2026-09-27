param(
    [Parameter(Mandatory)][string]$PublishDirectory,
    [string]$Version,
    [string]$InnoSetupCompiler,
    [string]$PrerequisiteDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-common.ps1')
if (!$IsWindows) { throw 'The Windows installer must be built on Windows.' }
$root = Split-Path $PSScriptRoot -Parent
$Version = Get-StrifeVersion $Version
$PublishDirectory = [IO.Path]::GetFullPath($PublishDirectory)
if (!(Test-Path (Join-Path $PublishDirectory 'Strife.exe'))) { throw 'Publish Strife before packaging it.' }
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
foreach ($name in $downloads.Keys) {
    $path = Join-Path $prerequisites $name
    if (!(Test-Path $path)) { Invoke-WebRequest $downloads[$name] -OutFile $path }
    $signature = Get-AuthenticodeSignature -FilePath $path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') {
        throw "Prerequisite $name does not have a valid Microsoft Authenticode signature."
    }
}
$redistVersion = (Get-Item (Join-Path $prerequisites 'VC_redist.x64.exe')).VersionInfo.FileVersion
$redistVersion = [regex]::Match($redistVersion, '\d+\.\d+\.\d+\.\d+').Value
if (!$redistVersion) { throw 'Cannot determine the bundled Visual C++ runtime version.' }
$release = Join-Path $root 'artifacts/release'
New-Item -ItemType Directory -Force $release | Out-Null
& $InnoSetupCompiler "/DAppVersion=$Version" "/DAppNumericVersion=$($Version.Split('-')[0]).0" "/DPublishDir=$PublishDirectory" "/DPrerequisiteDir=$prerequisites" "/DReleaseDir=$release" "/DVCRedistVersion=$redistVersion" (Join-Path $root 'packaging/windows/Strife.iss')
if ($LASTEXITCODE) { throw 'Windows installer compilation failed.' }
$installer = Join-Path $release "Strife-$Version-win-x64-Setup.exe"
if (!(Test-Path $installer)) { throw 'Inno Setup did not produce the expected installer.' }
Compress-Archive -Path (Join-Path $PublishDirectory '*') -DestinationPath (Join-Path $release "Strife-$Version-win-x64.zip") -Force
Write-Host "Installer: $installer"

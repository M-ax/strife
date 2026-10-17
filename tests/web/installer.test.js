import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const installer = readFileSync(new URL('../../packaging/windows/Strife.iss', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const packaging = readFileSync(new URL('../../scripts/package-windows.ps1', import.meta.url), 'utf8');
const section = (name, next) => installer.slice(installer.indexOf(name), installer.indexOf(next));

// Source-contract checks complement, rather than replace, the Windows installer
// integration test and standard-user/UAC testing on a disposable machine.
test('Windows Setup defaults to a per-user installation with no privilege override', () => {
  assert.match(installer, /^DefaultDirName=\{localappdata\}\\Programs\\Strife$/m);
  assert.match(installer, /^PrivilegesRequired=lowest$/m);
  assert.doesNotMatch(installer, /^PrivilegesRequiredOverridesAllowed=/m);
  assert.match(installer, /^Uninstallable=no$/m);
  assert.match(installer, /--silent --installto/);
  assert.doesNotMatch(installer, /\[InstallDelete\]/);
});

test('Setup blocks legacy machine installations and checks current-user upgrades', () => {
  const initialize = section('function InitializeSetup', 'function HasWebView2');
  assert.match(initialize, /RegKeyExists\(HKLM64, UninstallKey\) or RegKeyExists\(HKLM32, UninstallKey\)/);
  assert.match(initialize, /Result := False;\s+Exit;/);
  assert.match(initialize, /RegQueryStringValue\(HKCU, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Strife', 'DisplayVersion'/);
});

test('WebView2 supports both scopes without requesting elevation', () => {
  const detection = section('function HasWebView2', 'function HasVCRuntime');
  assert.match(detection, /RegQueryStringValue\(HKLM32, WebViewKey/);
  assert.match(detection, /RegQueryStringValue\(HKCU, WebViewKey/);
  assert.match(installer, /InstallPrerequisite\('VC_redist.x64.exe', '\/install \/quiet \/norestart',\s+'\{#VCRedistUrl\}', '\{#VCRedistSHA256\}', True\)/);
  assert.match(installer, /InstallPrerequisite\('MicrosoftEdgeWebView2RuntimeInstallerX64.exe', '\/silent \/install',\s+'\{#WebViewUrl\}', '\{#WebViewSHA256\}', False\)/);
});

test('silent prerequisite installation refuses elevation before download or execution', () => {
  const prerequisite = section('function InstallPrerequisite', 'function PrepareToInstall');
  assert.match(prerequisite, /if RequiresElevation and WizardSilent then\s+begin[\s\S]*?Exit;\s+end;\s+DownloadPage.Clear/);
  assert.match(prerequisite, /if RequiresElevation then\s+Started := ShellExec\('runas'/);
  assert.match(installer, /^RestartApplications=no$/m);
  assert.match(installer, /Flags: nowait postinstall skipifsilent runasoriginaluser/);
});

test('online Setup embeds only the app and downloads prerequisites behind detection gates', () => {
  const files = section('[Files]', '[Run]');
  assert.doesNotMatch(files, /VC_redist|WebView2|PrerequisiteDir/);
  assert.match(files, /\{#VelopackSetup\}/);
  assert.match(installer, /if not HasVCRuntime then\s+begin[\s\S]*?InstallPrerequisite\('VC_redist/);
  assert.match(installer, /if not HasWebView2 then\s+begin[\s\S]*?InstallPrerequisite\('MicrosoftEdgeWebView2/);
});

test('download verification fails closed before executing either prerequisite', () => {
  const prerequisite = section('function InstallPrerequisite', 'function PrepareToInstall');
  assert.match(prerequisite, /DownloadPage.Add\(Url, FileName, SHA256\)/);
  assert.match(prerequisite, /DownloadPage.Download;\s+except[\s\S]*?Result :=[\s\S]*?Exit;\s+end;\s+finally\s+DownloadPage.Hide;\s+end;\s+if RequiresElevation then/);
  assert.doesNotMatch(prerequisite, /ExtractTemporaryFile/);
});

test('packaging binds CDN URLs and hashes to freshly downloaded Microsoft-signed bytes', () => {
  assert.match(packaging, /Invoke-WebRequest \$downloads\[\$name\] -OutFile \$path -PassThru/);
  assert.match(packaging, /\$response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri/);
  assert.match(packaging, /!\$url.StartsWith\('https:\/\/'\)/);
  assert.match(packaging, /Get-AuthenticodeSignature -FilePath \$path/);
  assert.match(packaging, /\$signature.Status -ne 'Valid'/);
  assert.match(packaging, /O=Microsoft Corporation/);
  assert.match(packaging, /url = \$url; sha256 = \(Get-FileHash \$path -Algorithm SHA256\).Hash/);
  for (const define of ['VCRedistUrl', 'VCRedistSHA256', 'WebViewUrl', 'WebViewSHA256']) {
    assert.ok(packaging.includes(`/D${define}=`));
    assert.ok(installer.includes(`{#${define}}`));
  }
});

test('installed and portable Windows payloads use separate publish outputs', () => {
  const publish = readFileSync(new URL('../../scripts/publish.ps1', import.meta.url), 'utf8');
  assert.match(publish, /--self-contained true[\s\S]*?-o \$output/);
  assert.match(publish, /--self-contained false[\s\S]*?-p:RollForward=LatestPatch -p:AppHostDotNetSearch=Global[\s\S]*?-o \$installed/);
  assert.match(packaging, /--packDir \$InstalledDirectory/);
  assert.match(packaging, /Compress-Archive -Path \(Join-Path \$PublishDirectory '\*'\)/);
  assert.match(packaging, /Assert-StrifePortableRuntime \$PublishDirectory/);
  assert.match(packaging, /Get-StrifeDotNetFrameworks \$InstalledDirectory/);
  assert.match(packaging, /dotNetFrameworks = \$frameworks/);
});

test('Setup checks both global x64 shared frameworks before installing the app', () => {
  const detection = section('function HasDotNetFramework', 'function InstallPrerequisite');
  assert.match(detection, /RegGetValueNames\(HKLM32/);
  assert.match(detection, /InstalledVersions\\x64\\sharedfx\\/);
  assert.match(detection, /InstalledVersion shr 32.*RequiredVersion shr 32/);
  for (const [framework, prefix, file] of [
    ['Microsoft.NETCore.App', 'DotNet', 'dotnet-runtime.exe'],
    ['Microsoft.AspNetCore.App', 'AspNet', 'aspnetcore-runtime.exe'],
  ]) {
    assert.ok(installer.includes(`if not HasDotNetFramework('${framework}', '{#${prefix}Version}') then`));
    assert.ok(installer.includes(`InstallPrerequisite('${file}', '/install /quiet /norestart',\n      '{#${prefix}Url}', '{#${prefix}SHA256}', True)`));
    assert.ok(installer.lastIndexOf(`HasDotNetFramework('${framework}'`) < installer.indexOf('if not PackageInstalled then'));
  }
});

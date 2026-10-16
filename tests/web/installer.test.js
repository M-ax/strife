import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const installer = readFileSync(new URL('../../packaging/windows/Strife.iss', import.meta.url), 'utf8');
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

test('WebView2 supports both scopes and only VC++ can request elevation', () => {
  const detection = section('function HasWebView2', 'function HasVCRuntime');
  assert.match(detection, /RegQueryStringValue\(HKLM32, WebViewKey/);
  assert.match(detection, /RegQueryStringValue\(HKCU, WebViewKey/);
  assert.match(installer, /InstallPrerequisite\('VC_redist.x64.exe', '\/install \/quiet \/norestart', True\)/);
  assert.match(installer, /InstallPrerequisite\('MicrosoftEdgeWebView2RuntimeInstallerX64.exe', '\/silent \/install', False\)/);
});

test('silent prerequisite installation refuses elevation before extraction or execution', () => {
  const prerequisite = section('function InstallPrerequisite', 'function PrepareToInstall');
  assert.match(prerequisite, /if RequiresElevation and WizardSilent then\s+begin[\s\S]*?Exit;\s+end;\s+ExtractTemporaryFile/);
  assert.match(prerequisite, /if RequiresElevation then\s+Started := ShellExec\('runas'/);
  assert.match(installer, /^RestartApplications=no$/m);
  assert.match(installer, /Flags: nowait postinstall skipifsilent runasoriginaluser/);
});

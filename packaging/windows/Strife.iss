#ifndef AppVersion
  #error Build this script using scripts/package-windows.ps1
#endif

[Setup]
AppId={{3AF3EC03-735A-4F65-9A4D-1C611D72D812}
AppName=Strife
AppVersion={#AppVersion}
AppPublisher=Strife
AppPublisherURL=https://github.com/M-ax/strife
AppSupportURL=https://github.com/M-ax/strife/issues
AppUpdatesURL=https://github.com/M-ax/strife/releases
DefaultDirName={localappdata}\Programs\Strife
DefaultGroupName=Strife
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.19041
WizardStyle=modern
SetupIconFile=..\..\src\Strife.Desktop\wwwroot\assets\strife.ico
UninstallDisplayIcon={app}\Strife.exe
UninstallDisplayName=Strife
OutputDir={#ReleaseDir}
OutputBaseFilename=Strife-{#AppVersion}-win-x64-Setup
VersionInfoVersion={#AppNumericVersion}
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
CloseApplicationsFilter=*.exe,*.dll
RestartApplications=no
SetupLogging=yes

[Tasks]
Name: desktopicon; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#PrerequisiteDir}\VC_redist.x64.exe"; Flags: dontcopy
Source: "{#PrerequisiteDir}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Flags: dontcopy
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Strife"; Filename: "{app}\Strife.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Strife"; Filename: "{app}\Strife.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[InstallDelete]
; Clear replaced runtime/payload files during upgrades. User profiles live
; outside {app} and are never included in install or uninstall deletion.
Type: files; Name: "{app}\*.dll"
Type: files; Name: "{app}\*.deps.json"
Type: files; Name: "{app}\*.runtimeconfig.json"
Type: filesandordirs; Name: "{app}\voice"
Type: filesandordirs; Name: "{app}\wwwroot"
Type: filesandordirs; Name: "{app}\docs"

[Run]
Filename: "{app}\Strife.exe"; Description: "Launch Strife"; Flags: nowait postinstall skipifsilent runasoriginaluser; Check: CanLaunch

[Code]
const
  WebViewKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  VCRuntimeKey = 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64';
  UninstallKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{3AF3EC03-735A-4F65-9A4D-1C611D72D812}_is1';
var
  PrerequisiteRestart: Boolean;

function InitializeSetup: Boolean;
var
  PreviousVersion: String;
  Suffix: Integer;
  PreviousPacked, CurrentPacked: Int64;
begin
  Result := True;
  { Do not leave two installations and competing shortcuts. Never uninstall an
    all-user application from an unattended per-user update. }
  if RegKeyExists(HKLM64, UninstallKey) or RegKeyExists(HKLM32, UninstallKey) then
  begin
    SuppressibleMsgBox('Strife is installed for all users. Close Strife and uninstall that installation in Windows Settings, then run this Setup again to install for your account. Your Strife profile will be preserved.', mbError, MB_OK, IDOK);
    Result := False;
    Exit;
  end;
  if RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', PreviousVersion) then
  begin
    Suffix := Pos('-', PreviousVersion);
    if Suffix > 0 then Delete(PreviousVersion, Suffix, Length(PreviousVersion));
    if StrToVersion(PreviousVersion, PreviousPacked) and StrToVersion('{#AppNumericVersion}', CurrentPacked) then
      if ComparePackedVersion(PreviousPacked, CurrentPacked) > 0 then
      begin
        SuppressibleMsgBox('A newer version of Strife is already installed. Uninstall it first to install this version.', mbError, MB_OK, IDOK);
        Result := False;
      end;
  end;
end;

function HasWebView2: Boolean;
var
  Version: String;
begin
  { Either the shared runtime or this user's runtime can serve a per-user app. }
  Result := RegQueryStringValue(HKLM32, WebViewKey, 'pv', Version) and
    (Version <> '') and (Version <> '0.0.0.0');
  if not Result then
    Result := RegQueryStringValue(HKCU, WebViewKey, 'pv', Version) and
      (Version <> '') and (Version <> '0.0.0.0');
end;

function HasVCRuntime: Boolean;
var
  Installed: Cardinal;
  Version: String;
  PackedVersion, RequiredVersion: Int64;
begin
  Result := False;
  if RegQueryDWordValue(HKLM64, VCRuntimeKey, 'Installed', Installed) and (Installed = 1) and
    RegQueryStringValue(HKLM64, VCRuntimeKey, 'Version', Version) then
  begin
    if (Length(Version) > 0) and (Version[1] = 'v') then Delete(Version, 1, 1);
    if StrToVersion(Version, PackedVersion) and StrToVersion('{#VCRedistVersion}', RequiredVersion) then
      Result := ComparePackedVersion(PackedVersion, RequiredVersion) >= 0;
  end;
end;

function InstallPrerequisite(const FileName, Arguments: String; RequiresElevation: Boolean): String;
var
  ExitCode: Integer;
  Started: Boolean;
begin
  Result := '';
  { A background update must never trigger UAC or launch prerequisite UI. }
  if RequiresElevation and WizardSilent then
  begin
    Result := 'The Microsoft Visual C++ Runtime needs installation or repair. Run Setup interactively to authorize this prerequisite.';
    Exit;
  end;
  ExtractTemporaryFile(FileName);
  if RequiresElevation then
    Started := ShellExec('runas', ExpandConstant('{tmp}\') + FileName, Arguments, '', SW_HIDE, ewWaitUntilTerminated, ExitCode)
  else
    Started := Exec(ExpandConstant('{tmp}\') + FileName, Arguments, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  if not Started then
    Result := 'Could not start ' + FileName + ': ' + SysErrorMessage(ExitCode)
  else if (ExitCode = 3010) or (ExitCode = 1641) then
    PrerequisiteRestart := True
  else if ExitCode <> 0 then
    Result := FileName + ' failed (exit code ' + IntToStr(ExitCode) + '). Install the prerequisite and run Setup again.';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not HasVCRuntime then
  begin
    WizardForm.StatusLabel.Caption := 'Installing Microsoft Visual C++ Runtime...';
    Result := InstallPrerequisite('VC_redist.x64.exe', '/install /quiet /norestart', True);
    if Result <> '' then Exit;
    if not HasVCRuntime then
    begin
      Result := 'The Microsoft Visual C++ Runtime could not be verified. Restart Windows and run Setup again.';
      NeedsRestart := PrerequisiteRestart;
      Exit;
    end;
  end;
  if not HasWebView2 then
  begin
    WizardForm.StatusLabel.Caption := 'Installing Microsoft Edge WebView2 Runtime...';
    Result := InstallPrerequisite('MicrosoftEdgeWebView2RuntimeInstallerX64.exe', '/silent /install', False);
    if Result <> '' then Exit;
    if not HasWebView2 then
      Result := 'Microsoft Edge WebView2 Runtime could not be verified. Install it and run Setup again.';
  end;
end;

function NeedRestart: Boolean;
begin
  Result := PrerequisiteRestart;
end;

function CanLaunch: Boolean;
begin
  Result := not PrerequisiteRestart;
end;

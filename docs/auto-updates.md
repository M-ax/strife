# Windows OTA updates

Status: implementation started; automatic updating is not enabled or published.
Windows installed builds come first. macOS, Linux and portable builds follow.

## User contract

- Quiet background checks and downloads; no modal reminders or forced restarts.
- One small **Update** button in the header. Explain that clicking installs and
  restarts, while normal application exit installs without reopening.
- Wait for download and verification before requesting shutdown on a button click.
  Do not drop a voice call just because an update was discovered.
- Normal exit installs only a fully staged and verified package. An unfinished
  download must not delay exit; resume next launch.
- Closing to the tray is not exit. Crashes, forced termination and OS shutdown
  are not dependable installation opportunities.
- Failures are available in Settings/logs, without repeated notifications.

## Installation foundation (implemented in source)

Setup uses Inno Setup's lowest privilege mode, a default directory of
`%LOCALAPPDATA%\Programs\Strife`, and current-user registration and shortcuts.
The AppId remains unchanged so subsequent per-user installers upgrade in place.
Profiles remain outside the installation directory.

An existing all-user uninstall registration blocks Setup with instructions to
close and uninstall the old version first. Setup never automatically removes a
machine-wide installation, affects other users, or silently leaves duplicate
installations. This one-time manual transition preserves the user's profile.
Users must run Setup as their intended account, without "Run as administrator".

WebView2 detection accepts machine-wide or current-user runtimes. Interactive
Setup can elevate the bundled VC++ prerequisite alone; silent Setup refuses
missing/outdated VC++ without UAC. This means an unattended update requiring a
newer VC++ runtime must defer to an explicit interactive repair, not loop.
The portable ZIP remains unchanged and does not opt into automatic updates.

## Next: authenticated update feed and staging

Implement in the managed host, not the native Mumble engine.

- Derive a signed feed from actual immutable release packages, with version,
  channel, source commit, OS/architecture constraints, minimum updater version,
  URL, length and SHA-256.
- Pin verification keys in the app. Define key rotation, metadata expiry and
  replay protection before enabling execution. Hashes alone do not authenticate
  metadata or an installer.
- Keep stable and preview channels distinct; compare full semantic versions.
  Current Setup's numeric downgrade check does not order preview suffixes.
- Download over HTTPS to private user staging, outside both profiles and the
  installation. Bound metadata/package sizes, validate destinations and
  redirects, resume safely, and reject incompatible or untrusted packages.
- Persist a small state machine: checking, downloading, verifying, ready,
  installing, success/failure. Revalidate staged state after process restart.
- Upload and verify all release artifacts before publishing feed metadata.
  Reuse the existing R2 release workflow and exact source revision.

## Next: installer handoff and UI

Use the same verified payload for both Update and exit. A separate managed
helper must coordinate all processes using the installation, wait for clean
host/voice/streaming shutdown, and execute Setup with silent/no-restart flags.
Do not let Setup terminate another active instance or install over loaded files.
Only the explicit Update action relaunches after success.

The helper must validate the installation scope and path (including writable
custom directories), exclude portable/unrecognized/system-managed installs,
prevent concurrent installation/relaunch races, and recheck package authenticity
immediately before execution. Do not accept arbitrary executable paths from
web content. Restrict commands to the authenticated top-level desktop bridge.

Define recovery before enabling unattended installs: retain a recoverable old
payload, journal the operation, handle interruption/disk exhaustion/locked files,
and record successful startup before removing recovery data. Inno's existing
upgrade cleanup is not proof of transactional rollback. Profile migrations must
remain compatible with any supported rollback. Never retry indefinitely.

## Release gates

- Compile the real installer and test install, upgrade and removal on Windows.
- Run as a standard user with and without each prerequisite, including UAC
  denial and restart-required results. Silent runs must never show UAC.
- Transition from the previously published machine-wide installer; preserve
  profiles, certificates and settings. Verify old shortcuts are removed.
- Test corrupted packages/metadata, replay/downgrade, wrong architecture,
  interrupted download/install, locked files, disk exhaustion, multiple
  instances, ordinary exit, OS shutdown, and startup recovery.
- Exercise the real packaged app and Update button, not just a mocked helper.
- Preserve the compiled native voice cache; run normal package/startup checks.
- Update the neighboring website only with accurate published-build claims.
  No manifest version/sourceRef changes until actual packages exist. Publication
  requires R2 upload, website deployment and production verification.

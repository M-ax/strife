# Windows OTA updates

Implemented for Windows x64 installed builds using Velopack 1.2.161. macOS,
Linux and portable builds retain manual updates. Older installs require one
manual installation of the updater-capable release.

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
- Failures are available in the application menu/logs, without repeated notifications.

## Installation

Setup uses Inno Setup's lowest privilege mode, a default directory of
`%LOCALAPPDATA%\Programs\Strife`, and current-user registration and shortcuts.
The wrapper installs the Velopack package with ID `Strife`. Velopack owns
`current/`, `packages/`, `Update.exe`, the Start Menu shortcut and current-user
uninstall registration. The wrapper is not a second registered uninstaller.
Profiles remain outside the installation directory.

An existing all-user uninstall registration blocks Setup with instructions to
close and uninstall the old version first. Setup never automatically removes a
machine-wide installation, affects other users, or silently leaves duplicate
installations. This one-time manual transition preserves the user's profile.
Users must run Setup as their intended account, without "Run as administrator".

WebView2 detection accepts machine-wide or current-user runtimes. Interactive
Setup can elevate the VC++ prerequisite alone; silent Setup refuses
missing/outdated VC++ without UAC. This means an unattended update requiring a
newer VC++ runtime must defer to an explicit interactive repair, not loop.
The portable ZIP remains unchanged and does not opt into automatic updates.

### Upcoming online Setup (not yet published)

Previously published installers bundle the Microsoft prerequisites. The upcoming
installed Windows app and OTA package will become framework-dependent. Setup
will bundle the app and native voice engine, but download Microsoft's .NET
Runtime and ASP.NET Core Runtime for Windows x64 when absent or incompatible.
The app uses `Microsoft.NET.Sdk.Web`, requiring both `Microsoft.NETCore.App` and
`Microsoft.AspNetCore.App`. Requirements will come from the generated
runtimeconfig: each framework must match the required major/minor version and
have a patch version greater than or equal to the required patch.
Setup will also fetch Microsoft's WebView2 x64 standalone installer and Visual
C++ x64 Redistributable only when missing or outdated.
Internet access will be required for those downloads; no separate offline
installer will be retained.

Packaging will download the prerequisite installers from Microsoft and validate their
Microsoft Authenticode signatures, then pin their resolved, versioned HTTPS
URLs and SHA-256 hashes into Setup. Setup will verify each downloaded file's
hash before execution. `-PrerequisiteDirectory` will be download staging
refreshed on every packaging run, not an offline cache.

.NET runtimes install machine-wide and may request UAC approval, as can VC++.
Run Setup normally as the intended user; the app remains per-user. Silent Setup
will refuse missing/incompatible .NET runtimes without requesting elevation,
just as it refuses missing/outdated VC++. Unattended updates must defer to an
explicit interactive repair when prerequisites are incompatible.

The Windows portable ZIP will remain fully self-contained with .NET and voice
exactly as before, with its existing external WebView2/VC++ requirements unchanged.
Linux and macOS will remain self-contained. These packages remain manual-update only.

Upcoming signed **schema 2** feeds will carry `dotNetFrameworks` derived from the
generated runtimeconfig so compatible clients can check both required frameworks.
Old schema 1 clients reject schema 2; **one manual upgrade using the new Setup
is required** to transition safely, even for existing updater-capable installs.
Do not auto-ship a thin, framework-dependent payload to old clients in a schema 1
feed. This transition is not yet released; the schema 1 description below
documents the existing contract.

For manual installation or repair, use Microsoft's official
[WebView2 x64 standalone installer](https://go.microsoft.com/fwlink/?linkid=2124701)
and [Visual C++ x64 Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe).
For .NET, use the official [.NET 10 download page](https://dotnet.microsoft.com/en-us/download/dotnet/10.0):
select **.NET Runtime** and **ASP.NET Core Runtime**, both **Windows x64**.
Neither the SDK nor the Hosting Bundle is necessary.
The installed VC++ runtime must meet the minimum version required by the
particular Strife build; any installed v14 version is not automatically enough.
These convenience links are not the versioned URLs pinned into Setup.

## Authentication and background policy

The managed host fetches `https://strife.zip/updates/windows-preview.json` or
`windows-stable.json`, starting after 20 seconds and then every six hours.
Failures back off from five minutes to six hours. Stable installs reject
prereleases; preview installs stay on the preview feed. Full semantic version
comparison rejects downgrades. Manual Setup retains its numeric downgrade check.

Metadata is a JSON envelope containing base64 payload bytes and an RSA-PSS/SHA-256
signature (32-byte salt). The client embeds `update-key.pem`; the private key is
the GitHub Actions secret `STRIFE_UPDATE_SIGNING_KEY`, never a repository file.
Schema 1 binds channel, version, immutable filename, length, SHA-256, exact source
commit, issue/expiry times and minimum Windows/VC++ versions. Unknown schemas
fail closed. Metadata is limited to 32 KiB and packages to 1 GiB. Issued times
cannot go backward relative to previously verified metadata, even after expiry.
Feeds expire after 30 days (client maximum: 45 days).

Only the fixed HTTPS website origin serves packages. Redirects and cookies are
disabled. Partial downloads are cached under `%LOCALAPPDATA%\Strife\updates`,
with signed lengths and SHA-256 checked before use; Velopack stages full packages
under the installation. Every restored ready package is reverified. Startup
auto-apply in Velopack is explicitly disabled: cached bytes alone never authorize
installation. The authenticated desktop bridge accepts only the Update action,
not URLs, executable paths, version overrides or trust keys.

## Exit, restart and failure handling

Normal exit freezes the ready package and cancels unfinished network work.
After the UI and owned streaming/voice processes shut down, the host rechecks
the package hash and launches Velopack's silent wait-for-exit operation. Only an
explicit button click requests relaunch. A per-user installation session lock
prevents another installed profile from staying active during replacement; a
short-lived applying marker prevents an old-version launch racing the helper.
Windows shutdown detection skips the handoff. No crash handler installs updates.

Velopack supplies replacement/rollback mechanics for installation failures,
rather than Inno's previous delete-and-copy upgrade. Strife records each attempt
before handoff and does not automatically retry the same failed package on every
exit. A failed attempt exposes repair instructions in the menu. This is not
automatic rollback of a successfully installed app that later crashes; use a
new fixed version or a manual repair. Profiles are never part of replacement.
`last-error.txt` in the update cache and Velopack's logs aid diagnostics.

## Release operation and key lifecycle

1. Build all advertised platforms from one exact commit. The Windows job runs
   installation and real exit/restart fixture tests, then `scripts/sign-update.mjs`
   signs the actual full package using the Actions secret.
2. In `strife-web`, import the five public downloads normally, then run
   `node scripts/import-update.mjs ARTIFACT_DIRECTORY`. This checks the signature,
   hash, version and source commit before adding the update package/feed.
3. Run `npm run release:docs`, build/tests, and `npm run release:upload`.
   Packages must exist in R2 before `npm run deploy` advertises their feed.
4. Run `npm run release:verify` against production. It verifies all public
   downloads plus signed feed bytes and the full OTA package, headers and ranges.

Renew signed metadata before its 30-day expiry even if no new build ships. Run
the **Renew update metadata** workflow with the original successful Publish run
ID; it authenticates the old envelope/package and signs only new issue/expiry
times. Download its artifact and re-import/deploy the feed from `strife-web`.
Keep the original signed artifact available for renewal (before Actions artifact
retention expires, archive it). Never overwrite an existing package with
different bytes. Expired metadata disables updates, not normal use of Strife.

For planned key rotation, first ship a release trusted by the existing key that
adds the next public key, then switch signing only after the transition cohort
can verify it. Do not replace the only trusted key in a feed or rotate the
Actions secret alone. Loss/compromise of the sole key requires a trusted manual
installer recovery for clients that did not receive a transition release.
Feed signatures do not make the initial Windows installer Authenticode-signed;
the existing Windows publisher warning still applies.

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

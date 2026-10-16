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
Setup can elevate the bundled VC++ prerequisite alone; silent Setup refuses
missing/outdated VC++ without UAC. This means an unattended update requiring a
newer VC++ runtime must defer to an explicit interactive repair, not loop.
The portable ZIP remains unchanged and does not opt into automatic updates.

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

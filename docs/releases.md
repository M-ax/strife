# Building and publishing Strife

The **Publish** GitHub Actions workflow runs when a GitHub release is published, including prereleases. Tag the desired commit with `vMAJOR.MINOR.PATCH` (optionally `-rc.1`, etc.) and publish its release. The tag supplies the app, installer and asset versions; local builds default to `package.json`. Tags with build metadata or nonnumeric version components are rejected before native compilation. The workflow needs the repository's normal Actions token with permission to write release assets; no personal token is needed.

All four native builds must succeed before any assets are attached. Rerunning the workflow replaces assets with the same names. Manual **Run workflow** builds the selected branch and version, uploads packages and checksums as workflow artifacts, and does not create or modify a GitHub release.

| Target | Release asset | Runtime requirements |
| --- | --- | --- |
| Windows x64 | `Strife-VERSION-win-x64-Setup.exe` and portable `.zip` | Windows 10 build 19041+ or Windows 11; setup includes WebView2 and VC++ prerequisites |
| Linux x64 | `Strife-VERSION-linux-x64.tar.gz` | Ubuntu 24.04 x64 baseline, GTK 3, WebKitGTK 4.1, audio and X11 libraries |
| macOS Intel | `Strife-VERSION-osx-x64.zip` containing `Strife.app` | macOS 14+ |
| macOS Apple Silicon | `Strife-VERSION-osx-arm64.zip` containing `Strife.app` | macOS 14+ |

The ZIP/tar archives include .NET, the voice engine, UI assets and dependency notices. The Windows portable ZIP needs WebView2 and the VC++ runtime already installed; the setup executable embeds both standalone redistributables for offline installation. Their Microsoft Authenticode signatures are verified during packaging. The installer checks runtime presence/version, reports prerequisite failures, handles restart requests, provides shortcuts and Apps & Features registration, removes obsolete runtime files on upgrade, rejects numeric version downgrades, and preserves profiles on uninstall.

## Preview 0.1.0-preview.3

- Channel names no longer have an added decorative prefix. Empty sibling rooms are hidden under a gray **x channels** control; expanding it reveals those rooms at the same indentation. Occupied descendant paths stay visible, and search reveals matching rooms and users through collapsed groups.
- Incoming embedded chat images appear inline, fit the chat pane, and retain their link targets. Unsupported, unreadable, or oversized images display a placeholder. This includes the chat image fix that was previously available only in source builds.

The platform requirements, prerequisite bundles, and signing status above are unchanged.

## Local builds

Use PowerShell 7 on the target OS and architecture. Cross-publishing the managed shell alone does not produce a runnable voice package and is rejected by the script. Install the SDK specified by `global.json`, CMake, Git, Python 3, and a C++ compiler. Windows uses Visual Studio 2026 C++ tools and 7-Zip; Unix builds use Ninja. Windows packaging requires Inno Setup 6.3+, with CI pinned to 6.7.3.

```powershell
# Choose win-x64, linux-x64, osx-x64 or osx-arm64 for this machine.
./scripts/prepare-release.ps1 -Runtime win-x64
./scripts/build-voice.ps1
./scripts/publish.ps1 -Version 0.1.0
./scripts/test-package.ps1 -Runtime win-x64
```

`prepare-release.ps1` checks out Mumble and its submodules at the revision in `packaging/native-dependencies.json`, and fetches the corresponding upstream vcpkg environment after verifying its pinned SHA-256. The toolchain cache is keyed by that manifest. To update a dependency, update the pinned revision/archive/hash together and rebuild from clean native build/source/toolchain directories. The existing local Mumble/vcpkg overrides are also supported by `build-voice.ps1` (`-MumbleSource`, `-VcpkgRoot`, `-Generator`, `-Parallel`); `STRIFE_MUMBLE_SOURCE` and `STRIFE_VCPKG_ROOT` supply defaults.

On macOS, install Ninja and xz with Homebrew (`brew install ninja xz`) and install the Xcode command-line tools. On Ubuntu 24.04 the workflow installs the native build dependencies with:

```sh
sudo apt-get install ninja-build pkg-config libasound2-dev libsm-dev \
  '^libxcb.*-dev' libx11-xcb-dev libglu1-mesa-dev libxrender-dev libxi-dev \
  libxkbcommon-dev libxkbcommon-x11-dev libegl1-mesa-dev \
  libgtk-3-0 libwebkit2gtk-4.1-0 libnotify4 xvfb xauth
```

Linux users need the runtime libraries, not the compiler/development packages. For Ubuntu 24.04:

```sh
sudo apt-get install libgtk-3-0 libwebkit2gtk-4.1-0 libnotify4 libasound2t64 \
  libsm6 libice6 libx11-xcb1 libxi6 libxrender1 libxcb-cursor0 \
  libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-render-util0 \
  libxcb-xinerama0 libxcb-xkb1 libxkbcommon-x11-0 libgl1 libegl1
tar -xzf Strife-VERSION-linux-x64.tar.gz
./Strife/Strife
```

Use `-BuildVoice` with publish to rebuild native code first, or `-NoPackage` to publish only the runnable directory. `-OutputDirectory` accepts an empty destination; the default disposable `artifacts/Strife` is rebuilt on every publish to exclude stale files. `-VoiceDirectory` selects an already staged engine; its build metadata must match the runtime. `-InnoSetupCompiler` overrides the ISCC path. `-PrerequisiteDirectory` can supply cached Microsoft offline installers. Packages are always written to `artifacts/release`.

## Validation and signing

CI runs the managed/web tests, extracts each package, checks native library dependencies, and verifies the real voice engine's authenticated startup, RNNoise, command handling and shutdown. Windows additionally installs, reinstalls through the upgrade path, checks obsolete-file removal, runs the installed voice engine, uninstalls, and verifies profile preservation. The machine-install test intentionally only runs with `CI=true` on a disposable runner. It must not be used against an existing Strife installation. Linux startup uses Xvfb; macOS verifies the extracted app's signature and plist.

The Windows setup is unsigned. macOS packages use ad-hoc signatures, including the nested voice app; they are not Developer ID signed or notarized. Public trusted signing requires the publisher's certificates and, on macOS, notarization credentials. Gatekeeper may require user approval for downloaded builds. No signing secrets are included in the repository.

Manual platform checks should cover launching the full desktop, microphone permission prompts, physical input/output, global push-to-talk, and Helltube media. Native startup checks do not certify acoustic quality or OS permission behavior. User data follows .NET's LocalApplicationData directory on each platform, or `STRIFE_PROFILE` if configured.

The native toolchains link Qt statically. Dependency copyright files and upstream Mumble/RNNoise notices are copied into each package. Publishers must provide the source/relinking materials or commercial rights required for their chosen Qt build; see [third-party notices](../THIRD-PARTY-NOTICES.md) and the [upstream dependency environment](https://github.com/mumble-voip/vcpkg/releases/tag/2026-02).

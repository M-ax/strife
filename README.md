# Strife

A PhotinoX desktop app combining native Mumble voice with an existing Helltube server. By default, Mumble rooms and user controls sit on the left, chat sits beside them, and Helltube fills the remaining space. Drag any panel title to a highlighted workspace or panel edge to dock it top, bottom, left, or right. Drop elsewhere to float it. Chat and user controls can be placed above or below the rooms list. Stacked user controls stay 240px tall to fit the controls; when alone in a column, the pane fills the available height. Very small windows can still require scrolling.

Each title bar has collapse and position controls. The position menu also offers **Above Mumble rooms** and **Below Mumble rooms**. Drag dividers to resize docked panels, or the lower-right corner to resize a floating panel; focused resize controls also accept arrow keys. Press **Esc** to cancel a drag. Use **Menu → Reset panel layout** to restore the defaults. Moving panels preserves chat drafts and the embedded Helltube session.

## Run on Windows x64

Build requirements: .NET 10 SDK, Node.js 24 for browser tests, CMake, Visual Studio 2026 with C++ tools, and vcpkg dependencies for Mumble. Runtime requirements are Microsoft Edge WebView2 and the Microsoft Visual C++ v14 x64 Redistributable (already installed with the tested toolchain).

    ./scripts/build-voice.ps1
    ./scripts/run.ps1

The native build script defaults to the provided Mumble checkout and vcpkg installation. Override them when necessary:

    ./scripts/build-voice.ps1 -MumbleSource C:/path/to/mumble -VcpkgRoot C:/path/to/vcpkg

Initialize Mumble's submodules before building. The tested source revision is f1954599ec510a4eb894106f79631f7ff8f1b6a1. The script copies the source into artifacts/mumble-source, adds a small control adapter, and builds artifacts/voice/strife-voice.exe. It does not edit the original Mumble checkout. Subsequent builds reuse that snapshot; -RefreshSource refreshes it after upstream changes. Patch anchors are checked before changing startup/default settings.

Required vcpkg components include Qt6 base/SVG/tools/translations, Boost, OpenSSL, Protobuf, libsndfile, Opus, CLI11, and spdlog, using x64-windows-static-md. SpeexDSP and RNNoise (including its model) are built from Mumble's bundled sources. The optional local test server also requires SQLite and SOCI's bundled source. The script disables overlay, plugin builds, automatic LAN discovery, Ice, and server D-Bus. Hostname/IP connections and the native audio/network/shortcut implementations are retained.

For a self-contained app and full Windows installer, install Inno Setup 6.3 or newer, then run:

    ./scripts/publish.ps1
    ./artifacts/Strife/Strife.exe

The setup executable and portable ZIP are written to `artifacts/release`. Setup includes the .NET runtime, native voice engine, and offline Microsoft WebView2/Visual C++ installers. It creates a Start Menu shortcut, optionally creates a desktop shortcut, supports upgrades, and registers an uninstaller. Profiles survive upgrades and uninstall. Use `-NoPackage` to publish only the portable directory; keep that entire directory together.

## Releases and other platforms

Publishing a GitHub release with a version tag such as `v0.1.0` starts the **Publish** workflow. It builds Windows x64, Linux x64, macOS Intel, and macOS Apple Silicon on native runners. Once every build and packaging check passes, it attaches the Windows installer/portable ZIP, Linux tarball, macOS app ZIPs, and `SHA256SUMS.txt` to that release. **Run workflow** builds a supplied version as downloadable workflow artifacts without creating a release.

On macOS, extract the ZIP and move `Strife.app` to Applications (macOS 14 or newer). The app is ad-hoc signed, not Developer ID signed or notarized. On Linux, extract the tarball and run `Strife/Strife`; the build targets Ubuntu 24.04 x64 and requires GTK 3, WebKitGTK 4.1, and the system audio/X11 libraries. The same archive also runs on current Arch, Rocky 10 with EPEL/CRB, and Void glibc x86_64; see the [distro-specific dependency instructions](https://strife.zip/wiki/#linux-client). It requires glibc 2.38 or newer and does not support Rocky 8/9 or Void musl. Neither platform requires a separately installed .NET runtime or Mumble.

See [release build instructions](docs/releases.md) for native dependencies, local builds, runtime packages, signing, and validation.

## Connect

1. Choose **Connect to server** and enter a Mumble/Murmur hostname, port, username, and optional password. Vanilla servers need no plugins or modifications.
2. Review unfamiliar server certificates in Mumble's native trust dialog. Certificate checks, client identities, and server authentication follow upstream Mumble.
3. Choose a channel in the left tree. Empty sibling rooms are grouped under a gray **x channels** control; expand it to show them at the same indentation. Rooms with users, including their parent channels, stay visible. Searching reveals matching rooms and users even in collapsed groups. Speaking, mute, and deafen states update from the native client.
4. Open **Menu → Voice settings & shortcuts** to configure input/output devices, transmit mode, processing, encoding, positional audio, attenuation, notifications, or networking.
5. For global push to talk, choose **Push To Talk** in **Audio Input**, then add a **Push-to-Talk** action in **Shortcuts** and record a keyboard, mouse, or supported controller binding. This uses Mumble's OS-level shortcut engine and works while another app or the embedded video has focus. As with standard Mumble, shortcuts into elevated apps may require matching privileges.
6. Choose **Helltube → Server** and enter your existing server URL, then sign in inside the video pane. Run the supplied Helltube checkout using its existing instructions (npm start after npm run build, normally port 3000). Strife does not start or change production servers.

RNNoise is compiled in and selected by default in every new Strife profile, before audio starts. Later changes made in the native settings dialog persist. The status beneath the microphone controls reports the engine's actual setting. The audio wizard and certificate settings remain available in the menu. Native dialogs open above Strife; the underlying Mumble main window stays hidden, including after accepting settings.

Chat messages go to the current voice channel. Incoming Mumble text and server notices preserve message line breaks without the native log's hidden spacer lines. URLs and named links are clickable and open through the system's browser or registered application. Embedded raster image attachments appear inline and scale to the chat pane. Unavailable, unsupported, or oversized attachments display a text placeholder; remote images and other rich HTML are not loaded in the desktop UI.

Timestamped log entries have subtle separators, with distinct colors for timestamps and Mumble user references. Open **Menu → Appearance** to choose the UI accent, timestamp, username, and chat link colors, plus independent chat and UI fonts. The chat font applies to both messages and the composer; the UI font applies to Strife's interface. Changes preview live, **Save appearance** keeps them across launches, and **Cancel** or **Esc** restores your saved appearance. **Reset defaults** previews the default colors and fonts, including the teal (`#00E0BB`) UI accent; save to keep the reset. Native Mumble dialogs and the embedded Helltube page retain their own appearance.

Choose **Browse fonts** to search installed system font families. Each row shows a readable name and a sample in that font. The picker opens immediately and shows a spinner while fonts arrive at the bottom of the list; changing or clearing the search sorts the current matches alphabetically. Chat and UI pickers share the same cache. Restart Strife to discover newly installed fonts. Missing fonts use a system fallback, and the appearance controls stay readable even when choosing a symbol font.

The browser-only preview needs local font permission. While waiting for that permission, it shows seven built-in fallback choices and a permission message. If permission is denied, allow it in the browser and choose **Retry font access**. If the embedded preview cannot display the browser's permission prompt, use the desktop app; it reads the installed font list directly without browser font permission.

Click a color swatch to open the **HSV** picker. Drag in the saturation/value area or use the hue, saturation, and value sliders. Arrow keys also adjust the area, with Shift for larger steps. Color text boxes accept 6-digit or 3-digit hex codes, with or without `#`, and CSS color names such as `coral` and `rebeccapurple`. You can select and copy the hex text, or use **Copy hex** in the picker. **Use color** applies it to your appearance draft; canceling the picker restores its starting color. Save appearance to keep the changes.

Helltube permits framing by local desktop origins. Strife uses a separate loopback proxy origin to keep Helltube's login cookies working with remote servers and older deployments. HTTP, WebSockets, uploads and media remain served by Helltube; the proxy limits embedding to Strife's shell and forwards the original upstream Origin for authentication. Cookies are namespaced per upstream server, with HttpOnly and SameSite preserved; HTTPS remains verified on the connection to the upstream server. Browser permissions and WebView2 media capabilities still govern screen capture, DRM, and provider playback. No cross-service account linking or channel-to-room synchronization is assumed.

## Import from Mumble

Choose **Menu → Import from Mumble** (also available in **Connect to server**). Close Mumble first so its latest settings are saved, and disconnect Strife from voice. Strife suggests existing profile locations; you can also paste paths from another installation or backup. Supported settings are Mumble's version 1 JSON, legacy INI/conf files, and the current Windows user's Mumble registry settings (`registry`). The server database is `mumble.sqlite` or `.mumble.sqlite`; a database referenced by or beside the selected settings is detected automatically.

Choose **Review import**, then select settings, server data, and/or certificate identity. Settings include audio devices, processing and global shortcuts. Server data includes saved servers and passwords, certificate trust, friends, access tokens and server-specific shortcuts. Importing your certificate identity preserves server registrations. Selected categories **replace** their Strife equivalents; unselected categories, Helltube and panel layout stay as they are. Device names and external sound-file paths must still exist on this computer.

Strife takes a consistent database snapshot without modifying the source installation, backs up the replaced data under `import-backups` in its profile, and restarts voice. If applying the data or restarting voice fails, it attempts to restore the backup automatically. The completion message shows the backup location. To restore a backup manually, close Strife and copy its files into the Strife profile. Backups contain the same private credentials as the original profile.

Imported servers appear in **Connect to server → Saved server**. Their saved passwords stay in the native profile and are used without displaying them in the web interface. Manually typed passwords are still not saved. Imported settings retain Mumble's chosen noise suppression; RNNoise remains the default for new Strife profiles.

## Profiles and process lifetime

Settings, identity, server certificate pins, and browser session storage live under %LOCALAPPDATA%\Strife. Strife stores the last server address/port/username, Helltube URL, and panel layout (docking, floating positions, sizes, and collapse state). F5 restores those settings and the running Mumble session without reconnecting voice; Helltube reloads into its saved login and selected room. The connection form's password is passed to the voice engine in memory and is not written into Strife's preferences.

STRIFE_PROFILE overrides the profile directory, and STRIFE_VOICE_ENGINE overrides the native executable path. Do not share a profile between simultaneous running instances.

The desktop owns the voice process through a random, current-user-only named pipe (a private Unix socket on macOS/Linux) and a per-launch authentication token. Closing the desktop shuts down the voice process; a broken pipe also quits the engine. Audio, Opus, TLS, encrypted UDP, TCP voice tunneling, reconnection, jitter handling, and shortcuts remain upstream Mumble code.

## Validate

    dotnet build Strife.slnx -c Release
    dotnet run --project tests/Strife.Tests -c Release
    npm ci
    npm test
    npm run test:browser
    ./scripts/build-voice.ps1 -WithServer
    dotnet run --project tests/Strife.Tests -c Release -- --native
    npm run test:desktop

The browser test uses installed Chrome by default; set STRIFE_TEST_BROWSER=msedge to use Edge. The desktop test starts the real PhotinoX window and imports the supplied Helltube checkout (HELLTUBE_SOURCE overrides its location), with new isolated test data. It checks native RNNoise status, native mute, real Helltube sign-in/room navigation, pane resizing, and crash-free desktop shutdown. Its Windows probe activates the test window, checks settings ownership and foreground focus, accepts/cancels settings repeatedly, and monitors native show events to catch even a brief main-window flash. Run this test on an unlocked desktop. Set STRIFE_DESKTOP_EXE to the published executable to check the packaged app.

Native integration tests run two real voice engines against an isolated, unmodified Murmur server over TLS, pinning only a generated test certificate in test profiles. Test profiles select PTT without a binding so automated checks do not broadcast microphone audio. They exercise user/channel synchronization, cross-client text, mute/deafen, invalid channel handling, disconnect, and shutdown. Proxy tests cover Origin enforcement, cookie isolation, authenticated WebSockets, uploads, and ranged direct media. The verified Windows capture log reports WASAPI input and RNNoise 0.2 active. Acoustic quality and a physical global PTT binding should also be checked using your chosen microphone/headset.

See [architecture](docs/architecture.md) for integration details and [third-party notices](THIRD-PARTY-NOTICES.md) for upstream licenses.

## Branding

The logo, wordmark, and app icons use Strife teal (`#00E0BB`), matching the default UI accent. Branding assets live in `src/Strife.Desktop/wwwroot/assets`. The header uses `mark.svg`; `favicon.svg` is also the source for the Windows executable and window icon. After editing the favicon, run `npm run icons` to regenerate the multi-resolution `strife.ico` and the `strife.png` used by platform packages using the existing Playwright dependency and installed Chrome (`STRIFE_TEST_BROWSER=msedge` selects Edge). Rebuild or publish the app to apply the desktop icon.

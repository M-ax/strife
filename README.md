# Strife

A PhotinoX desktop app combining native Mumble voice with an existing Helltube server. The left pane contains the live Mumble channel tree, the middle pane contains collapsible Mumble chat, and the remaining space hosts Helltube's existing interface.

## Run on Windows x64

Build requirements: .NET 10 SDK, Node.js 24 for browser tests, CMake, Visual Studio 2026 with C++ tools, and vcpkg dependencies for Mumble. Runtime requirements are Microsoft Edge WebView2 and the Microsoft Visual C++ v14 x64 Redistributable (already installed with the tested toolchain).

    ./scripts/build-voice.ps1
    ./scripts/run.ps1

The native build script defaults to the provided Mumble checkout and vcpkg installation. Override them when necessary:

    ./scripts/build-voice.ps1 -MumbleSource C:/path/to/mumble -VcpkgRoot C:/path/to/vcpkg

Initialize Mumble's submodules before building. The tested source revision is f1954599ec510a4eb894106f79631f7ff8f1b6a1. The script copies the source into artifacts/mumble-source, adds a small control adapter, and builds artifacts/voice/strife-voice.exe. It does not edit the original Mumble checkout. Subsequent builds reuse that snapshot; -RefreshSource refreshes it after upstream changes. Patch anchors are checked before changing startup/default settings.

Required vcpkg components include Qt6 base/SVG/tools/translations, Boost, OpenSSL, Protobuf, libsndfile, Opus, CLI11, and spdlog, using x64-windows-static-md. SpeexDSP and RNNoise (including its model) are built from Mumble's bundled sources. The optional local test server also requires SQLite and SOCI's bundled source. The script disables overlay, plugin builds, automatic LAN discovery, Ice, and server D-Bus. Hostname/IP connections and the native audio/network/shortcut implementations are retained.

For a self-contained app, including the .NET runtime and native voice engine:

    ./scripts/publish.ps1
    ./artifacts/Strife/Strife.exe

Keep the entire published directory together. This Windows workstation builds for Windows x64; native staging and pipe naming need platform-specific work before packaging Linux or macOS releases.

## Connect

1. Choose **Connect to server** and enter a Mumble/Murmur hostname, port, username, and optional password. Vanilla servers need no plugins or modifications.
2. Review unfamiliar server certificates in Mumble's native trust dialog. Certificate checks, client identities, and server authentication follow upstream Mumble.
3. Choose a channel in the left tree. Speaking, mute, and deafen states update from the native client.
4. Open **Menu → Voice settings & shortcuts** to configure input/output devices, transmit mode, processing, encoding, positional audio, attenuation, notifications, or networking.
5. For global push to talk, choose **Push To Talk** in **Audio Input**, then add a **Push-to-Talk** action in **Shortcuts** and record a keyboard, mouse, or supported controller binding. This uses Mumble's OS-level shortcut engine and works while another app or the embedded video has focus. As with standard Mumble, shortcuts into elevated apps may require matching privileges.
6. Choose **Helltube → Server** and enter your existing server URL, then sign in inside the video pane. Run the supplied Helltube checkout using its existing instructions (npm start after npm run build, normally port 3000). Strife does not start or change production servers.

RNNoise is compiled in and selected by default in every new Strife profile, before audio starts. Later changes made in the native settings dialog persist. The status beneath the microphone controls reports the engine's actual setting. The audio wizard and certificate settings remain available in the menu. Native dialogs open above Strife; the underlying Mumble main window stays hidden, including after accepting settings.

Chat messages go to the current voice channel. Incoming Mumble text and server notices are rendered as plain text; rich HTML and image attachments are not rendered in the privileged desktop UI.

Helltube's normal headers deny framing. Strife uses a separate loopback proxy origin to embed it without changing the existing server. HTTP, WebSockets, uploads and media remain served by Helltube; the proxy limits embedding to Strife's shell and forwards the original upstream Origin for authentication. Cookies are namespaced per upstream server, with HttpOnly and SameSite preserved; HTTPS remains verified on the connection to the upstream server. Browser permissions and WebView2 media capabilities still govern screen capture, DRM, and provider playback. No cross-service account linking or channel-to-room synchronization is assumed.

## Profiles and process lifetime

Settings, identity, server certificate pins, and browser session storage live under %LOCALAPPDATA%\Strife. Strife stores the last server address/username, Helltube URL, and chat collapse preference. The connection form's password is passed to the voice engine in memory and is not written into Strife's preferences.

STRIFE_PROFILE overrides the profile directory, and STRIFE_VOICE_ENGINE overrides the native executable path. Do not share a profile between simultaneous running instances.

The desktop owns the voice process through a random, current-user-only named pipe and a per-launch authentication token. Closing the desktop shuts down the voice process; a broken pipe also quits the engine. Audio, Opus, TLS, encrypted UDP, TCP voice tunneling, reconnection, jitter handling, and shortcuts remain upstream Mumble code.

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

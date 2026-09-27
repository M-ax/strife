# Integration

## Native voice

Strife builds the supplied Mumble client with a small Qt control adapter. The original capture, processing, Opus, encryption, jitter buffering, and global shortcut files are compiled unchanged.

The build script changes these integration points in its private source snapshot:

- Include/call initializeStrifeSettings() after the native settings load, before audio initialization, and call startStrifeBridge() before entering the event loop.
- Change the default noise cancellation enum to RNNoise. Mumble's settings deserializer respects saved choices, and the build requires USE_RNNOISE.
- Add the adapter to the existing client object target.
- Override MainWindow::setVisible() and suppress showRaiseWindow() in Strife mode, so accepting settings, tray actions, and global shortcuts cannot reveal the native main window.

Initialization selects Strife's private database, disables automatic connection/update dialogs, generates an ordinary Mumble client identity when absent, and makes the audio wizard available on demand. Capture itself is initialized and owned by Mumble. The settings dialog is the original client dialog, so device changes and shortcut rebinding use its normal audio teardown/restart and shortcut registration paths.

The host passes its HWND and process ID directly to the child environment. On Windows the adapter makes native dialogs owned by that validated Strife window, preserving ownership of nested prompts. It raises and activates dialogs after Qt shows them; the host grants the child foreground permission when dispatching commands. The hidden native main window is never an exposed UI entry point.

The ordinary Mumble local RPC listener is disabled in sidecar mode; the engine only accepts Strife's authenticated control pipe. A private configuration, certificate directory, and temporary directory isolate Strife from a separately running vanilla client.

The adapter runs on Qt's GUI thread and serializes channels/users within Mumble's normal thread ownership boundaries. A 100 ms timer publishes changed state only. It exports plain text and link ranges from the native log document, with bounded history, omitting the zero-height empty blocks that separate Mumble's message frames. Actual message line breaks are preserved. The WebView creates text nodes and validated anchors, including detected plain-text URLs; it never inserts server HTML. Link clicks use the native `openLink` command and Qt's desktop URL handler, restricted to Mumble's external URL schemes. Native client/channel references remain plain text. No audio samples travel through JSON or the WebView.

## Local transport

The desktop creates a random named pipe with PipeOptions.CurrentUserOnly, starts its own engine, and supplies the name and random token in that child's environment. On macOS/Linux, .NET backs the pipe with a Unix socket: the host supplies the absolute socket path so Qt opens the same endpoint, inside a mode-0700 directory under `/tmp`. This also keeps macOS socket paths within the platform length limit. The directory is removed after the pipe closes. Qt connects and authenticates protocol version 1. Control messages and events are UTF-8 newline-delimited JSON. Frame lengths and queued native output are bounded. Writes are serialized; reads are buffered. On host disconnect the engine mutes and quits.

Commands: connect, disconnect, join, chat, openLink, mute, deafen, settings, wizard, certificate, shutdown. Host-only import requests `readImportSettings` and `checkImport` normalize settings using upstream Mumble serializers and check that no connection or modal native dialog is active. Import responses, including late responses, are consumed by the host rather than published to the web view.

The desktop import service discovers source locations, stages a read-only SQLite backup (including committed WAL data), and returns only availability and counts for review. Applying a reviewed snapshot stops voice, backs up the selected destinations, replaces them, and starts voice again. Failed apply/start attempts restore the original files and restart the old profile. Identity is selected independently of settings, and imported database paths are rebound to Strife's profile. Favorites are queried from the native database; the web UI receives server metadata and a password-availability flag. Saved passwords are resolved in the host only after verifying that the chosen server still matches the connection endpoint.

Events: hello, state, log, result. A command result means the command was accepted for processing, not that a network connection has completed. The connected state becomes true only after Mumble assigns the local session. TLS errors, authentication failures, and server restrictions are handled by native Mumble and appear in its dialogs/log.

The host serves only static UI assets on a random IPv4 loopback port. It exposes no HTTP voice-control API. WebView commands require both the exact top-level shell URL and a per-launch capability token, initially delivered in the URL fragment then kept in the current history entry while being removed from the visible URL. Reloads reuse that capability to request saved preferences and the cached native state/log; they do not reconnect an already running engine. The Helltube iframe receives neither the token nor native messages through an application-level postMessage relay. Top-level navigation away from the shell is blocked.

## Helltube

Helltube's CSP allows framing from itself and HTTP loopback desktop origins on dynamic ports. A dedicated loopback origin forwards its HTTP and WebSocket traffic for same-site cookie compatibility, removes any legacy X-Frame-Options, and narrows frame-ancestors to the exact Strife shell origin. It keeps the rest of the upstream CSP. TLS certificate verification remains enabled for upstream HTTPS.

The proxy namespaces cookies per upstream origin and removes that prefix when forwarding requests. It strips cookie Domain and Secure for loopback transport, preserving HttpOnly and SameSite. The shell and proxy are separate ports on the same loopback address, so Helltube's Strict same-site login cookie works without relaxing its same-site policy. No cookies from other upstreams are forwarded. Browser Origin is checked against the proxy before being rewritten to the upstream origin; requests from foreign origins or cross-site contexts are rejected.

Media and uploads stream through the proxy, including Range requests. The /api/config bareMetalOrigin, related JSON URLs, and HLS manifests are translated to local URLs; /direct requests retain their grants and are routed to the server-advertised media origin. Binary content is not buffered as JSON. No generic arbitrary-destination proxy endpoint is exposed.

Both services keep their own accounts and connection lifecycles. Native Mumble remains usable if the video server is offline; Helltube remains usable if the voice server disconnects.

An iframe grants autoplay, fullscreen, display capture, and clipboard write; it is sandboxed without top-level navigation permission. Host CSP permits HTTP/HTTPS frames but no remote scripts in the desktop shell. Mumble-originated text is assigned with textContent.

## Scope

Release builds target Windows x64, Linux x64, and macOS x64/arm64 using native runners and pinned Mumble dependency environments. Each package contains its platform's voice engine and a self-contained .NET host. Native startup/IPC/RNNoise checks run on every target; the full dialog ownership and desktop integration suite remains Windows-specific. Audio devices, microphone permissions and global shortcuts need interactive platform testing (especially macOS Accessibility permissions and Linux Wayland restrictions). RNNoise is bundled, rather than downloaded at runtime. A normal server does not need a Strife-specific plugin or API. Native Mumble settings provide features beyond the compact desktop controls.

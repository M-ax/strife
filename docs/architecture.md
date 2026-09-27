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

The adapter runs on Qt's GUI thread and serializes channels/users within Mumble's normal thread ownership boundaries. A 100 ms timer publishes changed state only. It mirrors plain text from the native log document, with bounded history. No audio samples travel through JSON or the WebView.

## Local transport

The Windows desktop creates a random named pipe with PipeOptions.CurrentUserOnly, starts its own engine, and supplies the name and random token in that child's environment. Qt connects and authenticates protocol version 1. Control messages and events are UTF-8 newline-delimited JSON. Frame lengths and queued native output are bounded. Writes are serialized; reads are buffered. On host disconnect the engine mutes and quits.

Commands: connect, disconnect, join, chat, mute, deafen, settings, wizard, certificate, shutdown.

Events: hello, state, log, result. A command result means the command was accepted for processing, not that a network connection has completed. The connected state becomes true only after Mumble assigns the local session. TLS errors, authentication failures, and server restrictions are handled by native Mumble and appear in its dialogs/log.

The host serves only static UI assets on a random IPv4 loopback port. It exposes no HTTP voice-control API. WebView commands require both the exact top-level shell URL and a per-launch capability token, initially delivered in the URL fragment then kept in the current history entry while being removed from the visible URL. Reloads reuse that capability to request saved preferences and the cached native state/log; they do not reconnect an already running engine. The Helltube iframe receives neither the token nor native messages through an application-level postMessage relay. Top-level navigation away from the shell is blocked.

## Helltube

Helltube's CSP allows framing from itself and HTTP loopback desktop origins on dynamic ports. A dedicated loopback origin forwards its HTTP and WebSocket traffic for same-site cookie compatibility, removes any legacy X-Frame-Options, and narrows frame-ancestors to the exact Strife shell origin. It keeps the rest of the upstream CSP. TLS certificate verification remains enabled for upstream HTTPS.

The proxy namespaces cookies per upstream origin and removes that prefix when forwarding requests. It strips cookie Domain and Secure for loopback transport, preserving HttpOnly and SameSite. The shell and proxy are separate ports on the same loopback address, so Helltube's Strict same-site login cookie works without relaxing its same-site policy. No cookies from other upstreams are forwarded. Browser Origin is checked against the proxy before being rewritten to the upstream origin; requests from foreign origins or cross-site contexts are rejected.

Media and uploads stream through the proxy, including Range requests. The /api/config bareMetalOrigin, related JSON URLs, and HLS manifests are translated to local URLs; /direct requests retain their grants and are routed to the server-advertised media origin. Binary content is not buffered as JSON. No generic arbitrary-destination proxy endpoint is exposed.

Both services keep their own accounts and connection lifecycles. Native Mumble remains usable if the video server is offline; Helltube remains usable if the voice server disconnects.

An iframe grants autoplay, fullscreen, display capture, and clipboard write; it is sandboxed without top-level navigation permission. Host CSP permits HTTP/HTTPS frames but no remote scripts in the desktop shell. Mumble-originated text is assigned with textContent.

## Scope

The supported build is Windows x64, with WASAPI and Mumble's Windows global shortcuts. PhotinoX itself is cross-platform, but this repository's native packaging and integration tests target Windows. RNNoise is bundled, rather than downloaded at runtime. A normal server does not need a Strife-specific plugin or API. Native Mumble settings provide features beyond the compact desktop controls.

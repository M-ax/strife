# Helltube desktop embed and native sharing

Implemented September 29, 2026 in the Strife and Helltube working trees. The dedicated embed and outer room/playback controls are included starting with preview.5. The optional native helper remains development-only and is not packaged in the published downloads. It currently targets Windows x64; release builds and other platforms retain Helltube's browser screen sharing.

## Behavior

Strife discovers Helltube's dedicated `/embed/strife.html` entry point through its version marker. It loads that page through the existing cookie-isolating loopback proxy. Older servers continue to use the ordinary Helltube page. The normal Helltube website does not enable the host protocol.

The embed shares Helltube's application, account/session, rooms and media player; it suppresses some decorative sidebar content. Strife adds a room selector and video mute control outside the frame. The protocol also supports changing playback volume. Room selection remains independent of Mumble channels.

When native sharing is available, **Share desktop** in Helltube opens Strife's source picker. Choose a window or display and press **Start sharing**. The helper publishes to the selected Helltube room without entering an endpoint, bearer token, or OBS profile. A Stop control remains in Strife and Helltube. Leaving the room, losing the Helltube connection, signing out, reloading the frame, changing the server, or closing Strife stops the publisher.

The development helper offers H.264 Baseline presets from 480p30 1.5 Mbps through **4K60 40 Mbps**, defaulting to **1080p60 8 Mbps**. Custom controls select a resolution ceiling, 15/30/60 fps, and 500–40,000 Kbps video in 100 Kbps steps. Opus audio can use 64/96/128/160/192 Kbps at 48 kHz stereo; 128 Kbps is the default. Disabling audio sends no audio track. Server capabilities gate high settings and are rechecked against the issued credential. The helper independently validates numeric limits. Output fits the source inside the selected ceiling, preserving aspect ratio and even dimensions without upscaling. The preview and active status show effective dimensions rather than pretending a smaller window is 4K. Helpers now require quality protocol 3, preview protocol 1, and audio protocol 1.

The picker separates Screens and Windows, supports filtering by name, and can refresh sources without minting a credential. Audio is off initially. With audio enabled, Automatic resolves a screen to the current default playback output and a window to its application. Manual selects an application or playback output independently. The resolved scope is displayed; unavailable automatic audio requires manual selection or disabling audio, never a system-audio fallback. Changing the video source clears a manual audio choice for explicit reselection. Refresh starts a new helper and resets audio to off.

Application audio uses the window's process tree, not necessarily just one window or browser tab. The private WASAPI module binds HWND, PID, and process creation time rather than reconnecting by title. Ambiguous/unresolvable windows are omitted. Playback outputs use concrete device IDs rather than following the default-device alias mid-stream. Audio loss latches mute with a visible warning; Stop/restart is required to select a new target. Closing a captured window stops its share. Enumeration uses fresh random IDs, including across helper restarts, so stale choices cannot refer to replacement targets.

The selected source has a local live preview and an audio peak meter. **Load source thumbnails** captures a bounded page of six thumbnails without publishing; paging/filtering keeps memory bounded. Images are ephemeral BMP data on the private helper pipe, never uploaded, logged, or saved. Preview refreshes at most twice per second with stale-result rejection. Start performs a fresh local preflight before requesting a credential. Cancel/refresh releases capture; late preview requests cannot stop or retarget an active publisher.

Encoder choices include x264, NVENC, Quick Sync, and AMF. Each installed path must encode an actual local frame into a counting sink and produce a compatible Baseline SPS before being offered. The selected quality is revalidated before Start; failures never silently downgrade quality or switch encoders. NVENC and AMF were exercised on the development machine; Quick Sync remains unavailable there. Hardware-specific options enforce CBR, two-second keyframes, and zero B-frames. The private WHIP module uses the preflight SPS when hardware exposes headers only after its first frame, advertising the RFC 6184-compatible Baseline constraint subset while retaining the original SPS in the bitstream.

The helper keeps the OBS GUI, Qt, browser plugin, WebSocket server, and scripting runtime out of the payload. Microphone capture is off. System audio includes other applications and voice chat; Helltube playback is locally muted during native sharing. macOS/Linux native helpers and application audio remain unimplemented: they need platform SDK/build environments and permission/signing/portal validation. HDR, diverse devices, restricted networks, and multi-viewer capacity remain release checks. See the [remaining implementation plan](obs-streaming-options.md).

## Build and run locally

1. In the Helltube checkout, run `npm run obs:setup`, then configure the pinned OBS source using the Windows CMake preset as described in its OBS guide. The Strife build script expects that configured SDK and its dependency downloads. Run `npm run build` for Helltube's new embed entry point, then start that local Helltube server.
2. In Strife, run `./scripts/build-streaming.ps1`. Supply `-ObsSource` when the configured OBS checkout is elsewhere. The default is the current user's Helltube checkout under WebstormProjects. This requires CMake and Visual Studio 2026 C++ tools, and checks the tested OBS revision.
3. Run `./scripts/run.ps1`, set Helltube's server URL to that updated server, sign in, join a room, and choose **Share desktop**. The existing voice payload is reused.

The helper is staged in the ignored `artifacts/streaming` directory, separate from voice. `STRIFE_STREAM_ENGINE` can override the executable for development. The script builds the selected OBS dependency targets, compiles a small helper and private WHIP/WASAPI modules, then stages the DLL dependency closure, capture helper files, GPU detection executables, and module resources. Both private modules use exact pinned upstream source; runtime version markers reject stale mixed modules. Plugin configuration goes into an owned temporary directory, not the read-only installation, and is removed on shutdown. The script does not alter Helltube's OBS source checkout. Its manifest hashes every staged file. Complete dependency licensing/corresponding-source materials, clean-machine certification, installer lifecycle tests, and cross-platform builds remain release gates.

### Development packaging

`scripts/publish.ps1 -IncludeDevelopmentStreaming` explicitly includes the staged helper in a **Windows prerelease** build. `-StreamingDirectory` can select another payload. Default release/CI builds still omit it. Packaging rejects stale source/build recipes, modified or unlisted files, escaping manifest paths, and links. It runs a native startup/protocol/clean-shutdown check with a system-only PATH both before and after copying; it also checks that startup did not mutate the package. `tests/windows/streaming-package.ps1` exercises these gates.

Use `scripts/package-windows.ps1 -PortableOnly` to build only the portable ZIP when Inno Setup is unavailable; this does not validate installer behavior. `scripts/test-package.ps1 -Runtime win-x64 -PublishDirectory <published-directory>` checks the extracted voice payload and, when present, streaming. This opt-in development packaging is **not approval for public redistribution**: the remaining license/source, all-advertised-platform, installer, and production publishing checks still apply.

## Host protocol, version 1

Each message contains `channel: "helltube.strife"`, `version: 1`, `session`, `connection`, and `type`. The URL fragment supplies the exact loopback `parent` origin and a separate random embed `session`; it never contains the native desktop capability or publishing token. Each iframe load creates a fresh host `connection` challenge. Both peers check the exact origin, sender window, version, session, and connection. The embed only admits an HTTP loopback parent with an explicit port. This is an embedding contract, not attestation that an arbitrary loopback application is Strife.

| Direction | Message | Purpose |
| --- | --- | --- |
| Host → frame | `hello` | Establish the connection challenge and declare native sharing availability |
| Frame → host | `ready`, `state` | Report account ID, room ID/name, available rooms, connection state, local playback preferences and context generation |
| Host → frame | `command` | Bounded request ID plus `selectRoom`, `playback`, `share`, `capabilities`, or `credential` action |
| Frame → host | `result` | Match a pending request, with success/error or a scoped publishing credential |
| Frame → host | `share-request` | User asked to share; contains a fresh share ID bound to room and context generation |
| Frame → host | `stop-request` | Cancel/stop the active share |
| Host → frame | `share-status` | Choosing, starting, streaming, idle or error for that share ID |

The frame mints a credential only after the host responds to an active share request. It rejects duplicate issuance and revokes a credential whose response arrives after the room/session changes. The host rejects unknown requests, other windows/origins, prior connection challenges, regressing generations and mismatched rooms. The managed bridge still requires the exact shell URL and its native capability. The frame never receives arbitrary native commands, executable paths, Mumble control, or the capability itself.

Helltube adds authenticated `POST /api/rooms/:id/strife-token` and `DELETE` on that route. The token has the existing WHIP publishing-only scope and issuing-session expiry. It is separate from the user's standalone OBS token. DELETE requires the exact token in its JSON body, so cleanup of an older share cannot revoke its replacement. Issuance still requires membership and rejects automated rooms. Logout/account-session revocation continues to invalidate both token purposes.

`GET /api/rooms/:id/strife-capabilities` requires membership in a manual room and returns `{version:1,width:3840,height:2160,fps:60,bitrateKbps:40000,audioBitrateKbps:192,codec:"h264",profile:"baseline",level:"5.2"}` without issuing a token. The `capabilities` frame command forwards this as `publishing`, rejecting results after a room/generation change. New Strife credentials also contain `publishing`; the host rechecks it before native start. Missing capability contracts retain the previous 1080p/12 Mbps compatibility envelope. Malformed contracts do not enable high presets. These are application limits, not a new global WHIP bandwidth quota. Helltube uses level 5.2 for Strife routers while standalone OBS retains its existing policy. An explicit `expires:null` is accepted for a server-revocable non-expiring session; an absent expiry field is rejected.

The managed host constructs the ingest URL from its configured Helltube authority and the exact expected `/api/whip/:roomId` path. Remote publishing requires HTTPS; HTTP is permitted for loopback development. Credentials move through memory and the owned helper's redirected stdin pipe. They are not placed in process arguments, preferences, or logs. The private OBS WHIP build rejects redirects and cross-origin resource URLs before it can forward authorization or send a teardown request to another server.

The helper explicitly loads only the retained plugins, owns its OBS sources/encoders/output, and reports streaming after media bytes begin flowing. Startup failure, failed commands and EOF clean up the output. Closing the managed host closes its inherited pipe; a bounded shutdown wait also handles a stuck child. Native streaming runs separately from Mumble.

## Verification

Run `dotnet run --project tests/Strife.Tests -c Release -- --streaming` after building the helper. This checks managed destination validation, new/legacy embed discovery, and helper enumeration/shutdown without publishing desktop content. `npm test` checks the host message boundary and the existing web model tests. `npm run test:browser` covers the existing Strife UI.

With updated Helltube assets built, `npm run test:sharing` runs the shell and real frame in headless Chrome with the real helper. It checks decoded H.264 pixels through 4K, configured FPS/bitrate, no audio track when disabled, room/reload cleanup, invalid quality, and credential-redirect/resource-origin rejection. It also opens dedicated test windows and briefly plays generated tones: selected-application audio is measured at the receiver against an excluded application's tone, audio loss leaves video running without fallback, and real window capture with automatic audio stops on window closure. This does not capture user windows or microphones. The browser test uses a test transport for shell-to-native calls; managed transport/validation are tested separately. `HELLTUBE_SOURCE` selects a different Helltube checkout. These tests are not sustained 4K60 performance or multi-platform certification.

Helltube's `test/strife-embed.test.js` covers parent validation, stale handoffs, token-purpose isolation and conditional revocation. Its existing embed and OBS browser suites cover ordinary framing and decoded H.264/Opus playback.

Set `STRIFE_STREAM_SOAK_SECONDS=30` (up to 300) when running `npm run test:sharing` for a generated high-motion 4K source and local receiver throughput measurements on software and available hardware encoders. Results are written to `artifacts/streaming-soak.json`. This is a single-machine, single-viewer benchmark, not a network/capacity or cross-platform certification. Native status also reports render FPS/time, lagged frames, output frames, and output drops.

The October 15 Windows run used a visible local Chrome receiver, a generated
3840×2160/60 high-motion source, 40 Mbps video, and 30-second measurement windows:

| Encoder | Receiver presented fps | Receiver dropped frames |
| --- | ---: | ---: |
| x264 | 45.5 | 75 |
| NVIDIA NVENC (RTX 5090) | 57.3 | 81 |
| AMD AMF (integrated Radeon) | 48.5 | 104 |

All three continued publishing; native render/output counters remained near
60 fps. NVENC was the best tested path on this machine. These results **do not
establish sustained 60 fps for every encoder or receiver**. The report's
`meets60FpsTarget` field uses a 90% (54 fps) tolerance, not an exact-60 guarantee.
An earlier run exposed encoder state reuse after the local preflight; publication
now uses a fresh encoder carrying only the validated settings/SPS.

Publishing still follows both repositories' release instructions: all advertised platform builds, matching source provenance and documentation, R2 upload, website deployment, and production download verification. No release, push, or server deployment is performed by this development work.

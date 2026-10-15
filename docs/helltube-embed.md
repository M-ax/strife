# Helltube desktop embed and native sharing

Implemented September 29, 2026 in the Strife and Helltube working trees. The dedicated embed and outer room/playback controls are included starting with preview.5. The optional native helper remains development-only and is not packaged in the published downloads. It currently targets Windows x64; release builds and other platforms retain Helltube's browser screen sharing.

## Behavior

Strife discovers Helltube's dedicated `/embed/strife.html` entry point through its version marker. It loads that page through the existing cookie-isolating loopback proxy. Older servers continue to use the ordinary Helltube page. The normal Helltube website does not enable the host protocol.

The embed shares Helltube's application, account/session, rooms and media player; it suppresses some decorative sidebar content. Strife adds a room selector and video mute control outside the frame. The protocol also supports changing playback volume. Room selection remains independent of Mumble channels.

When native sharing is available, **Share desktop** in Helltube opens Strife's source picker. Choose a window or display and press **Start sharing**. The helper publishes to the selected Helltube room without entering an endpoint, bearer token, or OBS profile. A Stop control remains in Strife and Helltube. Leaving the room, losing the Helltube connection, signing out, reloading the frame, changing the server, or closing Strife stops the publisher.

The current helper uses x264 H.264 Baseline at 1280x720, 30 fps and 3 Mbps, plus Opus stereo at 48 kHz / 128 Kbps. It keeps the OBS GUI, Qt, browser plugin, WebSocket server, and scripting runtime out of the payload. Microphone capture is off. Optional system audio includes all applications, including voice chat; Helltube playback is locally muted during native sharing. There is no preview, application-specific audio picker, or hardware encoder selection yet. Window/display capture and audio-device behavior still require interactive testing on the intended machines; automated publishing tests use generated media.

## Build and run locally

1. In the Helltube checkout, run `npm run obs:setup`, then configure the pinned OBS source using the Windows CMake preset as described in its OBS guide. The Strife build script expects that configured SDK and its dependency downloads. Run `npm run build` for Helltube's new embed entry point, then start that local Helltube server.
2. In Strife, run `./scripts/build-streaming.ps1`. Supply `-ObsSource` when the configured OBS checkout is elsewhere. The default is the current user's Helltube checkout under WebstormProjects. This requires CMake and Visual Studio 2026 C++ tools, and checks the tested OBS revision.
3. Run `./scripts/run.ps1`, set Helltube's server URL to that updated server, sign in, join a room, and choose **Share desktop**. The existing voice payload is reused.

The helper is staged in the ignored `artifacts/streaming` directory, separate from voice. `STRIFE_STREAM_ENGINE` can override the executable for development. The script builds the selected OBS dependency targets, compiles a small helper and a private WHIP module, then stages the DLL dependency closure, capture helper files and module resources. The WHIP module uses source from the exact pinned upstream revision with Strife's redirect/resource-origin restrictions; it does not alter Helltube's OBS checkout. Its build manifest includes hashes of the staged files. This does not yet constitute a portable release recipe: dependency licensing/source materials, clean-machine checks, package inclusion, and cross-platform builds remain release work. The ordinary publish script does not silently include an experimental helper.

## Host protocol, version 1

Each message contains `channel: "helltube.strife"`, `version: 1`, `session`, `connection`, and `type`. The URL fragment supplies the exact loopback `parent` origin and a separate random embed `session`; it never contains the native desktop capability or publishing token. Each iframe load creates a fresh host `connection` challenge. Both peers check the exact origin, sender window, version, session, and connection. The embed only admits an HTTP loopback parent with an explicit port. This is an embedding contract, not attestation that an arbitrary loopback application is Strife.

| Direction | Message | Purpose |
| --- | --- | --- |
| Host → frame | `hello` | Establish the connection challenge and declare native sharing availability |
| Frame → host | `ready`, `state` | Report account ID, room ID/name, available rooms, connection state, local playback preferences and context generation |
| Host → frame | `command` | Bounded request ID plus `selectRoom`, `playback`, `share`, or `credential` action |
| Frame → host | `result` | Match a pending request, with success/error or a scoped publishing credential |
| Frame → host | `share-request` | User asked to share; contains a fresh share ID bound to room and context generation |
| Frame → host | `stop-request` | Cancel/stop the active share |
| Host → frame | `share-status` | Choosing, starting, streaming, idle or error for that share ID |

The frame mints a credential only after the host responds to an active share request. It rejects duplicate issuance and revokes a credential whose response arrives after the room/session changes. The host rejects unknown requests, other windows/origins, prior connection challenges, regressing generations and mismatched rooms. The managed bridge still requires the exact shell URL and its native capability. The frame never receives arbitrary native commands, executable paths, Mumble control, or the capability itself.

Helltube adds authenticated `POST /api/rooms/:id/strife-token` and `DELETE` on that route. The token has the existing WHIP publishing-only scope and issuing-session expiry. It is separate from the user's standalone OBS token. DELETE requires the exact token in its JSON body, so cleanup of an older share cannot revoke its replacement. Issuance still requires membership and rejects automated rooms. Logout/account-session revocation continues to invalidate both token purposes.

The managed host constructs the ingest URL from its configured Helltube authority and the exact expected `/api/whip/:roomId` path. Remote publishing requires HTTPS; HTTP is permitted for loopback development. Credentials move through memory and the owned helper's redirected stdin pipe. They are not placed in process arguments, preferences, or logs. The private OBS WHIP build rejects redirects and cross-origin resource URLs before it can forward authorization or send a teardown request to another server.

The helper explicitly loads only the retained plugins, owns its OBS sources/encoders/output, and reports streaming after media bytes begin flowing. Startup failure, failed commands and EOF clean up the output. Closing the managed host closes its inherited pipe; a bounded shutdown wait also handles a stuck child. Native streaming runs separately from Mumble.

## Verification

Run `dotnet run --project tests/Strife.Tests -c Release -- --streaming` after building the helper. This checks managed destination validation, new/legacy embed discovery, and helper enumeration/shutdown without publishing desktop content. `npm test` checks the host message boundary and the existing web model tests. `npm run test:browser` covers the existing Strife UI.

With the updated Helltube assets built, `npm run test:sharing` runs the Strife web shell and real Helltube frame in headless Chrome, substitutes a generated capture fixture, and starts the real native helper. It checks the picker handoff, actual decoded H.264 pixels, external room/mute controls, room-change/reload cleanup, and rejection of credential-bearing redirects and foreign WHIP resource URLs. The browser test uses a test transport for shell-to-native calls; the managed helper transport is checked separately. `HELLTUBE_SOURCE` selects a different Helltube checkout.

Helltube's `test/strife-embed.test.js` covers parent validation, stale handoffs, token-purpose isolation and conditional revocation. Its existing embed and OBS browser suites cover ordinary framing and decoded H.264/Opus playback.

Publishing still follows both repositories' release instructions: all advertised platform builds, matching source provenance and documentation, R2 upload, website deployment, and production download verification. No release, push, or server deployment is performed by this development work.

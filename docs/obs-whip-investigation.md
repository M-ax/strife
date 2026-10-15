# Bundled OBS / WHIP investigation

Investigated September 28, 2026 (America/Denver). Status: feasibility demonstrated on Windows with generated media; proposed integration, not a shipped Strife feature.

Follow-up, September 29: the [dedicated Helltube embed and Windows development helper](helltube-embed.md) now implement room handoff and native sharing. The measurements and proposals below describe the original investigation; release packaging remains outstanding.

## Recommendation

Build a separate Strife streaming helper around **libobs**, its WHIP output, and a small set of capture/encoder plugins. Let Strife provide source selection, a preview, Start/Stop, and status. Helltube should supply the selected room and a publishing credential through an explicit, narrowly scoped desktop integration.

The existing Helltube native test already implements the essential libobs initialization and encoder/output wiring without the OBS Studio interface. A stripped copy of its runtime successfully streamed generated H.264/Opus media to Helltube during this investigation. Keep the native Mumble integration and compiled voice cache independent of this work.

A reduced OBS Studio GUI is a fallback if retaining its scene editor becomes a requirement. It provides more existing controls, but adds another UI, Qt, profile management, and a control adapter. Removing the GUI is the better fit for the requested minimal configuration.

## Evidence and source revisions

- Strife inspected at `5575d3580576a682e580ed6503bfb6e4c8cbff92`.
- Helltube inspected at `05151cb33c4050ba5b4139a8594af989386faee3`.
- Helltube's OBS pin is `b5bfb79093e26ce4b0e71d999f59b6b22f961121`, described by Git as `32.2.1-85-gb5bfb7909`, plus its tracked Helltube patch. This is a development revision after 32.2.1, not an unmodified 32.2.1 release.
- The upstream release API reported [32.2.2](https://github.com/obsproject/obs-studio/releases/tag/32.2.2) as the latest stable release when checked. Use the existing Helltube pin to reproduce these measurements; selecting and validating a release pin is separate work.

The relevant Helltube sources are its [OBS guide](https://github.com/M-ax/helltube/blob/05151cb33c4050ba5b4139a8594af989386faee3/apps/obs-support/README.md), [patch](https://github.com/M-ax/helltube/blob/05151cb33c4050ba5b4139a8594af989386faee3/apps/obs-support/helltube.patch), [ingest and token implementation](https://github.com/M-ax/helltube/blob/05151cb33c4050ba5b4139a8594af989386faee3/server/obs.js), [SDP validation](https://github.com/M-ax/helltube/blob/05151cb33c4050ba5b4139a8594af989386faee3/server/obs-sdp.js), [token UI](https://github.com/M-ax/helltube/blob/05151cb33c4050ba5b4139a8594af989386faee3/src/components/ObsStream.svelte), and [native test helper](https://github.com/M-ax/helltube/blob/05151cb33c4050ba5b4139a8594af989386faee3/test/obs-native/main.cpp). These findings describe the inspected checkout; production Helltube deployments were not probed.

### Local validation

1. Helltube `npm run test:obs`: **14 passed**. Covers scoped tokens, membership, SDP validation, negotiation, teardown, concurrent publishers, revocation, expiry, and Worker forwarding.
2. Helltube `npm run test:obs:native`: initially failed on the expected video bitrate limit. The existing DLL predated the source's 12 Mbps change. Rebuilt the `obs-webrtc` target and native helper from existing sources; **1 passed**. No tracked Helltube source changes were needed.
3. Repeated that native test with a separate stripped runtime: **1 passed**. The helper's PATH contained only Windows System32. The test checked decoded red video pixels in headless Chrome, nontrivial audio/video packet counts at the relay, successful authenticated WHIP DELETE, and relay/router cleanup. It did not verify audible output or measure latency.

Only a generated 640x360/30 fps color-and-tone fixture was published to an isolated local Helltube test server. No desktop or microphone source was captured. FFmpeg's executable generated the fixture; the test server was deliberately configured without FFmpeg. This distinction matters: the publisher still uses FFmpeg libraries.

### Measured Windows payload

| Runtime | Unpacked bytes | MiB | Notes |
| --- | ---: | ---: | --- |
| Existing local OBS GUI runtime, excluding PDB/LIB/EXP | 141,509,226 | 134.95 | Browser and WebSocket plugins were already disabled; not stock OBS download size |
| Stripped fixture publisher | 57,369,134 | 54.71 | 229 files; three plugins, D3D11, dependencies, required data/locales, test executable |
| Stripped publisher ZIP | 22,896,604 | 21.84 | PowerShell `Compress-Archive`, Optimal; experiment archive only |

The stripped payload was assembled from the existing RelWithDebInfo binaries, not a fresh minimal source build. Start from the native test executable, `libobs-d3d11`, `obs-webrtc`, `obs-x264`, and `obs-ffmpeg`; recursively include app-local DLL dependencies reported by `dumpbin /dependents`; include libobs data and the three plugins' data. The resulting binary set was:

- Core/transport: `obs.dll`, `libobs-d3d11.dll`, `datachannel.dll`, `libcurl.dll`, `w32-pthreads.dll`, `zlib.dll`.
- Encoding/media: `libx264-164.dll`, `avcodec-62.dll`, `avdevice-62.dll`, `avfilter-11.dll`, `avformat-62.dll`, `avutil-60.dll`, `swresample-6.dll`, `swscale-9.dll`, `librist.dll`, `srt.dll`.
- The three OBS plugins and the native test executable.

It contained no Qt, OBS frontend API/GUI, browser plugin, WebSocket server, or scripting runtime. The 37,976,576-byte avcodec DLL alone accounts for roughly two thirds of the measured payload.

These numbers are a feasibility baseline, **not the final installer increment**. Capture plugins, hardware encoders, a production helper, notices/source materials, and any redistributable changes remain to be included. System DLLs, GPU drivers, and the installed VC++ runtime were available on the test machine. Import scanning does not find every dynamically loaded dependency; a clean packaged-machine check remains necessary. Peak memory, CPU/GPU load, startup time, and capture latency have not been measured.

## Helltube already supplies the ingest path

Authenticated `POST /api/rooms/:id/obs-token` returns `{token, path, expires}`. The issuer must be a member of the room, and automated rooms such as the Ben Zone reject manual publishing. `path` is `/api/whip/:roomId`; combine it with the configured Helltube API origin, not its separate direct-media origin.

The publishing token belongs to one user, room, and issuing sign-in session. Its raw value is returned only at creation; Helltube stores a hash. It expires with the session. Each user has **one token per room**; issuing another revokes the previous token and stops its stream. This means an automatic Start action can interrupt the same user's standalone OBS session. The initial UI needs a deliberate replacement confirmation, or Helltube needs a separate credential purpose for Strife before seamless coexistence is possible. Do not mint tokens on room selection or every reconnect.

The helper sends SDP with a Bearer token to the WHIP endpoint, consumes its SDP answer and Location resource URL, and deletes that resource to stop. The existing relay distributes the media; no RTMP service, additional transcoder, or new media listener is needed. Media reaches Helltube's advertised WebRTC listener directly, outside Strife's HTTP proxy. Existing HTTPS, UDP/TCP reachability and STUN/TURN configuration still matter.

Current Helltube constraints:

- One H.264 Baseline video encoding; optional Opus stereo audio, 48 kHz. No AV1, HEVC, or simulcast.
- At most 1920x1080, 60 fps, 12 Mbps video, 192 Kbps audio. The Helltube service applies CBR, a two-second keyframe interval, no B-frames, and repeated headers.
- No ICE trickle PATCH or ICE restart. Reconnection requires a fresh session negotiation. The pinned OBS path worked with Helltube's complete ICE-lite answer locally; restricted-network/TURN behavior is unverified.
- Existing live-share limits, room queue interruption/resumption, and four-hour stream limit apply. Logout, token replacement/revocation, room deletion, or skipping the share can end a stream.
- Closing the browser or leaving its room is not itself a token revocation. Strife must implement its own stop-on-room-change behavior.

## Minimal user interaction

Proposed initial flow: select a Helltube room, choose **Share → Window or screen**, inspect the preview, choose whether to include application audio, then **Start sharing to Room name**. Show the destination throughout the stream and provide a persistent Stop control. No URL, token, OBS profile, scene editor, codec, or stream-key entry should be required.

Start with one source and a conservative 720p30 / approximately 3 Mbps preset, with Opus at 128 Kbps when audio is included. Treat these as proposed defaults to benchmark, not settings already tested. Offer 1080p quality later within server limits. Try validated hardware H.264 encoders and retain x264 fallback. Encoder-specific settings must be mapped and checked: QSV, for example, uses `bframes`, whereas the generic WHIP service sets `bf`. A shared profile string alone does not prove every hardware encoder produces accepted SDP/bitstreams.

Keep microphone capture off by default because Mumble already carries voice. Prefer application audio where supported. Full system audio can recapture Helltube playback and Mumble, producing echo; expose that choice explicitly. Do not assume application-audio exclusion works identically across Windows, macOS, and Linux.

Stop when switching rooms or Helltube servers, logging out, or closing Strife. Never silently retarget a live stream. On an iframe reload, invalidate pending handoffs and stop unless the same authenticated room context can be re-established safely. A reconnect must stay bound to the original room/session and must not resume after an explicit Stop, expiry, or revocation. Older Helltube versions without the integration retain their existing manual OBS workflow.

## Room and credential handoff

Strife currently knows the Helltube **server URL**, not the selected room. The cross-origin iframe owns room state and its HttpOnly sign-in cookie. [DesktopBridge.cs](../src/Strife.Desktop/DesktopBridge.cs) admits only the trusted top-level shell with its per-launch token; there is no iframe-to-native application relay today. [HelltubeProxy.cs](../src/Strife.Desktop/HelltubeProxy.cs) isolates the iframe on a separate loopback origin.

Implement a versioned, streaming-specific `postMessage` contract in both applications:

1. Establish a handshake between the current iframe and shell. Validate exact origins and window references on both sides, use explicit target origins, and bind requests to the current frame/server generation. Helltube must constrain the supported parent to the desktop embedding context; accepting arbitrary embedding origins is not sufficient.
2. Report only room/account identity, connection state, and publishing availability. Use the selected Helltube room, never a Mumble channel name or a scraped DOM element.
3. After a local Start action and source preview, request a credential for that exact room and generation. Helltube creates it using its existing authenticated fetch. The response carries a bounded request ID, room ID, relative path, token, and expiry. Recheck context before accepting it; reject late responses after room/server/account changes.
4. Forward the handoff through the existing trusted shell-to-managed bridge. The managed host validates the expected WHIP path and derives the network destination from its configured upstream. Do not accept an arbitrary token-supplied URL or copy Helltube login cookies into native code. In the current UI, a displayed URL constructed from `location.origin` would point at Strife's loopback proxy; it is not the canonical ingest address.
5. Send credentials in memory over authenticated private IPC to the owned helper. Do not put them in process arguments, saved preferences, OBS profiles, logs, or URLs. Keep the desktop capability secret in the shell; never pass it to Helltube.

This is a deliberate extension of the current iframe isolation and needs boundary tests. Limit the relay to streaming requests/status rather than making arbitrary desktop or voice commands available to the iframe.

One concrete upstream issue to address before a production helper: the inspected WHIP output enables both `CURLOPT_FOLLOWLOCATION` and `CURLOPT_UNRESTRICTED_AUTH` and accepts a server-provided resource URL. Canonicalizing the initial endpoint does not prevent credential forwarding on redirects. Constrain redirects and resource destinations to the authorized origin, reject HTTPS downgrade, and test that Bearer tokens cannot reach unrelated hosts. If cross-origin ingest becomes necessary, make that an explicit trusted-server contract.

## What to include in the OBS build

| Part | Initial approach |
| --- | --- |
| libobs and graphics backend | Keep. Helper owns OBS startup, graphics/event-loop lifecycle, sources, encoders and output |
| obs-webrtc | Keep, including libdatachannel and curl; reuse Helltube service behavior or configure the generic service equivalently |
| obs-x264 | Keep as the compatible software fallback demonstrated by the test |
| obs-ffmpeg | Keep initially for `ffmpeg_opus`; this pulls FFmpeg and some unused output dependencies |
| Windows capture | `win-capture`, `libobs-winrt`, `win-wasapi`; retain required capture helper/data files until their dependencies are verified |
| macOS capture | `mac-capture` and appropriate graphics backend; evaluate VideoToolbox H.264 |
| Linux capture | `linux-pipewire` for portals/Wayland, `linux-capture` for X11, and the required audio source backend |
| Hardware encoders | Validate NVENC, QSV, AMF, VideoToolbox and Linux alternatives individually; ship only supported paths |
| OBS GUI/Qt, browser/CEF, WebSocket, scripting | Omit from the helper payload |
| Cameras, virtual camera, studio scenes/transitions, filters, text, media files, RTMP services, capture cards | Outside the initial product surface; exclude plugins where the retained dependency graph permits |

Upstream has [separate frontend and core APIs](https://docs.obsproject.com/frontends). The inspected build has `ENABLE_FRONTEND`, `ENABLE_BROWSER`, `ENABLE_WEBSOCKET`, `ENABLE_SCRIPTING`, `ENABLE_WEBRTC`, and `ENABLE_PLUGINS`. However, **`ENABLE_FRONTEND=OFF` is not a complete minimal-build recipe**: frontend API configuration still occurs, and the plugin list includes Qt-dependent frontend tools and output UIs. There is no universal per-plugin OFF flag in `add_obs_plugin`; some plugins have their own options. Use a small pinned plugin-selection/build patch or a dedicated build wrapper, and validate the actual dependency graph. Keep WebRTC and the needed plugins enabled.

Further size reduction can disable unused MPEG-TS/SRT/RIST output dependencies and eventually use a smaller FFmpeg build or a dedicated Opus encoder module. libobs itself still references FFmpeg libraries. Defer those changes until capture and packaging work; they introduce maintenance beyond removing unused plugins.

The GUI fallback can use [OBS launch parameters](https://obsproject.com/kb/launch-parameters) for profile/collection selection and startup, but these are not a full control/status protocol. A hidden GUI still needs an adapter or authenticated OBS WebSocket integration. On the inspected Windows build, portable configuration lives relative to the binary, which conflicts with a read-only installation directory unless explicitly addressed. It must also avoid modifying a user's standalone OBS profile. These costs are avoided by the proposed helper's small IPC contract.

## Implementation and release work still required

1. **Windows capture prototype:** a separately named libobs helper with `hello`, source enumeration, preview, start, stop, status, and shutdown; one scene/source, Opus, x264, then a validated hardware encoder. Use current-user-only authenticated IPC and bounded messages. Handle parent death, broken IPC, failed startup, device/source loss and output errors; a crashed helper must leave Mumble running. Do not treat successful `obs_output_start` as proof that media is flowing.
2. **Selected-room integration:** implement the handoff above in Helltube and Strife's managed host/UI. Include token-replacement handling, room/account changes, stale responses, unsupported Helltube versions, and readable error states. No Mumble bridge changes are needed.
3. **Reproducible OBS payload:** pin upstream commit, Helltube/Strife patches, submodules, dependency archives/checksums, compiler, build flags and plugin list. Use a separate cache keyed by those inputs, with dependency/load/startup checks even on a cache hit. Keep OBS recipes separate from files hashed by the existing voice cache; do not accidentally invalidate Mumble by placing OBS sources under its broad `native/**` cache input. The stale DLL found here illustrates why provenance and runtime checks both matter.
4. **Platform checks:** Windows monitor/window/application audio and HDR-to-SDR behavior; macOS screen/audio permissions, helper identity/bundle layout and nested signing; Linux X11 and Wayland portals, application audio, GPU drivers and the existing distro/glibc support promises. Build/test Windows x64, Linux x64, macOS x64 and arm64 before advertising bundled streaming on all of them. Only Windows fixture publishing was exercised here.
5. **Integration acceptance:** real capture reaches a second viewer; selected room is correct; preview matches output; audio does not loop; CPU/GPU use and latency are acceptable; no capability/token leakage; no cross-origin credential redirects; startup errors, denied permissions, unavailable encoders, restrictive networks/TURN, disconnects, sign-out, room switches and application exit clean up correctly. Validate from extracted/installable packages on machines without OBS or build tools.
6. **Distribution:** OBS/libobs are GPL-2.0-or-later according to upstream's [license declaration](https://github.com/obsproject/obs-studio/blob/b5bfb79093e26ce4b0e71d999f59b6b22f961121/README.rst) and [license](https://github.com/obsproject/obs-studio/blob/b5bfb79093e26ce4b0e71d999f59b6b22f961121/COPYING). Plan GPL-compatible licensing for the linked helper, corresponding source/build materials for the exact distributed binaries, and dependency notices. Review the combined distribution's obligations; a process boundary alone is not a license determination. Use Strife branding for the helper and preserve OBS attribution.
7. **Published release:** follow [releases.md](releases.md) and both repositories' AGENTS instructions. Cross-check landing page/wiki/download/release guidance, build every advertised platform, choose an immutable version, import actual packages with the exact source revision, upload to R2 before website deployment, and verify production downloads afterward. This investigation does not change published feature claims, manifests, or packages.

The next useful milestone is the Windows single-source capture helper plus an authenticated selected-room handoff. The transport feasibility is established; capture behavior, user interaction, and reproducible packaging are now the main unknowns.

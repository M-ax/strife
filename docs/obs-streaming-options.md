# Bundled OBS plan: application audio and quality controls

## Status and relationship to the existing plan

This extends the [original bundled OBS / WHIP investigation](https://github.com/M-ax/strife/blob/8fc31932b1042f579125a4dd6365b4a30343aa8c/docs/obs-whip-investigation.md)
and its [development implementation follow-up](https://github.com/M-ax/strife/blob/8fc31932b1042f579125a4dd6365b4a30343aa8c/docs/helltube-embed.md).
Those links preserve the recorded preview.5 baseline; the current
[development integration guide](helltube-embed.md) tracks implementation.
This plan's audio and quality requirements supersede the
original proposal to defer 1080p and leave application audio unspecified.

Retain the separate, minimal libobs helper, selected-room credential handoff,
WHIP transport, and independent Mumble process/cache. The recorded Windows
prototype uses fixed 720p30 / 3 Mbps x264 video and optional 128 Kbps system audio.
It has no application-audio picker or preview and is excluded from preview.5
installers. Everything below is planned work unless noted in the implementation
status; none of these additions is a claim of shipped installer support.

### Implementation status

The Windows development helper now implements all nine presets through
**4K60 40 Mbps**, with **1080p60 8 Mbps** as default. High presets require the
new Helltube capability contract, checked both when rendering options and against
the returned credential before publishing. Older servers retain five presets.
The helper advertises its actual H.264 SPS profile/level; Strife-purpose WHIP
routers support level 5.2. Rebuild older helpers for quality v3/preview v1/audio v1.

The picker separates Screens/Windows with search and refresh, plus Automatic
or Manual audio. Windows audio is pinned to a concrete output or an identified
application process tree. No audio sends no audio track. Audio loss latches
mute without fallback; closing the captured window stops sharing. Random
enumeration IDs prevent stale choices from selecting replacement targets.
Browser/native tests cover decoded 1440p/4K video, selected-versus-excluded
application tones, and a real window with automatic application audio.

The Windows helper now also has local live preview, paged on-demand thumbnails,
audio peak meters, custom video/audio quality, source-sized output without
upscaling, and runtime-probed hardware selection. NVENC and AMF are exercised on
the development machine; Quick Sync is exposed only when its local probe succeeds.
Development packaging validates file provenance and startup without an OBS SDK
on PATH. A bounded high-motion soak mode records local decoder throughput.

Still blocked/outstanding: macOS/Linux native implementations and platform builds,
VideoToolbox/Linux hardware paths, broad device/HDR/permission testing,
restrictive networks, multi-viewer capacity, full corresponding-source/license
materials, clean-machine certification, and installer lifecycle validation.
The current Windows host has no Inno Setup compiler; its WSL Ubuntu environment
does not have the pinned OBS development dependencies, and no macOS runner has
been supplied. Development-only portable packaging does not close those gates.

The attached Helltube revision `44d5e80` has removed WHIP bitrate caps since the
original investigation. The new Helltube changes add room-scoped capability
discovery and Strife's level-5.2 router without reintroducing a global bitrate
cap or changing standalone OBS behavior. The 40 Mbps limit is enforced by
Strife's quality selection/helper, not a server-wide bandwidth quota.
Deployment capacity controls remain separate release work.

## Application audio: platform findings

| Platform | Available approach | Planned Strife integration |
| --- | --- | --- |
| Windows | OBS Application Audio Capture; OBS also supports audio with window/game capture. The OBS guide specifies Windows 10 version 2004+ or Windows 11, and notes application compatibility exceptions. | Expose application audio using the retained Windows capture/audio plugins. Probe actual runtime/source support rather than relying only on OS version. Validate the exact pinned OBS implementation on supported Windows builds. |
| macOS | OBS 30+ provides a dedicated macOS Audio Capture source on macOS 13+ for all desktop audio or one application. ScreenCaptureKit screen capture can also include application audio. | Retain the relevant `mac-capture` sources and use the dedicated audio source so video and audio selection can be independent. Require macOS 13+ for this built-in application-audio path and test permission handling in the signed helper. |
| Linux | The third-party `obs-pipewire-audio-capture` plugin provides device and application capture. Its README requires OBS 28+ and WirePlumber, recommends PipeWire 0.3.62+, and requires applications to route audio through PipeWire. Its upstream integration PR is still open/draft in the inspected sources. | Evaluate and pin this plugin as an explicit additional dependency. Do not assume OBS's `linux-pipewire` screen-capture plugin or a working Wayland portal supplies application audio. Enable the option only after checking backend availability. |

On macOS 12.3–12.6, OBS's ScreenCaptureKit source supports video without audio.
Older macOS desktop-audio workflows need additional routing software; do not
silently install a virtual driver or promise application audio there.

On Linux, `pipewire-pulse` covers many applications; JACK/ALSA applications may
need their corresponding PipeWire integration. A PulseAudio-only machine does
not meet this plugin's requirements. Manual virtual-sink/monitor routing can be
documented as an advanced workaround, not advertised as automatic app selection.
PipeWire audio support is separate from X11 versus Wayland video capture.

Application capture is not necessarily window- or browser-tab-isolated. A
selected application's other windows, tabs, subprocesses, or audio streams can
be included depending on the backend. Display the actual capture scope and
verify it; do not label app audio as “this tab only.”

### Screen/window picker and sharing flow

1. Open a **Share to [room name]** dialog with **Screens** and **Windows**
   tabs, a source grid, selected-source preview, audio controls, and quality
   controls. Do not request a publishing token or send media during selection.
2. Screen tiles show display name/number, resolution, and a thumbnail. Window
   tiles show application icon/name, window title, and a thumbnail when permitted.
   Support keyboard navigation, accessible selected states, and window search.
   Exclude the picker's own window where possible. Explain unavailable thumbnails
   or protected/minimized content rather than showing a misleading frozen image.
3. Enumerate through the native helper with opaque, generation-bound source IDs;
   titles and thumbnails are display metadata, not identities. Refresh on source
   changes without moving selection to another item. Bound thumbnail size/rate,
   stop preview capture on cancellation, and never persist thumbnails or titles.
4. Use the OS picker where required, especially Wayland portals. Offer
   **Choose screen/window…** rather than pretending Strife can enumerate or
   bypass portal permissions. Reflect the granted source and available metadata
   afterward; portal selection may not expose a window's owning application.
5. Show a larger live preview, effective output dimensions, FPS, audio scope and
   level meter, and destination before **Start sharing**. A silent audio target
   is not necessarily broken; distinguish silence from unavailable capture.
   Disable Start until a video source and valid quality settings are selected.
   If requested audio is unresolved, require choosing a valid target or explicitly
   continuing without audio.
6. On Start, revalidate source generation, permission, audio target, quality,
   and room/session before requesting the credential. Reject late enumeration,
   preview, or credential results from older selections. Cancel releases capture
   resources without issuing a credential.
7. During sharing, keep destination, source, audio scope, quality, and Stop
   visible. **Change source/settings** stages a new selection and requires
   explicit stop/restart confirmation; it must not silently retarget live media.
   Window closure or display removal stops the share and offers reselection.
   Temporary minimized/occluded-source behavior must be tested and surfaced;
   never replace a missing window with full-screen capture.

### Automatic/manual audio selection

Keep **Include audio** off initially. When enabled, default to **Automatic**;
also offer **Manual**. Microphone capture remains off because Mumble owns voice.
Automatic describes source matching, not permission to start capturing audio.

| Video source | Automatic audio | Manual audio |
| --- | --- | --- |
| Screen | System audio from the current default playback output where the backend supports output selection; otherwise the backend's system-wide mix. Show the exact scope. Audio belongs to the system/output, not the selected monitor. | Choose a specific playback output/system mix supported by the backend, or choose one application instead. |
| Window | Audio from the selected window's owning application/process group, only when the backend can map it reliably. Show the resolved application and warn when other windows/tabs are included. | Choose one application explicitly, including a different app, or explicitly select system/output audio with its wider-scope warning. |

- Show the resolved target beneath Automatic, for example **System — Speakers**
  or **Application — Firefox (all matching streams)**. On macOS, do not promise
  per-output isolation if the chosen ScreenCaptureKit source captures a system
  mix instead. On Wayland, unknown owner metadata means manual app selection,
  not window-title guessing.
- Resolve Automatic again when the video selection changes before Start.
  Preserve Manual only if its target remains valid; visibly flag a mismatch with
  the new video source and require confirmation. Never silently reset Manual.
- Pin the resolved target for the active share. If the default output changes,
  offer an explicit switch/restart rather than silently following a new device.
  Manual targets stay pinned. On audio target loss, mute that capture, keep video
  running with a persistent warning, and require confirmation to select/rebind
  audio. Do not automatically bind a reused process ID or restarted application.
- Manual lists show application/device names, availability, and level activity
  where supported. Provide Refresh and a “play audio in the app” hint for
  backends that enumerate only active streams. Explain unavailable options.
  Start with one app or one system/output target, not a multi-source mixer.

### Common audio safety requirements

- Discover capabilities and stable target identifiers through the helper.
  Never authorize capture based solely on a window title. Handle app restarts,
  multiple instances, subprocesses, and targets that begin producing audio late.
- If app capture is unavailable, denied, or loses its target, show a clear state
  and allow video-only sharing. Never broaden capture to system audio silently.
- Keep app capture and system capture mutually exclusive to avoid double mixing.
  Warn that system audio can capture Mumble and Helltube playback. Retain local
  Helltube playback muting during sharing; do not claim this excludes voice.
- A helper excluding its own process does not necessarily exclude Strife's
  separate WebView or Mumble process. Test actual exclusion with simultaneous
  target audio, Helltube playback, and voice.
- Keep OS permission prompts and recovery instructions explicit. Linux plugin
  packaging, PipeWire access, and macOS helper identity/signing are release gates.

## Expanded resolution, frame-rate, and bitrate options

Expand the planned ceiling to **3840 × 2160 (4K UHD), up to 60 fps, and
40 Mbps video**. This requires coordinated Helltube and helper changes, not
just additional UI options. Set **1080p60 8 Mbps** as the default.

Preset names use **resolutionfps bitrate**, not descriptive names such as Balanced
or Detail. Include FPS in the name and render bitrate with units, for
example **1080p60 8 Mbps**. Use **4K** to mean 3840 × 2160,
not cinema 4096 × 2160. Custom selections use the same generated label and a
separate Custom indicator. The following are tuning targets, not benchmarks.

| Preset label | Output bounding box | Default FPS | Video bitrate |
| --- | --- | ---: | ---: |
| 480p30 1.5 Mbps | 854 × 480 | 30 | 1.5 Mbps |
| 720p30 3 Mbps | 1280 × 720 | 30 | 3 Mbps |
| 720p60 5 Mbps | 1280 × 720 | 60 | 5 Mbps |
| 1080p30 6 Mbps | 1920 × 1080 | 30 | 6 Mbps |
| 1080p60 8 Mbps (default) | 1920 × 1080 | 60 | 8 Mbps |
| 1440p30 12 Mbps | 2560 × 1440 | 30 | 12 Mbps |
| 1440p60 20 Mbps | 2560 × 1440 | 60 | 20 Mbps |
| 4K30 25 Mbps | 3840 × 2160 | 30 | 25 Mbps |
| 4K60 40 Mbps | 3840 × 2160 | 60 | 40 Mbps |

Advanced controls:

- Resolution: 480p, 720p, 1080p, 1440p, or 4K bounding box;
  frame rate: 15, 30, or 60 fps.
- Video bitrate: 500–40,000 Kbps in 100 Kbps steps, independent of resolution.
  Warn about poor quality at low rates/high resolutions instead of claiming every
  combination is suitable. Show a bandwidth estimate including audio and an
  explicit note that transport overhead is additional. The 40 Mbps ceiling is
  video bitrate, not a total-wire-rate cap; audio, RTP/DTLS/SRTP overhead and
  retransmissions require extra upload capacity.
- Audio: Opus stereo at 48 kHz, selectable 64, 96, 128 (default), 160, or
  192 Kbps; no audio encoder/track when audio is disabled.
- Preserve aspect ratio, fit inside the selected bounding box, and use
  encoder-compatible even dimensions without stretching. Avoid upscaling smaller
  sources; show the effective output dimensions. Treat portrait/ultrawide input
  explicitly rather than assuming the resolution label is the source size.
- Changes apply to the next stream. For an active stream, offer an explicit
  stop/restart with the new settings; do not imply live encoder reconfiguration
  or silently mint replacement credentials.

### Server, transport, and compatibility work

The original investigation records the existing Helltube ceiling as **1920 × 1080,
60 fps, 12 Mbps video, and 192 Kbps audio**, with one H.264 Baseline encoding,
CBR, two-second keyframes, no B-frames, and repeated headers. This plan raises
resolution/video-rate limits only after the following coordinated work:

- Inventory and update server token/ingest policy, SDP validation, router/relay
  limits, OBS WHIP service clamps, encoder configuration, and all tests/docs
  encoding the old limits. Retain membership, credential, stream-count, and
  duration restrictions. Do not weaken authorization to enable higher quality.
- Advertise a versioned publishing capability contract with maximum dimensions,
  FPS, video/audio bitrate, and accepted codec/profile/level combinations.
  Unknown/older servers retain the old ceiling; disable higher presets with an
  explanation rather than trying them and repeatedly reconnecting.
- Validate H.264 profile/level negotiation for 4K30 and 4K60 end to end; the old
  SDP/profile-level settings must not simply be reused with larger frames.
  Retain Baseline where supported, CBR, two-second keyframes, no B-frames, and
  repeated headers. Any required profile change needs explicit receiver/server
  compatibility testing. AV1/HEVC and simulcast remain outside this scope.
- Measure real receiver decoding in supported browsers/WebViews, congestion
  behavior, retransmissions, and relay ingress/egress under concurrent streams.
  A 40 Mbps publication costs roughly 40 Mbps video egress per viewer before
  overhead; enforce deployment-specific capacity limits below the product ceiling.
  Do not assume a low-bandwidth viewer receives an automatic lower-resolution
  rendition when there is no simulcast/transcoding.
- Offer a lower preset on overload or unsupported hardware with explicit user
  confirmation. Do not silently claim 4K output when encoding at a lower size.

Implement one validated quality configuration shared by UI, managed host, and
helper, with checks at each trust boundary. Intersect the UI choices with
validated encoder/platform capabilities and server limits when available.
Reject unsupported settings clearly; do not silently downgrade a requested
profile. Keep conservative defaults for older server contracts and surface
server rejections without repeated publishing attempts.

Retain x264 fallback, but do not promise acceptable 1080p60 or 4K CPU cost on
every machine. Gate 4K60 on validated encoder throughput and receiver support,
not merely a successful encoder initialization. Qualify hardware H.264 paths individually (NVENC/QSV/AMF,
VideoToolbox, and Linux alternatives). Verify emitted profile, rate control,
keyframes, and B-frame settings, not just successful encoder creation.
Persist only nonsecret preferences; rediscover audio/video targets on launch.

## Implementation and acceptance sequence

1. Add helper capability discovery, bounded audio-target enumeration, and the
   validated quality configuration together with the server publishing-capability
   contract and expanded ingest limits. Keep high presets unavailable until both
   ends support them. Implement the screen/window picker and Automatic/Manual
   audio states; show effective audio scope, dimensions, FPS, and bitrate.
2. Implement Windows application audio and configurable x264 output first.
   Add source preview and an audio-level indicator before Start; neither a meter
   nor `obs_output_start` alone proves viewer playback.
3. Implement macOS ScreenCaptureKit audio and evaluate the Linux plugin using
   pinned source, licensing review, and a separate streaming dependency cache.
   Do not modify or invalidate the stable native voice cache for app-only work.
4. Test each preset with actual captured motion/text and decoded receiver video.
   Check actual encoded dimensions/FPS, bitrate behavior, A/V synchronization,
   CPU/GPU load, dropped frames, and end-to-end latency. Include boundary and
   invalid quality inputs and audio-disabled sessions. Test 3840 × 2160 at
   30/60 fps and 40,000 Kbps, rejection above 40,000 Kbps/60 fps/maximum
   dimensions, and older-server gating. Exercise sustained 4K40 publishing,
   constrained links, multiple viewers, and deployment capacity rejection.
5. On each supported platform, verify selected-app audio reaches a second viewer
   while unrelated app audio, Mumble, and Helltube do not. Include browser
   multiprocess behavior, target exit/restart, permission denial/revocation,
   device changes, and audio backend loss. Verify missing app support never
   silently becomes system audio. Test both X11 and Wayland Linux environments.
   Cover Automatic screen/system and window/app resolution, Manual overrides,
   portal selections with unknown owners, default-output changes, reused IDs,
   cancelled permission dialogs, stale thumbnails, source closure/removal, and
   picker keyboard/screen-reader access. Assert preset labels follow
   resolutionfps bitrate, including custom selections.
6. Re-run credential isolation, redirect rejection, room/account changes,
   explicit Stop, helper crash, and parent-exit cleanup with the new options.
   Reconnection must never widen audio scope or retarget the room.
7. Complete reproducible builds, exact source/dependency notices, signing,
   clean-machine package tests, and all advertised platform checks before
   including the helper in installers. Publish actual supported capabilities,
   not parity inferred from upstream OBS. Follow the existing R2/website release
   workflow; this document changes no published feature claims.

## Research sources and evidence limits

- [OBS Windows application audio guide](https://obsproject.com/kb/application-audio-capture-guide)
- [OBS macOS desktop audio guide](https://obsproject.com/kb/macos-desktop-audio-capture-guide)
- [OBS macOS Screen Capture source](https://obsproject.com/kb/macos-screen-capture-source)
- [PipeWire audio plugin README and requirements](https://github.com/dimtpap/obs-pipewire-audio-capture)
- [PipeWire audio upstream integration PR #6207](https://github.com/obsproject/obs-studio/pull/6207)

These upstream sources establish available approaches, not validation inside
Strife's pinned helper. No macOS/Linux capture, Windows application-audio test,
quality benchmark, or new native build was run for this planning update.

# Direct metal streaming from Strife

Included in Strife preview.5 with a matching updated Helltube server.
This removes the local HTTP media hop; it is not a measured latency improvement.

## Finding

Previously, `HelltubeProxy` rewrote `/api/config`'s `bareMetalOrigin`,
API response URLs, and HLS playlist URLs to its loopback origin. It then
forwarded `/direct` requests to the advertised metal origin. The signed
grants and byte ranges survived, but the media bytes still passed through
the managed HTTP server. This remains the compatibility path for older servers.

The existing Helltube implementation issues resource-scoped
direct-access grants backed by the user's active session. Its player
validates direct URLs against `bareMetalOrigin`. Before this change, the metal
server's direct-route CORS and cross-site checks admitted configured website
origins, not Strife's random loopback origin. Removing Strife's URL rewriting
alone would therefore have broken cross-origin playback.

This finding concerns HTTP media delivery, not every streaming transport.
The native OBS/WHIP publisher already connects to the configured Helltube
authority without using the local HTTP proxy, and WebRTC media uses its
negotiated transport. Removing the HTTP hop will not remove encoder,
WebRTC relay, network, or player buffering latency.

## Implemented contract

Keep the loopback proxy for the embedded application, login, authenticated
API requests, and signaling. Let the player request HTTPS media directly
from metal, authorized by narrowly scoped grants rather than cookies.

1. **Negotiate support.** Helltube advertises `strifeDirectMedia: 1` and
   `strifeDirectMediaOrigin` in `/api/config` when the proxy supplies
   `X-Strife-Media-Origin`. Strife retains existing proxy behavior for older servers.
   Do not turn a failed direct authorization into a silent proxy retry.
2. **Identify the local recipient.** On supported grant-issuing requests,
   the managed proxy supplies its own canonical loopback origin in that
   header, overwriting any client-supplied value. Helltube issues grants only
   through an authenticated API request and validates an exact loopback origin,
   including its port. This identifies a recipient, not proof that the
   caller is an authentic Strife installation.
3. **Bind authorization.** The v2 signed grant includes the recipient
   origin and a ten-minute expiry, in addition to its resource/operation scope
   and issuing session. Metal rechecks session validity and current room
   access. The player refreshes through the authenticated API thirty seconds
   before expiry. It schedules against a monotonic clock using authenticated
   server lifetime metadata, not the desktop's wall clock. Existing playback
   stays attached during renewal; transient failures get bounded retries.
   Successful renewal reattaches using the room's current position, while
   authorization denial or exhausted retries stop playback without proxy fallback.
   Neither the login cookie nor native host capability is exposed.
4. **Allow only direct CORS.** On the supported `/direct` routes, validate
   the grant and its exact requesting origin before returning media.
   Echo that origin in `Access-Control-Allow-Origin`, vary by `Origin`,
   and do not allow credentials. Preflight must not depend on cookies;
   limit it to the required routes, methods, and headers. Keep the existing
   origin and CSRF protections for account APIs and WebSockets.
5. **Preserve the complete media URL graph.** In negotiated mode, Strife leaves
   validated media-access URLs intact rather than replacing the authority.
   This includes manifests, segments, initialization fragments, and
   encryption keys. Playlists reuse the same scoped grant rather than
   extending its expiry. The original `bareMetalOrigin` stays local for
   uploads/files; the separate media origin is used only for playback.
   Application/API URL rewriting remains separate, including when API and
   metal share an authority. Desktop playback requests metal directly for
   every HLS media kind, rather than attempting the edge through loopback.
6. **Keep browser protections.** Request direct media without cookies.
   Retain HTTPS certificate verification, exact destination validation,
   and CSP permissions for only the advertised media origin. Retain
   `no-referrer` and `no-store`; redact grants from access logs and
   diagnostics. A dedicated HLS FetchLoader uses `credentials: "omit"`
   and `redirect: "error"`, and validates child media URLs against the exact
   origin, job and grant. Negotiated mode does not fall back to native HLS,
   whose requests cannot enforce that redirect policy.

This change covers playback only. Uploads and attachment downloads need explicit
contracts and tests before bypassing the proxy: downloads can omit Origin,
and Strife currently intercepts attachment navigations for its download UI.
Do not broaden every `/direct` route merely to enable media playback.

## Validation checklist

- Real WebView/browser playback with separate shell, embedded application,
  API, and HTTPS metal origins; also test API and metal sharing an origin.
- Server-side request counters proving that media bytes reach metal
  directly and never traverse Strife's local HTTP server.
- Working manifests, segments, keys, range requests, grant refresh, seeks,
  reconnects, and logout or room-removal revocation.
- Rejection of missing, altered, expired, wrong-resource, and wrong-origin
  grants, including a different loopback port. Reject `null` origins.
- No account cookies or native capability at metal; no grant-bearing
  cross-origin redirects, log entries, or referrers.
- Successful CORS preflights without granting cross-origin access to
  ordinary authenticated APIs. Old-server behavior remains unchanged.
- Compare startup/seek time and end-to-end live latency with equivalent
  encoding and player buffering settings. Inspect the selected ICE pair
  separately for WebRTC, rather than attributing its latency to HTTP.

Run Strife's managed checks with
`dotnet run --project tests/Strife.Tests -c Release`. They cover negotiated
and legacy routing, same/separate API and media authorities, header spoofing,
invalid destinations, unchanged upload routes and authenticated control traffic.
Run Helltube's tests and production asset build alongside these checks.

For the real managed-proxy/browser integration, set `HELLTUBE_SOURCE` to the
Helltube checkout under test and run `npm run test:media` from Strife. It requires
that checkout's npm dependencies, FFmpeg, .NET 10 and Chrome. It builds both
the Helltube assets and the managed test fixture, then verifies decoded
encrypted HLS playback in a sandboxed frame, credential omission, direct
request routing, wrong-origin/resource rejection, redirects and logout
revocation. It uses loopback HTTP development origins; production HTTPS and
platform WebView checks remain separate validation work.

Both updated Strife and Helltube are needed to activate the capability.
Release publication follows [the coordinated package and website workflow](releases.md).
The implementation does not change native Mumble or its compiled cache.

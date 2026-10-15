using System.Net;
using System.IO.Compression;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Strife;

internal static class ProxySmoke
{
    private static WebApplication Create()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        return builder.Build();
    }
    private static string Origin(WebApplication app) =>
        app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();

    public static async Task Run(Action<bool, string> check)
    {
        await using var upstream = Create();
        await using var direct = Create();
        direct.MapGet("/direct/blob", async context =>
        {
            if (context.Request.Headers.Range != "bytes=1-3" || context.Request.Query["grant"] != "fixture") { context.Response.StatusCode = 400; return; }
            context.Response.StatusCode = 206;
            context.Response.Headers.ContentRange = "bytes 1-3/5";
            context.Response.ContentType = "application/octet-stream";
            await context.Response.Body.WriteAsync(new byte[] { 2, 3, 4 });
        });
        await direct.StartAsync();
        upstream.UseWebSockets();
        upstream.MapGet("/", async context =>
        {
            context.Response.Headers["X-Frame-Options"] = "DENY";
            context.Response.Headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'";
            await context.Response.WriteAsync("Helltube");
        });
        upstream.MapPost("/api/login", context =>
        {
            if (context.Request.Headers.Origin != Origin(upstream)) { context.Response.StatusCode = 403; return Task.CompletedTask; }
            context.Response.Headers.SetCookie = "session=alpha; Domain=example.invalid; Secure; HttpOnly; SameSite=Strict; Path=/";
            return context.Response.WriteAsJsonAsync(new { ok = true });
        });
        upstream.MapGet("/embed/strife.html", () => Results.Content("<meta name=\"helltube-embed\" content=\"strife-v1\">", "text/html"));
        upstream.MapGet("/api/me", context => context.Response.WriteAsJsonAsync(new { cookie = context.Request.Headers.Cookie.ToString() }));
        upstream.MapGet("/api/config", () => new { bareMetalOrigin = Origin(direct) });
        const string commit = "0123456789abcdef0123456789abcdef01234567";
        string? versionEncodings = null;
        upstream.MapGet("/api/version", async context =>
        {
            versionEncodings = context.Request.Headers.AcceptEncoding.ToString();
            context.Response.ContentType = "application/json; charset=utf-8";
            context.Response.Headers.ETag = "\"upstream-version\"";
            if (versionEncodings.Contains("zstd"))
            {
                // A real zstd response, as selected by Cloudflare for Chromium.
                context.Response.Headers.ContentEncoding = "zstd";
                await context.Response.Body.WriteAsync(Convert.FromBase64String(
                    "KLUv/SA1HQEA6HsiY29tbWl0IjoiMDEyMzQ1Njc4OWFiY2RlZiJ9AQAPOMc="));
            }
            else
            {
                context.Response.Headers.ContentEncoding = "gzip";
                await using var compressed = new GZipStream(context.Response.Body, CompressionMode.Compress, leaveOpen: true);
                await compressed.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { commit })));
            }
        });
        upstream.MapGet("/api/access", () => new { url = Origin(direct) + "/direct/blob?grant=fixture" });
        upstream.MapPost("/api/upload", async context =>
        {
            using var buffer = new MemoryStream(); await context.Request.Body.CopyToAsync(buffer);
            await context.Response.WriteAsJsonAsync(new { length = buffer.Length });
        });
        upstream.Map("/ws", async context =>
        {
            if (!context.WebSockets.IsWebSocketRequest || context.Request.Headers.Origin != Origin(upstream)
                || context.Request.Headers.Cookie != "session=alpha")
            { context.Response.StatusCode = 403; return; }
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            var buffer = new byte[128];
            var result = await socket.ReceiveAsync(buffer.AsMemory(), context.RequestAborted);
            await socket.SendAsync(buffer.AsMemory(0, result.Count), result.MessageType, true, context.RequestAborted);
            // Keep the fixture alive until the client has received the event.
            // Disposing immediately after SendAsync can reset the transport
            // before the proxy has delivered the buffered echo on macOS.
            await socket.ReceiveAsync(buffer.AsMemory(), context.RequestAborted);
            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "done", context.RequestAborted);
        });
        await upstream.StartAsync();
        await using var proxy = new HelltubeProxy(new Uri("http://127.0.0.1:12345/"));
        var embed = await proxy.LoadEmbedAsync(Origin(upstream));
        var embedUri = new Uri(embed);
        check(embedUri.AbsolutePath == "/embed/strife.html" && embedUri.Fragment.Contains("parent=http%3A%2F%2F127.0.0.1%3A12345&session="),
            "dedicated embed discovery binds the frame to the shell with a separate session nonce");
        check(embed == await proxy.LoadEmbedAsync(Origin(upstream)), "preference refresh preserves the embedded session");
        check(new Uri(await proxy.LoadEmbedAsync(Origin(direct))).AbsolutePath == "/", "older servers retain the ordinary Helltube frame");
        var url = await proxy.LoadAsync(Origin(upstream));
        var localOrigin = new Uri(url).GetLeftPart(UriPartial.Authority);
        var cookies = new CookieContainer();
        using var client = new HttpClient(new HttpClientHandler { CookieContainer = cookies });
        using var index = await client.GetAsync(url);
        check(!index.Headers.Contains("X-Frame-Options") &&
            index.Headers.GetValues("Content-Security-Policy").Single().Contains("frame-ancestors http://127.0.0.1:12345"), "proxy framing policy allows only the Strife shell");
        using var versionRequest = new HttpRequestMessage(HttpMethod.Get, url + "api/version");
        versionRequest.Headers.TryAddWithoutValidation("Accept-Encoding", "gzip, deflate, br, zstd");
        using var versionResponse = await client.SendAsync(versionRequest);
        check(versionEncodings is not null && versionEncodings.Contains("gzip") && !versionEncodings.Contains("zstd"),
            "proxy negotiates upstream encodings it can decode even when Chromium offers zstd");
        check(versionResponse.IsSuccessStatusCode && !versionResponse.Content.Headers.ContentEncoding.Any()
            && versionResponse.Headers.ETag is null,
            "rewritten compressed API responses have decoded-body headers");
        var version = JsonSerializer.Deserialize<JsonElement>(await versionResponse.Content.ReadAsStringAsync());
        check(version.GetProperty("commit").GetString() == commit, "Metal commit survives a compressed API response");
        using var login = new HttpRequestMessage(HttpMethod.Post, url + "api/login");
        login.Headers.Add("Origin", localOrigin);
        using var loggedIn = await client.SendAsync(login);
        check(loggedIn.IsSuccessStatusCode, "proxy rewrites upstream Origin for login");
        var setCookie = loggedIn.Headers.GetValues("Set-Cookie").Single();
        check(setCookie.StartsWith("strife_") && setCookie.Contains("HttpOnly") && setCookie.Contains("SameSite=Strict")
            && !setCookie.Contains("Domain=") && !setCookie.Contains("; Secure"), "proxy isolates cookies and preserves HttpOnly/SameSite");
        cookies.Add(new Uri(url), new Cookie("unrelated", "do-not-forward"));
        var me = JsonSerializer.Deserialize<JsonElement>(await client.GetStringAsync(url + "api/me"));
        check(me.GetProperty("cookie").GetString() == "session=alpha", "proxy forwards only this upstream's cookies");
        using var foreign = new HttpRequestMessage(HttpMethod.Post, url + "api/login");
        foreign.Headers.Add("Origin", "https://foreign.example");
        using var rejected = await client.SendAsync(foreign);
        check(rejected.StatusCode == HttpStatusCode.Forbidden, "proxy rejects cross-origin mutations");
        var config = JsonSerializer.Deserialize<JsonElement>(await client.GetStringAsync(url + "api/config"));
        check(config.GetProperty("bareMetalOrigin").GetString() == localOrigin, "direct-media configuration stays on local origin");
        var access = JsonSerializer.Deserialize<JsonElement>(await client.GetStringAsync(url + "api/access"));
        using var range = new HttpRequestMessage(HttpMethod.Get, access.GetProperty("url").GetString());
        range.Headers.TryAddWithoutValidation("Range", "bytes=1-3");
        using var media = await client.SendAsync(range);
        check(media.StatusCode == HttpStatusCode.PartialContent &&
            (await media.Content.ReadAsByteArrayAsync()).SequenceEqual(new byte[] { 2, 3, 4 }), "direct media grants and byte ranges forwarded unchanged");
        using var upload = new HttpRequestMessage(HttpMethod.Post, url + "api/upload") { Content = new ByteArrayContent(new byte[128 * 1024]) };
        upload.Headers.Add("Origin", localOrigin);
        using var uploaded = await client.SendAsync(upload);
        var uploadResult = JsonSerializer.Deserialize<JsonElement>(await uploaded.Content.ReadAsStringAsync());
        check(uploadResult.GetProperty("length").GetInt32() == 128 * 1024, "upload body streamed to Helltube");
        using var ws = new ClientWebSocket();
        ws.Options.Cookies = cookies;
        ws.Options.SetRequestHeader("Origin", localOrigin);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await ws.ConnectAsync(new UriBuilder(url + "ws") { Scheme = "ws" }.Uri, timeout.Token);
        await ws.SendAsync(Encoding.UTF8.GetBytes("room event").AsMemory(), WebSocketMessageType.Text, true, timeout.Token);
        var received = new byte[128];
        var count = await ws.ReceiveAsync(received.AsMemory(), timeout.Token);
        check(Encoding.UTF8.GetString(received, 0, count.Count) == "room event", "authenticated WebSocket room events pass through proxy");
        await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "received", timeout.Token);
        ws.Abort();
        await upstream.StopAsync();
        await direct.StopAsync();
        await DirectMedia(check, sameOrigin: false);
        await DirectMedia(check, sameOrigin: true);
    }

    private static async Task DirectMedia(Action<bool, string> check, bool sameOrigin)
    {
        const string job = "12345678-1234-1234-1234-123456789abc";
        const string header = "X-Strife-Media-Origin";
        await using var upstream = Create();
        await using var metal = Create();
        string? recipient = null;
        string? unexpectedHeader = null;
        string? accessOverride = null;
        string? originOverride = null;
        string? configBody = null;
        string? accessBody = null;
        TaskCompletionSource? accessEntered = null, accessReleased = null;
        var capability = 1;
        var mediaRequests = 0;
        string MetalOrigin() => sameOrigin ? Origin(upstream) : Origin(metal);
        upstream.MapGet("/api/config", context =>
        {
            recipient = context.Request.Headers[header];
            if (configBody is not null)
            {
                context.Response.ContentType = "application/json";
                return context.Response.WriteAsync(configBody);
            }
            return context.Response.WriteAsJsonAsync(new
            {
                bareMetalOrigin = MetalOrigin(), strifeDirectMedia = capability,
                strifeDirectMediaOrigin = originOverride ?? MetalOrigin()
            });
        });
        upstream.MapGet("/api/media/" + job + "/access", async context =>
        {
            recipient = context.Request.Headers[header];
            accessEntered?.TrySetResult();
            if (accessReleased is not null) await accessReleased.Task.WaitAsync(context.RequestAborted);
            if (accessBody is not null)
            {
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsync(accessBody);
                return;
            }
            await context.Response.WriteAsJsonAsync(new
            {
                url = accessOverride ?? MetalOrigin() + "/direct/media/" + job + "/index.m3u8?grant=v2.fixture",
                api = Origin(upstream) + "/api/me"
            });
        });
        upstream.MapGet("/api/uploads/fixture", context =>
        {
            unexpectedHeader = context.Request.Headers[header];
            return context.Response.WriteAsJsonAsync(new { transferUrl = MetalOrigin() + "/direct/uploads/fixture?grant=upload" });
        });
        async Task Media(HttpContext context)
        {
            mediaRequests++;
            // A request relayed by Strife would have the upstream Origin instead.
            if (context.Request.Headers.Origin != recipient || context.Request.Headers.Cookie.Count > 0
                || context.Request.Headers.Authorization.Count > 0)
            { context.Response.StatusCode = 403; return; }
            context.Response.ContentType = "application/vnd.apple.mpegurl";
            await context.Response.WriteAsync("#EXTM3U\n");
        }
        upstream.MapGet("/direct/media/" + job + "/index.m3u8", Media);
        metal.MapGet("/direct/media/" + job + "/index.m3u8", Media);
        await metal.StartAsync();
        await upstream.StartAsync();
        await using var proxy = new HelltubeProxy(new Uri("http://127.0.0.1:12345/"));
        var url = await proxy.LoadAsync(Origin(upstream));
        var local = new Uri(url).GetLeftPart(UriPartial.Authority);
        using var client = new HttpClient(new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false });
        using var configRequest = new HttpRequestMessage(HttpMethod.Get, url + "api/config");
        configRequest.Headers.Add(header, "http://127.0.0.1:6666");
        using var configResponse = await client.SendAsync(configRequest);
        var config = JsonSerializer.Deserialize<JsonElement>(await configResponse.Content.ReadAsStringAsync());
        check(recipient == local, "direct negotiation overwrites forged recipient with frame origin");
        check(config.GetProperty("bareMetalOrigin").GetString() == local
            && config.GetProperty("strifeDirectMediaOrigin").GetString() == MetalOrigin(),
            "only media origin bypasses rewriting (shared authority: " + sameOrigin + ")");
        using var accessRequest = new HttpRequestMessage(HttpMethod.Get, url + "api/media/" + job + "/access");
        accessRequest.Headers.Add(header, "https://foreign.example");
        using var accessResponse = await client.SendAsync(accessRequest);
        var access = JsonSerializer.Deserialize<JsonElement>(await accessResponse.Content.ReadAsStringAsync());
        check(recipient == local && access.GetProperty("api").GetString() == local + "/api/me",
            "access negotiation pins frame origin and preserves API isolation");
        var mediaUrl = access.GetProperty("url").GetString();
        check(mediaUrl == MetalOrigin() + "/direct/media/" + job + "/index.m3u8?grant=v2.fixture" && mediaRequests == 0,
            "grant issuance does not relay media bytes");
        using var mediaRequest = new HttpRequestMessage(HttpMethod.Get, mediaUrl);
        mediaRequest.Headers.Add("Origin", local);
        using var media = await client.SendAsync(mediaRequest);
        check(media.IsSuccessStatusCode && mediaRequests == 1, "client fetches metal without Strife rewriting its origin");
        using var uploadRequest = new HttpRequestMessage(HttpMethod.Get, url + "api/uploads/fixture");
        uploadRequest.Headers.Add(header, "https://foreign.example");
        using var uploadResponse = await client.SendAsync(uploadRequest);
        var upload = JsonSerializer.Deserialize<JsonElement>(await uploadResponse.Content.ReadAsStringAsync());
        check(string.IsNullOrEmpty(unexpectedHeader)
            && upload.GetProperty("transferUrl").GetString() == local + "/direct/uploads/fixture?grant=upload",
            "uploads retain local route and cannot inject desktop-media negotiation");
        foreach (var invalid in new[]
        {
            "https://foreign.example/direct/media/" + job + "/index.m3u8?grant=fixture",
            MetalOrigin() + "/direct/files/fixture?grant=fixture",
            MetalOrigin() + "/direct/media/" + job + "/index.m3u8?grant=fixture&extra=1",
            MetalOrigin() + "/direct/media/" + job + "/index.m3u8?grant=fixture#fragment",
            "/media/" + job + "/index.m3u8"
        })
        {
            accessOverride = invalid;
            using var rejected = await client.GetAsync(url + "api/media/" + job + "/access");
            check(rejected.StatusCode == HttpStatusCode.BadGateway, "negotiated media fails closed for invalid destination");
        }
        accessOverride = null;
        foreach (var initial in new[] { 1, 2 })
        {
            capability = initial;
            await client.GetStringAsync(url + "api/config");
            accessEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
            accessReleased = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var pending = client.GetStringAsync(url + "api/media/" + job + "/access");
            await accessEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            capability = initial == 1 ? 2 : 1;
            await client.GetStringAsync(url + "api/config");
            accessReleased.SetResult();
            var delayed = JsonSerializer.Deserialize<JsonElement>(await pending.WaitAsync(TimeSpan.FromSeconds(5)));
            check(delayed.GetProperty("url").GetString()!.StartsWith((initial == 1 ? MetalOrigin() : local) + "/direct/"),
                "in-flight access retains its request's negotiation across configuration changes");
            accessEntered = accessReleased = null;
        }
        foreach (var body in new[] { "{\"url\":{}}", "{\"url\":1}", "{\"url\":null}" })
        {
            accessBody = body;
            using var invalidAccess = await client.GetAsync(url + "api/media/" + job + "/access");
            check(invalidAccess.StatusCode == HttpStatusCode.BadGateway, "wrong media URL JSON types return controlled failure");
        }
        accessBody = null;
        originOverride = "http://remote.example";
        using var invalidConfig = await client.GetAsync(url + "api/config");
        check(invalidConfig.StatusCode == HttpStatusCode.BadGateway, "invalid direct-media configuration fails closed");
        originOverride = null;
        foreach (var malformed in new object[] { 1, new { invalid = true } })
        {
            configBody = JsonSerializer.Serialize(new { bareMetalOrigin = MetalOrigin(), strifeDirectMedia = 1, strifeDirectMediaOrigin = malformed });
            using var malformedConfig = await client.GetAsync(url + "api/config");
            check(malformedConfig.StatusCode == HttpStatusCode.BadGateway, "wrong media origin JSON types return controlled failure");
        }
        configBody = JsonSerializer.Serialize(new
        {
            bareMetalOrigin = "https://MEDIA.example:443", strifeDirectMedia = 1, strifeDirectMediaOrigin = "https://media.example"
        });
        var aliased = JsonSerializer.Deserialize<JsonElement>(await client.GetStringAsync(url + "api/config"));
        check(aliased.GetProperty("bareMetalOrigin").GetString() == local
            && aliased.GetProperty("strifeDirectMediaOrigin").GetString() == "https://media.example",
            "canonical authority aliases cannot bypass local upload configuration");
        configBody = null;
        capability = 2;
        var legacy = JsonSerializer.Deserialize<JsonElement>(await client.GetStringAsync(url + "api/config"));
        check(!legacy.TryGetProperty("strifeDirectMediaOrigin", out _) && !legacy.TryGetProperty("strifeDirectMedia", out _),
            "unknown capability cannot enable bypass");
        var legacyAccess = JsonSerializer.Deserialize<JsonElement>(await client.GetStringAsync(url + "api/media/" + job + "/access"));
        check(legacyAccess.GetProperty("url").GetString()!.StartsWith(local + "/direct/") && string.IsNullOrEmpty(recipient),
            "legacy media stays proxied and does not request bound grants");
        await upstream.StopAsync();
        await metal.StopAsync();
    }
}

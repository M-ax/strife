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
    }
}

using System.Net;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;

namespace Strife;

// Keep Helltube on a separate, same-site loopback origin for its Strict cookies.
// Narrow framing to this shell, including compatibility with older Helltube servers.
public sealed class HelltubeProxy(Uri shellOrigin) : IAsyncDisposable
{
    private readonly Dictionary<string, Endpoint> endpoints = [];

    public async Task<string> LoadAsync(string address)
    {
        var target = PreferencesStore.ValidateHelltubeUrl(address);
        var authority = target.GetLeftPart(UriPartial.Authority);
        if (!endpoints.TryGetValue(authority, out var endpoint))
        {
            endpoint = new Endpoint(new Uri(authority), shellOrigin);
            await endpoint.StartAsync();
            endpoints.Add(authority, endpoint);
        }
        return endpoint.Origin + target.PathAndQuery + target.Fragment;
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var endpoint in endpoints.Values) await endpoint.DisposeAsync();
    }

    private sealed class Endpoint(Uri upstream, Uri shell) : IAsyncDisposable
    {
        private static readonly HashSet<string> HopHeaders = new(StringComparer.OrdinalIgnoreCase)
        { "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "TE", "Trailer", "Transfer-Encoding", "Upgrade", "Host" };
        private readonly HttpClient client = new(new SocketsHttpHandler
        {
            AllowAutoRedirect = false, UseCookies = false,
            AutomaticDecompression = DecompressionMethods.All
        }) { Timeout = Timeout.InfiniteTimeSpan };
        private readonly string cookiePrefix = "strife_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(upstream.AbsoluteUri)))[..16] + "_";
        private WebApplication? server;
        private string? directOrigin;
        public string Origin { get; private set; } = "";

        public async Task StartAsync()
        {
            var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [] });
            builder.Logging.ClearProviders();
            builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
            // Uploads are streamed; Helltube applies its own authenticated quotas.
            builder.Services.Configure<Microsoft.AspNetCore.Server.Kestrel.Core.KestrelServerOptions>(o => o.Limits.MaxRequestBodySize = null);
            server = builder.Build();
            server.UseWebSockets();
            server.Run(ForwardAsync);
            await server.StartAsync();
            Origin = server.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        }

        private string UpstreamCookies(string? value) => string.Join("; ", (value ?? "").Split(';')
            .Select(c => c.Trim()).Where(c => c.StartsWith(cookiePrefix, StringComparison.Ordinal)).Select(c => c[cookiePrefix.Length..]));

        private string LocalCookie(string value)
        {
            var parts = value.Split(';').Select(p => p.Trim()).ToList();
            parts[0] = cookiePrefix + parts[0];
            parts.RemoveAll(p => p.StartsWith("Domain=", StringComparison.OrdinalIgnoreCase) || p.Equals("Secure", StringComparison.OrdinalIgnoreCase));
            // HttpOnly and SameSite are preserved. Only loopback uses plaintext.
            return string.Join("; ", parts);
        }

        private async Task ForwardAsync(HttpContext context)
        {
            if (context.Request.Host.Value != new Uri(Origin).Authority)
            { context.Response.StatusCode = 403; return; }
            var requestOrigin = context.Request.Headers.Origin.ToString();
            if ((!string.IsNullOrEmpty(requestOrigin) && requestOrigin != Origin)
                || (context.Request.Headers["Sec-Fetch-Site"] == "cross-site"))
            { context.Response.StatusCode = 403; return; }
            var destinationOrigin = context.Request.Path.StartsWithSegments("/direct") && directOrigin is not null
                ? directOrigin : upstream.GetLeftPart(UriPartial.Authority);
            var destination = new Uri(destinationOrigin + context.Request.PathBase + context.Request.Path + context.Request.QueryString);
            try
            {
                if (context.WebSockets.IsWebSocketRequest) { await ForwardSocketAsync(context, destination); return; }
                using var request = new HttpRequestMessage(new HttpMethod(context.Request.Method), destination);
                if (context.Request.ContentLength is > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding"))
                    request.Content = new StreamContent(context.Request.Body);
                foreach (var header in context.Request.Headers)
                {
                    if (HopHeaders.Contains(header.Key) || header.Key.Equals("Cookie", StringComparison.OrdinalIgnoreCase)
                        || header.Key.Equals("Origin", StringComparison.OrdinalIgnoreCase) || header.Key.Equals("Referer", StringComparison.OrdinalIgnoreCase)) continue;
                    if (!request.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray()))
                        request.Content?.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
                }
                var cookies = UpstreamCookies(context.Request.Headers.Cookie);
                if (cookies.Length > 0) request.Headers.TryAddWithoutValidation("Cookie", cookies);
                if (requestOrigin.Length > 0) request.Headers.TryAddWithoutValidation("Origin", upstream.GetLeftPart(UriPartial.Authority));
                if (context.Request.Headers.ContainsKey("Referer")) request.Headers.Referrer = upstream;
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, context.RequestAborted);
                context.Response.StatusCode = (int)response.StatusCode;
                foreach (var header in response.Headers.Concat(response.Content.Headers))
                {
                    if (HopHeaders.Contains(header.Key) || header.Key.Equals("X-Frame-Options", StringComparison.OrdinalIgnoreCase)) continue;
                    if (header.Key.Equals("Set-Cookie", StringComparison.OrdinalIgnoreCase))
                        context.Response.Headers[header.Key] = header.Value.Select(LocalCookie).ToArray();
                    else if (header.Key.Equals("Content-Security-Policy", StringComparison.OrdinalIgnoreCase))
                    {
                        var directives = string.Join("; ", string.Join("; ", header.Value).Split(';')
                            .Where(d => !d.TrimStart().StartsWith("frame-ancestors", StringComparison.OrdinalIgnoreCase)));
                        context.Response.Headers[header.Key] = directives + "; frame-ancestors " + shell.GetLeftPart(UriPartial.Authority);
                    }
                    else if (header.Key.Equals("Location", StringComparison.OrdinalIgnoreCase))
                        context.Response.Headers[header.Key] = header.Value.Select(RewriteAddresses).ToArray();
                    else context.Response.Headers[header.Key] = header.Value.ToArray();
                }
                // Some deployments separate edge/API and direct media origins.
                // Keep canonical /direct paths and grants, routing them to the
                // server-advertised metal origin while the browser stays local.
                var mediaType = response.Content.Headers.ContentType?.MediaType;
                if (mediaType == "application/json" && context.Request.Path.StartsWithSegments("/api"))
                {
                    var text = await response.Content.ReadAsStringAsync(context.RequestAborted);
                    if (context.Request.Path == "/api/config" && response.IsSuccessStatusCode)
                    {
                        var config = JsonNode.Parse(text);
                        var advertised = config?["bareMetalOrigin"]?.GetValue<string>();
                        if (!string.IsNullOrEmpty(advertised))
                            directOrigin = PreferencesStore.ValidateHelltubeUrl(advertised).GetLeftPart(UriPartial.Authority);
                    }
                    await WriteTransformedAsync(context, RewriteAddresses(text));
                }
                else if (context.Request.Path.Value?.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase) == true)
                    await WriteTransformedAsync(context, RewriteAddresses(await response.Content.ReadAsStringAsync(context.RequestAborted)));
                else await response.Content.CopyToAsync(context.Response.Body, context.RequestAborted);
            }
            catch (Exception e) when (e is HttpRequestException or WebSocketException or OperationCanceledException or IOException)
            {
                if (!context.Response.HasStarted && !context.RequestAborted.IsCancellationRequested)
                {
                    context.Response.Clear(); context.Response.StatusCode = 502;
                    await context.Response.WriteAsync("Helltube is unavailable. Check the server address and try Reload.");
                }
            }
        }

        private string RewriteAddresses(string text)
        {
            if (directOrigin is not null) text = text.Replace(directOrigin, Origin, StringComparison.Ordinal);
            return text.Replace(upstream.GetLeftPart(UriPartial.Authority), Origin, StringComparison.Ordinal);
        }

        private static async Task WriteTransformedAsync(HttpContext context, string text)
        {
            context.Response.Headers.Remove("Content-Length");
            context.Response.Headers.Remove("ETag");
            await context.Response.WriteAsync(text, context.RequestAborted);
        }

        private async Task ForwardSocketAsync(HttpContext context, Uri destination)
        {
            using var remote = new ClientWebSocket();
            foreach (var protocol in context.WebSockets.WebSocketRequestedProtocols) remote.Options.AddSubProtocol(protocol);
            remote.Options.SetRequestHeader("Origin", upstream.GetLeftPart(UriPartial.Authority));
            remote.Options.SetRequestHeader("Cookie", UpstreamCookies(context.Request.Headers.Cookie));
            var uri = new UriBuilder(destination) { Scheme = destination.Scheme == "https" ? "wss" : "ws" }.Uri;
            await remote.ConnectAsync(uri, context.RequestAborted);
            using var local = await context.WebSockets.AcceptWebSocketAsync(remote.SubProtocol);
            using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
            static async Task Pump(WebSocket from, WebSocket to, CancellationToken token)
            {
                var buffer = new byte[64 * 1024];
                while (true)
                {
                    var result = await from.ReceiveAsync(buffer.AsMemory(), token);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await to.CloseOutputAsync(from.CloseStatus ?? WebSocketCloseStatus.NormalClosure, from.CloseStatusDescription, token);
                        return;
                    }
                    await to.SendAsync(buffer.AsMemory(0, result.Count), result.MessageType, result.EndOfMessage, token);
                }
            }
            var outbound = Pump(local, remote, cancellation.Token);
            var inbound = Pump(remote, local, cancellation.Token);
            await Task.WhenAny(outbound, inbound);
            await cancellation.CancelAsync();
            try { await Task.WhenAll(outbound, inbound); }
            catch (Exception e) when (e is OperationCanceledException or WebSocketException) { }
        }

        public async ValueTask DisposeAsync()
        {
            client.Dispose();
            if (server is not null) { await server.StopAsync(); await server.DisposeAsync(); }
        }
    }
}

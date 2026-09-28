using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Strife;

internal static class NativeSmoke
{
    public static async Task Run(Action<bool, string> check)
    {
        var voicePath = VoiceEngine.FindExecutable();
        var checkout = new DirectoryInfo(AppContext.BaseDirectory);
        while (checkout is not null && !File.Exists(Path.Combine(checkout.FullName, "Strife.slnx"))) checkout = checkout.Parent;
        var root = checkout?.FullName ?? throw new DirectoryNotFoundException("Run the native test from the Strife source tree.");
        var serverPath = Path.Combine(root, "artifacts", "mumble-build", "Release", "mumble-server.exe");
        if (!File.Exists(serverPath)) throw new FileNotFoundException("Build with scripts/build-voice.ps1 -WithServer first.");
        var directory = Path.Combine(root, "artifacts", "integration", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=localhost", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var san = new SubjectAlternativeNameBuilder(); san.AddIpAddress(IPAddress.Loopback); san.AddDnsName("localhost");
        request.CertificateExtensions.Add(san.Build());
        using var cert = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(2));
        await File.WriteAllTextAsync(Path.Combine(directory, "server.pem"), cert.ExportCertificatePem());
        await File.WriteAllTextAsync(Path.Combine(directory, "server.key"), rsa.ExportRSAPrivateKeyPem());
        string Q(string file) => Path.Combine(directory, file).Replace('\\', '/');
        var ini = Path.Combine(directory, "server.ini");
        var raster = Convert.ToBase64String(await File.ReadAllBytesAsync(Path.Combine(root, "src", "Strife.Desktop", "wwwroot", "assets", "strife.png")));
        // Match Mumble's percent-escaped, line-wrapped attachment encoding.
        var encodedRaster = string.Join("&#10;", Enumerable.Range(0, (raster.Length + 71) / 72)
            .Select(i => Uri.EscapeDataString(raster.Substring(i * 72, Math.Min(72, raster.Length - i * 72)))));
        var rasterTag = "<img width=\\\"1\\\" height=\\\"1\\\" src=\\\"data:image/PNG;base64," + encodedRaster + "\\\" />";
        var imageHistory = string.Concat(Enumerable.Repeat(rasterTag, 45));
        const string gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        await File.WriteAllTextAsync(ini, $"""
            host=127.0.0.1
            port={port}
            database={Q("server.sqlite")}
            logfile={Q("server.log")}
            sslCert={Q("server.pem")}
            sslKey={Q("server.key")}
            welcometext="Strife integration test 😀 <a href=\"https://example.com/docs?a=1&amp;b=2\">Named guide</a><br/>Second line<br/><br/>After blank line<br/>Older images: {imageHistory}<br/>Inline 😀 <a href=\"https://example.com/photo\">{rasterTag}</a> after image <img src=\"{gif}\" alt=\"Tiny image\" /><img src=\"https://example.invalid/private.png\" />"
            registerName=Strife local test
            """);
        var start = new ProcessStartInfo(serverPath) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory };
        start.ArgumentList.Add("--ini"); start.ArgumentList.Add(ini); start.ArgumentList.Add("--foreground");
        using var server = Process.Start(start) ?? throw new Exception("Failed to start test Murmur.");
        try
        {
            await Until(async () =>
            {
                using var client = new TcpClient();
                try { await client.ConnectAsync(IPAddress.Loopback, port); return true; } catch (SocketException) { return false; }
            }, "Murmur startup");
            async Task<string> Profile(string name)
            {
                var profile = Path.Combine(directory, name); Directory.CreateDirectory(profile);
                // Push-to-talk with no binding prevents live microphone transmission during automated tests.
                await File.WriteAllTextAsync(Path.Combine(profile, "mumble-settings.json"),
                    """{"settings_version":1,"mumble_has_quit_normally":true,"audio":{"transmit_mode":"PTT"}}""");
                using var db = new SqliteConnection("Data Source=" + Path.Combine(profile, "mumble.sqlite"));
                db.Open();
                using var command = db.CreateCommand();
                command.CommandText = "CREATE TABLE cert (id INTEGER PRIMARY KEY AUTOINCREMENT, hostname TEXT, port INTEGER, digest TEXT);" +
                    "INSERT INTO cert(hostname,port,digest) VALUES ('127.0.0.1',$port,$digest)";
                command.Parameters.AddWithValue("$port", port);
                // Pin only this freshly generated fixture certificate; system trust is unchanged.
                command.Parameters.AddWithValue("$digest", Convert.ToHexString(cert.GetCertHash(HashAlgorithmName.SHA1)).ToLowerInvariant());
                command.ExecuteNonQuery();
                return profile;
            }
            var aliceProfile = await Profile("alice");
            await using var alice = new VoiceEngine(aliceProfile);
            await using var bob = new VoiceEngine(await Profile("bob"));
            var aliceMessages = new ConcurrentQueue<JsonElement>();
            var bobMessages = new ConcurrentQueue<JsonElement>();
            alice.Message += aliceMessages.Enqueue; bob.Message += bobMessages.Enqueue;
            await alice.StartAsync(); await bob.StartAsync();
            await Until(() => Task.FromResult(alice.LastState is not null && bob.LastState is not null), "initial snapshots");
            check(alice.LastState!.Value.GetProperty("rnnoise").GetBoolean(), "native RNNoise enabled by default");
            check(alice.LastState.Value.GetProperty("transmitMode").GetInt32() == 2, "native PTT settings loaded");
            await ImportTests.Native(directory, aliceProfile, alice, check);
            await alice.SendAsync(new { command = "connect", id = "connect-a", url = PreferencesStore.MumbleUrl("127.0.0.1", port, "StrifeAlice", "") });
            await bob.SendAsync(new { command = "connect", id = "connect-b", url = PreferencesStore.MumbleUrl("127.0.0.1", port, "StrifeBob", "") });
            try
            {
                await Until(() => Task.FromResult(alice.LastState?.GetProperty("users").GetArrayLength() == 2 &&
                    bob.LastState?.GetProperty("users").GetArrayLength() == 2), "two-client vanilla Murmur connection");
            }
            catch (TimeoutException error)
            {
                throw new Exception($"{error.Message}. Alice: {alice.Failure}, {alice.LastState}, {alice.LastLog?.GetProperty("text")}; " +
                    $"Bob: {bob.Failure}, {bob.LastState}, {bob.LastLog?.GetProperty("text")}", error);
            }
            check(alice.LastState!.Value.GetProperty("connected").GetBoolean(), "TLS connection to vanilla Murmur");
            try { await alice.EnsureImportReadyAsync(); throw new Exception("Import allowed during a connection"); }
            catch (ArgumentException) { check(true, "native import is rejected while connected"); }
            check(!aliceMessages.Any(m => m.GetProperty("type").GetString() == "result"
                && m.GetProperty("id").GetString()!.StartsWith("import-")), "private import responses never reach UI subscribers");
            check(alice.LastState.Value.GetProperty("channels").GetArrayLength() >= 1, "live server channel tree");
            await alice.SendAsync(new { command = "chat", id = "chat", text = "Strife smoke <script> is plain text" });
            await Until(() => Task.FromResult(bobMessages.Any(m => m.GetProperty("type").GetString() == "log" &&
                m.GetProperty("text").GetString()!.Contains("Strife smoke <script> is plain text"))), "cross-client chat");
            check(true, "channel chat received by second native client");
            var log = bob.LastLog!.Value;
            var logText = log.GetProperty("text").GetString()!;
            check(!logText.StartsWith('\n') && !logText.EndsWith('\n') &&
                !logText.Contains("\n\n["), "native frame separators do not add blank lines to chat");
            check(logText.Contains("Named guide\nSecond line\n\nAfter blank line"),
                "intentional message line breaks and blank lines survive log export");
            check(log.GetProperty("links").EnumerateArray().Any(link =>
                link.GetProperty("href").GetString() == "https://example.com/docs?a=1&b=2" &&
                logText.Substring(link.GetProperty("start").GetInt32(), link.GetProperty("length").GetInt32()) == "Named guide"),
                "native named links preserve their targets and UTF-16 text offsets");
            var images = log.GetProperty("images").EnumerateArray().ToArray();
            var inlineStart = logText.IndexOf("Inline 😀 ", StringComparison.Ordinal) + "Inline 😀 ".Length;
            var photo = images.Single(image => image.GetProperty("start").GetInt32() == inlineStart);
            check(photo.GetProperty("src").GetString() == "data:image/png;base64," + raster &&
                photo.GetProperty("width").GetInt32() > 1 && photo.GetProperty("height").GetInt32() > 1,
                "native images normalize Mumble's escaped data and include intrinsic dimensions");
            check(log.GetProperty("links").EnumerateArray().Any(link =>
                link.GetProperty("href").GetString() == "https://example.com/photo" &&
                link.GetProperty("start").GetInt32() == inlineStart && link.GetProperty("length").GetInt32() == 1),
                "linked images preserve their target and UTF-16 position");
            check(images.Last().GetProperty("src").GetString() == gif &&
                images.Last().GetProperty("alt").GetString() == "Tiny image" &&
                images.All(image => logText[image.GetProperty("start").GetInt32()] == '\ufffc'),
                "raster attachments retain their positions and alt text while remote images are excluded");
            check(images.Length > 2 && images.Length < 47 &&
                !images.Any(image => image.GetProperty("start").GetInt32() == logText.IndexOf('\ufffc')),
                "image history retains the latest attachments within the IPC frame budget");
            foreach (var target in new[] { "javascript:alert(1)", "file:///C:/Windows", "data:text/html,test",
                "qrc:/test", "clientid://id.1/test", "channelid://id.1/test", "//example.com", "relative" })
            {
                var linkId = "link-" + Guid.NewGuid().ToString("N");
                await alice.SendAsync(new { command = "openLink", id = linkId, url = target });
                await Until(() => Task.FromResult(aliceMessages.Any(m => m.GetProperty("type").GetString() == "result" &&
                    m.GetProperty("id").GetString() == linkId && !m.GetProperty("ok").GetBoolean())), "unsafe link rejection");
            }
            check(true, "native link handler rejects active, local, internal and relative URLs");
            await alice.SendAsync(new { command = "mute", id = "mute" });
            await Until(() => Task.FromResult(alice.LastState?.GetProperty("muted").GetBoolean() == true), "mute state");
            check(true, "native mute state reflected in UI bridge");
            await alice.SendAsync(new { command = "deafen", id = "deafen" });
            await Until(() => Task.FromResult(alice.LastState?.GetProperty("deafened").GetBoolean() == true), "deafen state");
            check(true, "native deafen state reflected in UI bridge");
            var snapshots = new List<JsonElement>();
            var shell = new Uri("http://127.0.0.1:12345/");
            var preferences = new PreferencesStore(directory); preferences.Load();
            var bridge = new DesktopBridge(preferences, alice, shell,
                text => snapshots.Add(JsonSerializer.Deserialize<JsonElement>(text)));
            var session = alice.LastState!.Value.GetProperty("session").GetInt32();
            await bridge.ReceiveAsync(shell, JsonSerializer.Serialize(new { command = "ready", id = "reload", token = bridge.Token }));
            var restored = snapshots.Single(m => m.GetProperty("type").GetString() == "state");
            check(restored.GetProperty("connected").GetBoolean() && restored.GetProperty("session").GetInt32() == session &&
                restored.GetProperty("deafened").GetBoolean() && restored.GetProperty("users").GetArrayLength() == 2,
                "refreshed UI receives the existing Mumble session and current controls without reconnecting");
            check(snapshots.Single(m => m.GetProperty("type").GetString() == "log").GetProperty("images").GetArrayLength() > 0,
                "refreshed UI receives cached chat attachments");
            await alice.SendAsync(new { command = "join", id = "join-invalid", channel = 999999 });
            await Until(() => Task.FromResult(aliceMessages.Any(m => m.GetProperty("type").GetString() == "result" &&
                m.GetProperty("id").GetString() == "join-invalid" && !m.GetProperty("ok").GetBoolean())), "invalid channel rejection");
            check(true, "stale channel rejected without disconnecting");
            await alice.SendAsync(new { command = "disconnect", id = "disconnect" });
            await Until(() => Task.FromResult(alice.LastState?.GetProperty("connected").GetBoolean() == false), "disconnect");
            check(true, "clean disconnect and cleared connection state");
        }
        finally
        {
            if (!server.HasExited) { server.Kill(true); await server.WaitForExitAsync(); }
            SqliteConnection.ClearAllPools();
        }
        check(!Directory.EnumerateFiles(directory, "*.dmp", SearchOption.AllDirectories).Any(), "native engines exit without a crash dump");
    }

    private static async Task Until(Func<Task<bool>> condition, string description)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            if (await condition()) return;
            await Task.Delay(100);
        }
        throw new TimeoutException(description);
    }
}

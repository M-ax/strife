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
        await File.WriteAllTextAsync(ini, $"""
            host=127.0.0.1
            port={port}
            database={Q("server.sqlite")}
            logfile={Q("server.log")}
            sslCert={Q("server.pem")}
            sslKey={Q("server.key")}
            welcometext=Strife integration test
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
            await using var alice = new VoiceEngine(await Profile("alice"));
            await using var bob = new VoiceEngine(await Profile("bob"));
            var aliceMessages = new ConcurrentQueue<JsonElement>();
            var bobMessages = new ConcurrentQueue<JsonElement>();
            alice.Message += aliceMessages.Enqueue; bob.Message += bobMessages.Enqueue;
            await alice.StartAsync(); await bob.StartAsync();
            await Until(() => Task.FromResult(alice.LastState is not null && bob.LastState is not null), "initial snapshots");
            check(alice.LastState!.Value.GetProperty("rnnoise").GetBoolean(), "native RNNoise enabled by default");
            check(alice.LastState.Value.GetProperty("transmitMode").GetInt32() == 2, "native PTT settings loaded");
            await alice.SendAsync(new { command = "connect", id = "connect-a", url = PreferencesStore.MumbleUrl("127.0.0.1", port, "StrifeAlice", "") });
            await bob.SendAsync(new { command = "connect", id = "connect-b", url = PreferencesStore.MumbleUrl("127.0.0.1", port, "StrifeBob", "") });
            await Until(() => Task.FromResult(alice.LastState?.GetProperty("users").GetArrayLength() == 2 &&
                bob.LastState?.GetProperty("users").GetArrayLength() == 2), "two-client vanilla Murmur connection");
            check(alice.LastState!.Value.GetProperty("connected").GetBoolean(), "TLS connection to vanilla Murmur");
            check(alice.LastState.Value.GetProperty("channels").GetArrayLength() >= 1, "live server channel tree");
            await alice.SendAsync(new { command = "chat", id = "chat", text = "Strife smoke <script> is plain text" });
            await Until(() => Task.FromResult(bobMessages.Any(m => m.GetProperty("type").GetString() == "log" &&
                m.GetProperty("text").GetString()!.Contains("Strife smoke <script> is plain text"))), "cross-client chat");
            check(true, "channel chat received by second native client");
            await alice.SendAsync(new { command = "mute", id = "mute" });
            await Until(() => Task.FromResult(alice.LastState?.GetProperty("muted").GetBoolean() == true), "mute state");
            check(true, "native mute state reflected in UI bridge");
            await alice.SendAsync(new { command = "deafen", id = "deafen" });
            await Until(() => Task.FromResult(alice.LastState?.GetProperty("deafened").GetBoolean() == true), "deafen state");
            check(true, "native deafen state reflected in UI bridge");
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

using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Strife;
using Velopack;
using Velopack.Locators;

VelopackApp.Build().SetAutoApplyOnStartup(false).Run();
if (Environment.GetEnvironmentVariable("CI") != "true") return 1;
var root = Environment.GetEnvironmentVariable("STRIFE_UPDATE_FIXTURE") ?? throw new Exception("Missing fixture directory.");
var version = VelopackLocator.Current.CurrentlyInstalledVersion?.ToString() ?? throw new Exception("Fixture must be installed.");
File.AppendAllText(Path.Combine(root, "launches.txt"), version + "\n");
if (version == "0.1.0-preview.2") return 0;
using var key = RSA.Create(2048);
var packagePath = Directory.GetFiles(Path.Combine(root, "packages"), "*-full.nupkg").Single();
var bytes = await File.ReadAllBytesAsync(packagePath);
var now = DateTimeOffset.UtcNow;
var manifest = new UpdateManifest(1, "preview", "0.1.0-preview.2", "Strife-0.1.0-preview.2-full.nupkg",
    bytes.Length, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), new string('a', 40),
    now, now.AddDays(30), 19041, "14.0.0.0");
var payload = JsonSerializer.SerializeToUtf8Bytes(manifest, UpdateManifest.Json);
var envelope = JsonSerializer.SerializeToUtf8Bytes(new UpdateEnvelope(Convert.ToBase64String(payload),
    Convert.ToBase64String(key.SignData(payload, HashAlgorithmName.SHA256, RSASignaturePadding.Pss))), UpdateManifest.Json);
var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
using var http = new HttpClient(new FixtureHandler(envelope, bytes));
using var updates = new AppUpdates(message =>
{
    using var doc = JsonDocument.Parse(message);
    var state = doc.RootElement.GetProperty("value").GetProperty("state").GetString();
    if (state == "ready") ready.TrySetResult();
    if (state is "error" or "manual") ready.TrySetException(new Exception(message));
}, http, key.ExportSubjectPublicKeyInfoPem(), Path.Combine(root, "cache"), TimeSpan.Zero);
if (!updates.Available) throw new Exception("Installed fixture does not support updates.");
updates.Start();
await ready.Task.WaitAsync(TimeSpan.FromMinutes(2));
if (Environment.GetEnvironmentVariable("STRIFE_UPDATE_RESTART") == "true" && !updates.RequestRestart())
    throw new Exception("Update action was refused.");
updates.Stop();
updates.ApplyOnExit();
return 0;

sealed class FixtureHandler(byte[] envelope, byte[] package) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        if (request.RequestUri?.Host != "strife.zip") throw new Exception("Unexpected update host.");
        var bytes = request.RequestUri.AbsolutePath.EndsWith(".json", StringComparison.Ordinal) ? envelope : package;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) });
    }
}

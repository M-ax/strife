using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Strife;
using Velopack;
using Velopack.Logging;

internal static class UpdateTests
{
    public static async Task Run(Action<bool, string> check, string directory)
    {
        using var key = RSA.Create(2048);
        using var wrongKey = RSA.Create(2048);
        var now = DateTimeOffset.UtcNow;
        byte[] package = "signed full update bytes"u8.ToArray();
        var manifest = new UpdateManifest(1, "preview", "0.1.0-preview.10", "Strife-0.1.0-preview.10-full.nupkg",
            package.Length, Convert.ToHexString(SHA256.HashData(package)).ToLowerInvariant(), new string('a', 40),
            now.AddMinutes(-1), now.AddDays(30), 19041, "14.40.33810.0");
        byte[] Envelope(UpdateManifest value)
        {
            var payload = JsonSerializer.SerializeToUtf8Bytes(value, UpdateManifest.Json);
            return JsonSerializer.SerializeToUtf8Bytes(new UpdateEnvelope(Convert.ToBase64String(payload),
                Convert.ToBase64String(key.SignData(payload, HashAlgorithmName.SHA256, RSASignaturePadding.Pss))), UpdateManifest.Json);
        }
        void Reject(Action action, string name)
        {
            try { action(); }
            catch (Exception e) when (e is InvalidDataException or FormatException or ArgumentException or JsonException)
            { check(true, name); return; }
            throw new Exception("Accepted " + name);
        }
        check(UpdateManifest.Verify(Envelope(manifest), key.ExportSubjectPublicKeyInfoPem(), "preview", now) == manifest,
            "signed update metadata round trips");
        Reject(() => UpdateManifest.Verify(Envelope(manifest), wrongKey.ExportSubjectPublicKeyInfoPem(), "preview", now), "reject wrong update key");
        Reject(() => UpdateManifest.Verify(Envelope(manifest), key.ExportSubjectPublicKeyInfoPem(), "stable", now), "reject cross-channel update");
        Reject(() => UpdateManifest.Verify(Envelope(manifest), key.ExportSubjectPublicKeyInfoPem(), "preview", now, now), "reject replayed update");
        Reject(() => UpdateManifest.Verify(new byte[UpdateManifest.MaximumEnvelopeBytes + 1], key.ExportSubjectPublicKeyInfoPem(), "preview", now), "bound update metadata");
        foreach (var invalid in new[]
        {
            manifest with { Schema = 2 }, manifest with { ExpiresAt = now }, manifest with { IssuedAt = now.AddHours(1) },
            manifest with { ExpiresAt = now.AddDays(90) }, manifest with { FileName = "../evil.exe" },
            manifest with { Bytes = long.MaxValue }, manifest with { Sha256 = new string('z', 64) },
            manifest with { SourceRef = "main" }, manifest with { MinimumVcRuntime = "latest" },
            manifest with { Version = "not-a-version" }, manifest with { Channel = "stable" }
        }) Reject(() => UpdateManifest.Verify(Envelope(invalid), key.ExportSubjectPublicKeyInfoPem(), "preview", now), "reject invalid signed update fields");
        check(SemanticVersion.Parse("0.1.0-preview.10") > SemanticVersion.Parse("0.1.0-preview.9")
            && SemanticVersion.Parse("0.1.0") > SemanticVersion.Parse("0.1.0-preview.10"), "update ordering uses full semantic versions");
        var cache = Path.Combine(directory, "update-cache");
        Directory.CreateDirectory(cache);
        var output = Path.Combine(directory, "download.nupkg");
        var partial = Path.Combine(cache, manifest.Sha256 + ".partial");
        await File.WriteAllBytesAsync(partial, package[..5]);
        using var http = new HttpClient(new Handler(request =>
        {
            check(request.RequestUri == new Uri(SignedUpdateSource.Origin, "updates/packages/" + manifest.FileName), "fixed update download origin");
            check(request.Headers.Range?.Ranges.Single().From == 5, "resume update download");
            var response = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(package[5..]) };
            response.Content.Headers.ContentRange = new ContentRangeHeaderValue(5, package.Length - 1, package.Length);
            return response;
        }));
        var source = new SignedUpdateSource(http, cache, "preview") { Manifest = manifest };
        await source.DownloadReleaseEntry(null!, manifest.Asset(), output, _ => { });
        check((await File.ReadAllBytesAsync(output)).SequenceEqual(package), "resumed update is complete and verified");
        foreach (var status in new[] { HttpStatusCode.Redirect, HttpStatusCode.NotFound })
        {
            using var rejected = new HttpClient(new Handler(_ => new(status)));
            var badSource = new SignedUpdateSource(rejected, cache, "preview") { Manifest = manifest };
            try { await badSource.DownloadReleaseEntry(null!, manifest.Asset(), output, _ => { }); throw new Exception("Accepted redirect/error"); }
            catch (InvalidDataException) { check(true, "update downloads reject redirects and errors"); }
        }
        using var corrupt = new HttpClient(new Handler(_ => new(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[package.Length]) }));
        try
        {
            await new SignedUpdateSource(corrupt, cache, "preview") { Manifest = manifest }
                .DownloadReleaseEntry(null!, manifest.Asset(), output, _ => { });
            throw new Exception("Accepted corruption");
        }
        catch (InvalidDataException) { check(!File.Exists(partial), "discard corrupt staged update"); }
        await File.WriteAllBytesAsync(output, new byte[package.Length]);
        try { await manifest.VerifyPackageAsync(output); throw new Exception("Accepted tampered staged package"); }
        catch (InvalidDataException) { check(true, "reverify staged packages before use"); }
    }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) =>
            Task.FromResult(respond(request));
    }
}

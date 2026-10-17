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
            var payload = JsonSerializer.SerializeToUtf8Bytes(value, new JsonSerializerOptions(UpdateManifest.Json)
            {
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
            });
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
        DotNetFrameworkRequirement[] frameworks =
        [
            new("Microsoft.NETCore.App", "10.0.2"),
            new("Microsoft.AspNetCore.App", "10.0.3")
        ];
        var frameworkManifest = manifest with { Schema = 2, DotNetFrameworks = frameworks };
        check(UpdateManifest.Verify(Envelope(frameworkManifest), key.ExportSubjectPublicKeyInfoPem(), "preview", now)
            .DotNetFrameworks!.SequenceEqual(frameworks), "schema 2 preserves exact framework requirements");
        foreach (var invalid in new[]
        {
            manifest with { Schema = 3 },
            manifest with { DotNetFrameworks = frameworks },
            frameworkManifest with { DotNetFrameworks = [] },
            frameworkManifest with { DotNetFrameworks = [frameworks[0]] },
            frameworkManifest with { DotNetFrameworks = [frameworks[0], frameworks[0]] },
            frameworkManifest with { DotNetFrameworks = [frameworks[0], new("Microsoft.WindowsDesktop.App", "10.0.3")] },
            frameworkManifest with { DotNetFrameworks = [frameworks[0], null!] }
        }) Reject(() => UpdateManifest.Verify(Envelope(invalid), key.ExportSubjectPublicKeyInfoPem(), "preview", now),
            "reject unsupported or incomplete framework metadata");
        foreach (var invalid in new[] { "10.0", "10.0.0.1", "10.0.0-preview.1", "10.0.0+build", "010.0.0",
            "10.0.-1", "10.0.0\n", "2147483648.0.0", "", null })
            Reject(() => UpdateManifest.Verify(Envelope(frameworkManifest with
            {
                DotNetFrameworks = [frameworks[0], new("Microsoft.AspNetCore.App", invalid!)]
            }), key.ExportSubjectPublicKeyInfoPem(), "preview", now), "reject non-stable framework versions");
        check(DotNetFrameworkRequirement.Satisfied(frameworks, name =>
            name == "Microsoft.NETCore.App" ? ["10.0.2"] : ["10.0.3"]), "exact shared framework versions satisfy requirements");
        check(DotNetFrameworkRequirement.Satisfied(frameworks, _ => ["9.0.20", "10.0.10", "11.0.0"]),
            "newer patch satisfies each framework among side-by-side versions");
        foreach (var installed in new[] { Array.Empty<string>(), new[] { "10.0.1" }, new[] { "9.0.99" },
            new[] { "11.0.0" }, new[] { "10.1.0" }, new[] { "10.0.3-preview.1", "10.0.3.0" } })
            check(!DotNetFrameworkRequirement.Satisfied(frameworks, _ => installed),
                "missing, older, different major/minor, and prerelease runtimes cannot satisfy update");
        check(!DotNetFrameworkRequirement.Satisfied(frameworks, name =>
            name == "Microsoft.NETCore.App" ? ["10.0.10"] : []), "NETCore alone cannot replace missing ASP.NET runtime");
        check(!DotNetFrameworkRequirement.Satisfied(frameworks, name =>
            name == "Microsoft.AspNetCore.App" ? ["10.0.10"] : []), "ASP.NET alone cannot replace missing NETCore runtime");
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
        var large = new byte[4 * 1024 * 1024];
        var largePath = Path.Combine(directory, "hash-context.nupkg");
        await File.WriteAllBytesAsync(largePath, large);
        var largeManifest = manifest with { Bytes = large.Length, Sha256 = Convert.ToHexString(SHA256.HashData(large)).ToLowerInvariant() };
        var context = new CountingContext();
        var previousContext = SynchronizationContext.Current;
        Task verification;
        try
        {
            SynchronizationContext.SetSynchronizationContext(context);
            verification = largeManifest.VerifyPackageAsync(largePath);
        }
        finally { SynchronizationContext.SetSynchronizationContext(previousContext); }
        await verification;
        check(context.Posts == 0, "exit verification never waits for the stopped UI dispatcher");
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

    private sealed class CountingContext : SynchronizationContext
    {
        public int Posts;
        public override void Post(SendOrPostCallback callback, object? state)
        {
            Interlocked.Increment(ref Posts);
            base.Post(callback, state);
        }
    }
}

using System.Net;
using System.Net.Http.Headers;
using Velopack;
using Velopack.Logging;
using Velopack.Sources;

namespace Strife;

// The only source accepted by UpdateManager. No package-provided URLs, redirects,
// cookies, arbitrary local paths, or unsigned feed entries cross this boundary.
public sealed class SignedUpdateSource(HttpClient http, string cache, string channel) : IUpdateSource
{
    public static readonly Uri Origin = new("https://strife.zip/");
    public UpdateManifest? Manifest { get; set; }

    public Task<VelopackAssetFeed> GetReleaseFeed(IVelopackLogger logger, string? appId,
        string requestedChannel, Guid? stagingId = null, VelopackAsset? latestLocalRelease = null)
    {
        if (Manifest is null || requestedChannel != channel || appId != "Strife")
            throw new InvalidDataException("Unverified update feed.");
        return Task.FromResult(new VelopackAssetFeed { Assets = [Manifest.Asset()] });
    }

    public async Task DownloadReleaseEntry(IVelopackLogger logger, VelopackAsset asset, string localFile,
        Action<int> progress, CancellationToken cancelToken = default)
    {
        var manifest = Manifest ?? throw new InvalidDataException("No verified update.");
        if (asset.FileName != manifest.FileName || !manifest.Sha256.Equals(asset.SHA256, StringComparison.OrdinalIgnoreCase) || asset.Size != manifest.Bytes)
            throw new InvalidDataException("Update does not match signed metadata.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancelToken);
        deadline.CancelAfter(TimeSpan.FromMinutes(20));
        cancelToken = deadline.Token;
        Directory.CreateDirectory(cache);
        var partial = Path.Combine(cache, manifest.Sha256 + ".partial");
        var offset = File.Exists(partial) ? new FileInfo(partial).Length : 0;
        if (offset > manifest.Bytes) { File.Delete(partial); offset = 0; }
        if (offset < manifest.Bytes)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(Origin, "updates/packages/" + manifest.FileName));
            if (offset > 0) request.Headers.Range = new RangeHeaderValue(offset, null);
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancelToken);
            if (response.StatusCode == HttpStatusCode.OK) offset = 0;
            else if (response.StatusCode != HttpStatusCode.PartialContent
                || response.Content.Headers.ContentRange is not { Unit: "bytes" } range
                || range.From != offset || range.To != manifest.Bytes - 1 || range.Length != manifest.Bytes)
                throw new InvalidDataException("Invalid update download response.");
            if (response.Content.Headers.ContentLength is { } length && length != manifest.Bytes - offset)
                throw new InvalidDataException("Invalid update download length.");
            await using var input = await response.Content.ReadAsStreamAsync(cancelToken);
            await using var output = new FileStream(partial, offset == 0 ? FileMode.Create : FileMode.Append,
                FileAccess.Write, FileShare.None, 131072, true);
            byte[] buffer = new byte[131072];
            int count;
            while ((count = await input.ReadAsync(buffer, cancelToken)) > 0)
            {
                offset += count;
                if (offset > manifest.Bytes) throw new InvalidDataException("Update download exceeds signed size.");
                await output.WriteAsync(buffer.AsMemory(0, count), cancelToken);
                progress((int)(offset * 100 / manifest.Bytes));
            }
        }
        try { await manifest.VerifyPackageAsync(partial, cancelToken); }
        catch (InvalidDataException) { File.Delete(partial); throw; }
        File.Copy(partial, localFile, true);
        File.Delete(partial);
    }
}

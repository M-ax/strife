using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Velopack;

namespace Strife;

public sealed record UpdateEnvelope(string Payload, string Signature);
public sealed record DotNetFrameworkRequirement(string Name, string Version)
{
    internal static bool TryVersion(string? text, out System.Version? version)
    {
        version = null;
        return Regex.IsMatch(text ?? "", @"\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z")
            && System.Version.TryParse(text, out version);
    }

    public static bool Valid(IReadOnlyList<DotNetFrameworkRequirement>? requirements) =>
        requirements is { Count: 2 }
        && requirements.All(r => r is not null
            && r.Name is "Microsoft.NETCore.App" or "Microsoft.AspNetCore.App"
            && TryVersion(r.Version, out _))
        && requirements.Select(r => r.Name).Distinct(StringComparer.Ordinal).Count() == 2;

    // Installed versions must come from the target architecture's shared frameworks,
    // never Environment.Version (which can describe our private self-contained runtime).
    public static bool Satisfied(IReadOnlyList<DotNetFrameworkRequirement>? requirements,
        Func<string, IEnumerable<string>> installedVersions) =>
        Valid(requirements) && requirements!.All(r =>
        {
            TryVersion(r.Version, out var required);
            return installedVersions(r.Name).Any(text => TryVersion(text, out var installed)
                && installed!.Major == required!.Major && installed.Minor == required.Minor
                && installed.Build >= required.Build);
        });
}

public sealed record UpdateManifest(int Schema, string Channel, string Version, string FileName,
    long Bytes, string Sha256, string SourceRef, DateTimeOffset IssuedAt, DateTimeOffset ExpiresAt,
    int MinimumWindowsBuild, string MinimumVcRuntime, DotNetFrameworkRequirement[]? DotNetFrameworks = null)
{
    public const int MaximumEnvelopeBytes = 32768;
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static string PublicKey()
    {
        using var stream = typeof(UpdateManifest).Assembly.GetManifestResourceStream("Strife.update-key.pem")!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    public static UpdateManifest Verify(ReadOnlySpan<byte> envelopeBytes, string publicKey,
        string channel, DateTimeOffset now, DateTimeOffset? highWater = null, bool requireFresh = true)
    {
        if (envelopeBytes.Length > MaximumEnvelopeBytes) throw new InvalidDataException("Update metadata is too large.");
        var envelope = JsonSerializer.Deserialize<UpdateEnvelope>(envelopeBytes, Json)
            ?? throw new InvalidDataException("Missing update metadata.");
        byte[] payload = Convert.FromBase64String(envelope.Payload);
        using var key = RSA.Create();
        key.ImportFromPem(publicKey);
        if (!key.VerifyData(payload, Convert.FromBase64String(envelope.Signature), HashAlgorithmName.SHA256, RSASignaturePadding.Pss))
            throw new InvalidDataException("Update signature is invalid.");
        var manifest = JsonSerializer.Deserialize<UpdateManifest>(payload, Json)
            ?? throw new InvalidDataException("Missing update payload.");
        if (!(manifest.Schema == 1 ? manifest.DotNetFrameworks is null
                : manifest.Schema == 2 && DotNetFrameworkRequirement.Valid(manifest.DotNetFrameworks))
            || channel is not ("stable" or "preview") || manifest.Channel != channel
            || manifest.IssuedAt > now.AddMinutes(10) || requireFresh && manifest.ExpiresAt <= now
            || manifest.ExpiresAt <= manifest.IssuedAt || manifest.ExpiresAt > manifest.IssuedAt.AddDays(45)
            || highWater is { } previous && manifest.IssuedAt < previous
            || !Regex.IsMatch(manifest.Version ?? "", @"^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$")
            || channel == "stable" && manifest.Version!.Contains('-')
            || manifest.FileName != $"Strife-{manifest.Version}-full.nupkg"
            || manifest.Bytes is < 1 or > 1_073_741_824
            || !Regex.IsMatch(manifest.Sha256 ?? "", "^[a-f0-9]{64}$")
            || !Regex.IsMatch(manifest.SourceRef ?? "", "^[a-f0-9]{40}$")
            || manifest.MinimumWindowsBuild < 19041
            || !System.Version.TryParse(manifest.MinimumVcRuntime, out _))
            throw new InvalidDataException("Update metadata is expired, replayed, or incompatible.");
        _ = SemanticVersion.Parse(manifest.Version!);
        return manifest;
    }

    public VelopackAsset Asset() => new()
    {
        PackageId = "Strife", Version = SemanticVersion.Parse(Version), Type = VelopackAssetType.Full,
        // Velopack compares SHA-256 using ordinal uppercase hex.
        FileName = FileName, Size = Bytes, SHA256 = Sha256.ToUpperInvariant()
    };

    public async Task VerifyPackageAsync(string path, CancellationToken token = default)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 131072, true);
        if (stream.Length != Bytes || !Convert.ToHexString(await SHA256.HashDataAsync(stream, token).ConfigureAwait(false))
            .Equals(Sha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Update package verification failed.");
    }
}

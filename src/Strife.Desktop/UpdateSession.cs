using System.Text.Json;
using Velopack.Locators;

namespace Strife;

// All installed profiles share this guard. A second profile must not keep files
// loaded while the first profile hands the installation to Update.exe.
public sealed class UpdateSession : IDisposable
{
    public static string Cache => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Strife", "updates");
    private FileStream? handle;
    public bool Allowed { get; private set; } = true;
    private sealed record Applying(string Version, DateTimeOffset Until);

    public UpdateSession()
    {
        var locator = VelopackLocator.Current;
        if (!OperatingSystem.IsWindows() || locator.CurrentlyInstalledVersion is null || locator.IsPortable) return;
        try
        {
            Directory.CreateDirectory(Cache);
            handle = new FileStream(Path.Combine(Cache, "application.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            var marker = Path.Combine(Cache, "applying.json");
            if (!File.Exists(marker)) return;
            var applying = JsonSerializer.Deserialize<Applying>(File.ReadAllText(marker));
            // A new version can start immediately. An old version cannot race the
            // replacement helper; an abandoned attempt unlocks after its deadline.
            if (applying is not null && applying.Version != locator.CurrentlyInstalledVersion.ToString()
                && applying.Until > DateTimeOffset.UtcNow) Allowed = false;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException) { Allowed = false; }
    }

    public static void MarkApplying(string version, string cache) => File.WriteAllText(Path.Combine(cache, "applying.json"),
        JsonSerializer.Serialize(new Applying(version, DateTimeOffset.UtcNow.AddMinutes(3))));

    public void Dispose() => handle?.Dispose();
}

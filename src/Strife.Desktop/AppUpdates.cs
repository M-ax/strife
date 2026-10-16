using System.Text.Json;
using Microsoft.Win32;
using Velopack;
using Velopack.Locators;

namespace Strife;

public sealed record UpdateStatus(string State, string? Version = null, int Progress = 0, string? Error = null);

/// <summary>Quiet update policy; the replacement engine is deliberately separate.</summary>
public sealed class AppUpdates : IDisposable
{
    private readonly Action<string> publish;
    private readonly CancellationTokenSource lifetime = new();
    private readonly HttpClient http;
    private readonly string publicKey;
    private readonly TimeSpan initialDelay;
    private readonly string cache;
    private readonly string channel;
    private readonly SignedUpdateSource source;
    private readonly UpdateManager manager;
    private readonly object sync = new();
    private Task? worker;
    private UpdateStatus status = new("idle");
    private volatile UpdateManifest? ready;
    private UpdateManifest? exitUpdate;
    private bool restart;
    private bool stopped;
    private int attempts;
    private DateTimeOffset? highWater;
    public bool Available { get; }
    public UpdateStatus Status => status;

    public AppUpdates(Action<string> publish) : this(publish,
        new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromMinutes(20) },
        UpdateManifest.PublicKey(), UpdateSession.Cache, TimeSpan.FromSeconds(20)) { }

    // Dependency injection is limited to test assemblies; production cannot
    // override the trusted key, feed, or timing through arguments/preferences.
    internal AppUpdates(Action<string> publish, HttpClient http, string publicKey, string cache, TimeSpan initialDelay)
    {
        this.publish = publish;
        this.http = http;
        this.publicKey = publicKey;
        this.cache = cache;
        this.initialDelay = initialDelay;
        var version = VelopackLocator.Current.CurrentlyInstalledVersion?.ToString() ?? typeof(AppUpdates).Assembly.GetCustomAttributes(
            typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
            .Cast<System.Reflection.AssemblyInformationalVersionAttribute>().Single().InformationalVersion;
        channel = version.Split('+')[0].Contains('-') ? "preview" : "stable";
        source = new(http, Path.Combine(cache, "downloads"), channel);
        manager = new(source, new UpdateOptions { ExplicitChannel = channel, AllowVersionDowngrade = false });
        Available = OperatingSystem.IsWindows() && System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture == System.Runtime.InteropServices.Architecture.X64
            && manager.IsInstalled && !manager.IsPortable && manager.AppId == "Strife" && IsPerUserInstall();
    }

    public void Start()
    {
        if (!Available || worker is not null) return;
        worker = Task.Run(RunAsync);
    }

    public void Publish() => publish(JsonSerializer.Serialize(
        new { type = "update", available = Available, value = status }, UpdateManifest.Json));

    private void Set(UpdateStatus next)
    {
        lock (sync) { if (stopped) return; status = next; }
        Publish();
    }

    private async Task RunAsync()
    {
        try
        {
            Directory.CreateDirectory(cache);
            // Only a verified previous envelope may establish replay protection.
            var saved = Path.Combine(cache, channel + ".json");
            if (File.Exists(saved))
            {
                try
                {
                    var bytes = await File.ReadAllBytesAsync(saved, lifetime.Token);
                    var previous = UpdateManifest.Verify(bytes, publicKey, channel, DateTimeOffset.UtcNow, requireFresh: false);
                    highWater = previous.IssuedAt;
                    if (previous.ExpiresAt > DateTimeOffset.UtcNow && manager.CurrentVersion is { } current && SemanticVersion.Parse(previous.Version) > current)
                    {
                        var package = Path.Combine(VelopackLocator.Current.PackagesDir!, previous.FileName);
                        if (File.Exists(package))
                        {
                            await previous.VerifyPackageAsync(package, lifetime.Token);
                            if (Compatible(previous) && !AlreadyAttempted(previous)) MarkReady(previous);
                        }
                    }
                }
                catch (Exception e) when (IsUpdateFailure(e)) { Log(e); }
            }
            await Task.Delay(initialDelay, lifetime.Token);
            while (!lifetime.IsCancellationRequested)
            {
                try
                {
                    if (ready is null) Set(new("checking"));
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                    timeout.CancelAfter(TimeSpan.FromSeconds(30));
                    using var response = await http.GetAsync(new Uri(SignedUpdateSource.Origin,
                        $"updates/windows-{channel}.json"), HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                    response.EnsureSuccessStatusCode();
                    await using var input = await response.Content.ReadAsStreamAsync(timeout.Token);
                    using var data = new MemoryStream();
                    byte[] buffer = new byte[4096];
                    int count;
                    while ((count = await input.ReadAsync(buffer, timeout.Token)) > 0)
                    {
                        if (data.Length + count > UpdateManifest.MaximumEnvelopeBytes)
                            throw new InvalidDataException("Update metadata is too large.");
                        data.Write(buffer, 0, count);
                    }
                    var bytes = data.ToArray();
                    var manifest = UpdateManifest.Verify(bytes, publicKey, channel, DateTimeOffset.UtcNow, highWater);
                    highWater = manifest.IssuedAt;
                    await File.WriteAllBytesAsync(saved + ".tmp", bytes, lifetime.Token);
                    File.Move(saved + ".tmp", saved, true);
                    source.Manifest = manifest;
                    var update = await manager.CheckForUpdatesAsync();
                    if (update is null)
                    {
                        ready = null;
                        Set(new("current"));
                    }
                    else if (!Compatible(manifest))
                    {
                        ready = null;
                        Set(new("manual", manifest.Version, Error: "This update needs a newer Windows or Microsoft runtime. Install it from strife.zip."));
                    }
                    else if (AlreadyAttempted(manifest))
                    {
                        ready = null;
                        Set(new("manual", manifest.Version, Error: "The last installation did not complete. Run the installer from strife.zip to repair Strife."));
                    }
                    else
                    {
                        if (ready?.Sha256 != manifest.Sha256)
                        {
                            ready = null;
                            Set(new("downloading", manifest.Version));
                            var existing = Path.Combine(VelopackLocator.Current.PackagesDir!, manifest.FileName);
                            if (File.Exists(existing))
                            {
                                try { await manifest.VerifyPackageAsync(existing, lifetime.Token); }
                                catch (InvalidDataException) { File.Delete(existing); }
                            }
                            await manager.DownloadUpdatesAsync(update, progress => Set(new("downloading", manifest.Version, progress)), lifetime.Token);
                            await manifest.VerifyPackageAsync(Path.Combine(VelopackLocator.Current.PackagesDir!, manifest.FileName), lifetime.Token);
                        }
                        MarkReady(manifest);
                    }
                    attempts = 0;
                }
                catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { break; }
                catch (Exception e) when (IsUpdateFailure(e))
                {
                    Log(e);
                    if (ready is null) Set(new("error", Error: "Updates could not be checked or downloaded. Strife will retry quietly."));
                    attempts++;
                }
                var delay = attempts == 0 ? TimeSpan.FromHours(6)
                    : TimeSpan.FromMinutes(Math.Min(360, 5 * Math.Pow(2, Math.Min(attempts - 1, 7))));
                await Task.Delay(delay, lifetime.Token);
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception e) when (IsUpdateFailure(e)) { Log(e); Set(new("error", Error: "Automatic updates are unavailable. Use the installer from strife.zip.")); }
    }

    private void MarkReady(UpdateManifest manifest)
    {
        lock (sync)
        {
            if (stopped) return;
            ready = manifest;
            Set(new("ready", manifest.Version, 100));
        }
    }

    // A click never interrupts a call while downloading. The button becomes
    // actionable only after a complete package has passed verification.
    public bool RequestRestart()
    {
        lock (sync)
        {
            if (stopped || ready is null) return false;
            restart = true;
            Stop();
        }
        return true;
    }

    public void Stop()
    {
        lock (sync)
        {
            if (stopped) return;
            exitUpdate = ready;
            stopped = true;
        }
        lifetime.Cancel();
    }

    // Called only after app.Run returns normally and owned children have stopped.
    // Never called from crash handlers or OS session-end callbacks.
    public void ApplyOnExit()
    {
        Stop();
        if (!Available || exitUpdate is not { } manifest) return;
        try
        {
            if (DateTimeOffset.UtcNow >= manifest.ExpiresAt || AlreadyAttempted(manifest)) return;
            manifest.VerifyPackageAsync(Path.Combine(VelopackLocator.Current.PackagesDir!, manifest.FileName)).GetAwaiter().GetResult();
            File.WriteAllText(Path.Combine(cache, "attempted.txt"), manifest.Sha256);
            UpdateSession.MarkApplying(manifest.Version, cache);
            manager.WaitExitThenApplyUpdates(manifest.Asset(), silent: true, restart: restart);
        }
        catch (Exception e) when (IsUpdateFailure(e)) { Log(e); }
    }

    private bool AlreadyAttempted(UpdateManifest manifest) =>
        File.Exists(Path.Combine(cache, "attempted.txt")) && File.ReadAllText(Path.Combine(cache, "attempted.txt")) == manifest.Sha256;

    private static bool Compatible(UpdateManifest manifest)
    {
        if (!OperatingSystem.IsWindows() || Environment.OSVersion.Version.Build < manifest.MinimumWindowsBuild) return false;
        using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var runtime = machine.OpenSubKey(@"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64");
        return runtime?.GetValue("Installed") is int installed && installed == 1
            && System.Version.TryParse((runtime.GetValue("Version") as string)?.TrimStart('v'), out var version)
            && version >= System.Version.Parse(manifest.MinimumVcRuntime);
    }

    private static bool IsPerUserInstall()
    {
        if (!OperatingSystem.IsWindows()) return false;
        var locator = VelopackLocator.Current;
        using var registration = Registry.CurrentUser.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Strife");
        var location = registration?.GetValue("InstallLocation") as string;
        // A copied/portable tree or a machine-wide installation must not gain
        // unattended execution through Velopack's writable-cache fallback.
        return location is not null && locator.RootAppDir is not null
            && Path.GetFullPath(location).TrimEnd(Path.DirectorySeparatorChar).Equals(
                Path.GetFullPath(locator.RootAppDir).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)
            && string.Equals(locator.PackagesDir, Path.Combine(locator.RootAppDir, "packages"), StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsUpdateFailure(Exception e) => e is IOException or UnauthorizedAccessException
        or HttpRequestException or OperationCanceledException or JsonException or FormatException
        or System.Security.Cryptography.CryptographicException or ArgumentException or InvalidOperationException
        or System.ComponentModel.Win32Exception or TimeoutException
        || e.GetType().Namespace?.StartsWith("Velopack.", StringComparison.Ordinal) == true;

    private void Log(Exception error)
    {
        try { Directory.CreateDirectory(cache); File.WriteAllText(Path.Combine(cache, "last-error.txt"),
            $"{DateTimeOffset.UtcNow:O} {error.GetType().Name}: {error.Message}"); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    public void Dispose() { Stop(); /* Do not wait for a network operation while quitting. */ }
}

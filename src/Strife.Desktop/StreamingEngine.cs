using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Strife;

// A separate owned process: inherited stdio pipes carry commands/credentials, not a TCP API.
public sealed partial class StreamingEngine : IAsyncDisposable
{
    private Process? process;
    private readonly SemaphoreSlim gate = new(1);
    private string? shareId;
    private readonly HashSet<string> sources = [];
    public static string FindExecutable()
    {
        var configured = Environment.GetEnvironmentVariable("STRIFE_STREAM_ENGINE");
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
        var packaged = Path.Combine(AppContext.BaseDirectory, "streaming", "bin", "64bit", "strife-stream.exe");
        if (File.Exists(packaged)) return packaged;
        for (var current = new DirectoryInfo(AppContext.BaseDirectory); current is not null; current = current.Parent)
        {
            var candidate = Path.Combine(current.FullName, "artifacts", "streaming", "bin", "64bit", "strife-stream.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return packaged;
    }
    public bool Available => OperatingSystem.IsWindows() && File.Exists(FindExecutable());

    public static string IngestAddress(string server, string roomId, string path, string bearer, long expires)
    {
        if (!Identifier().IsMatch(roomId) || path != "/api/whip/" + Uri.EscapeDataString(roomId) ||
            !Bearer().IsMatch(bearer) || expires <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            throw new ArgumentException("The room publishing credential is invalid or expired.");
        var origin = PreferencesStore.ValidateHelltubeUrl(server);
        if (origin.Scheme != "https" && !origin.IsLoopback)
            throw new ArgumentException("Native sharing requires HTTPS, or a local development server.");
        return origin.GetLeftPart(UriPartial.Authority) + path;
    }

    public async Task<JsonObject> SourcesAsync(string id)
    {
        if (!Identifier().IsMatch(id)) throw new ArgumentException("Invalid sharing request.");
        await gate.WaitAsync();
        try
        {
            await StopCoreAsync();
            if (!Available) throw new InvalidOperationException("Native sharing is not installed for this platform.");
            var executable = FindExecutable();
            process = Process.Start(new ProcessStartInfo(executable) {
                WorkingDirectory = Path.GetDirectoryName(executable)!, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            }) ?? throw new IOException("Cannot start native sharing.");
            // Drain diagnostics without persisting potentially sensitive source/endpoint details.
            process.ErrorDataReceived += (_, _) => { };
            process.BeginErrorReadLine();
            shareId = id;
            var result = await ExchangeAsync(new { command = "sources" });
            foreach (var source in result["sources"]!.AsArray()) sources.Add(source!["id"]!.GetValue<string>());
            return result;
        }
        catch { await StopCoreAsync(); throw; }
        finally { gate.Release(); }
    }

    public async Task<JsonObject> StartAsync(string id, string sourceId, bool audio, string server, JsonObject credential)
    {
        await gate.WaitAsync();
        try
        {
            if (id != shareId || !sources.Contains(sourceId)) throw new ArgumentException("Choose the screen again.");
            var bearer = credential["token"]!.GetValue<string>();
            var endpoint = IngestAddress(server, credential["roomId"]!.GetValue<string>(), credential["path"]!.GetValue<string>(),
                bearer, credential["expires"]!.GetValue<long>());
            return await ExchangeAsync(new {command = "start", sourceId, audio, server = endpoint, bearer_token = bearer});
        }
        catch { await StopCoreAsync(); throw; }
        finally { gate.Release(); }
    }

    public async Task<JsonObject> StatusAsync()
    {
        await gate.WaitAsync();
        try { return process is null ? new JsonObject { ["status"] = "idle" } : await ExchangeAsync(new { command = "status" }); }
        catch { await StopCoreAsync(); return new JsonObject { ["status"] = "error", ["error"] = "Native sharing stopped unexpectedly." }; }
        finally { gate.Release(); }
    }
    private async Task<JsonObject> ExchangeAsync(object command)
    {
        if (process is null || process.HasExited) throw new IOException("Native sharing stopped unexpectedly.");
        await process.StandardInput.WriteLineAsync(System.Text.Json.JsonSerializer.Serialize(command));
        await process.StandardInput.FlushAsync();
        var line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15));
        if (line is null || line.Length > 128 * 1024 || JsonNode.Parse(line) is not JsonObject result) throw new IOException("Invalid native sharing response.");
        if (result["ok"]?.GetValue<bool>() != true) throw new InvalidOperationException(result["error"]?.GetValue<string>() ?? "Native sharing failed.");
        return result;
    }
    public async Task StopAsync()
    {
        await gate.WaitAsync();
        try { await StopCoreAsync(); }
        finally { gate.Release(); }
    }
    private async Task StopCoreAsync()
    {
        var child = process; process = null; shareId = null; sources.Clear();
        if (child is null) return;
        try
        {
            // EOF stops the output and sends WHIP DELETE, including when the host crashes.
            child.StandardInput.Close();
            await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException)
        { if (!child.HasExited) child.Kill(entireProcessTree: true); }
        finally { child.Dispose(); }
    }
    public async ValueTask DisposeAsync() => await StopAsync();
    [GeneratedRegex("^[A-Za-z0-9_-]{1,128}$")]
    private static partial Regex Identifier();
    [GeneratedRegex("^[a-fA-F0-9]{64}$")]
    private static partial Regex Bearer();
}

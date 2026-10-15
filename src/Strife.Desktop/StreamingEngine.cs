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
    private readonly HashSet<string> audioTargets = [];
    private readonly HashSet<string> encoders = [];
    private bool publishingStarted;
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

    public static string IngestAddress(string server, string roomId, string path, string bearer, long? expires)
    {
        if (!Identifier().IsMatch(roomId) || path != "/api/whip/" + Uri.EscapeDataString(roomId) ||
            !Bearer().IsMatch(bearer) || (expires.HasValue && expires.Value <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))
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
            if (result["qualityVersion"]?.GetValue<int>() != 3 || result["audioVersion"]?.GetValue<int>() != 1 ||
                result["previewVersion"]?.GetValue<int>() != 1)
                throw new InvalidOperationException("Rebuild the native sharing helper to use quality and audio selection.");
            foreach (var source in result["sources"]!.AsArray()) sources.Add(source!["id"]!.GetValue<string>());
            foreach (var target in result["audioTargets"]!.AsArray()) audioTargets.Add(target!["id"]!.GetValue<string>());
            foreach (var encoder in result["encoders"]!.AsArray())
                if (encoder!["available"]?.GetValue<bool>() == true) encoders.Add(encoder["id"]!.GetValue<string>());
            result["quality"] = StreamingQuality.Describe();
            return result;
        }
        catch { await StopCoreAsync(); throw; }
        finally { gate.Release(); }
    }

    public async Task<JsonObject> StartAsync(string id, string sourceId, string audioId, string server, JsonObject credential,
        string? qualityId, JsonObject? customQuality = null, int audioBitrateKbps = 128, string encoderId = "obs_x264")
    {
        await gate.WaitAsync();
        try
        {
            if (id != shareId || !sources.Contains(sourceId)) throw new ArgumentException("Choose the screen again.");
            if (audioId.Length != 0 && !audioTargets.Contains(audioId)) throw new ArgumentException("Choose the audio target again.");
            if (!encoders.Contains(encoderId)) throw new ArgumentException("Choose an available video encoder.");
            var quality = StreamingQuality.Select(qualityId, credential["publishing"]?.AsObject(), customQuality);
            StreamingQuality.ValidateAudio(audioBitrateKbps, credential["publishing"]?.AsObject());
            if (!credential.ContainsKey("expires")) throw new ArgumentException("The publishing credential has no expiry contract.");
            var bearer = credential["token"]!.GetValue<string>();
            var endpoint = IngestAddress(server, credential["roomId"]!.GetValue<string>(), credential["path"]!.GetValue<string>(),
                bearer, credential["expires"]?.GetValue<long>());
            publishingStarted = true;
            return await ExchangeAsync(new {command = "start", sourceId, audioId, encoderId, audioBitrateKbps, server = endpoint, bearer_token = bearer,
                quality = new { width = quality.Width, height = quality.Height, fps = quality.Fps, bitrateKbps = quality.BitrateKbps }});
        }
        catch { await StopCoreAsync(); throw; }
        finally { gate.Release(); }
    }

    public async Task<JsonObject> PreviewAsync(string id, string sourceId, string audioId, string qualityId,
        JsonObject? customQuality, JsonObject? publishing, int audioBitrateKbps, string encoderId, bool thumbnail)
    {
        await gate.WaitAsync();
        try
        {
            // Reject late preview work without stopping an already-started stream.
            if (publishingStarted || id != shareId || !sources.Contains(sourceId))
                throw new ArgumentException("This source selection is no longer active.");
            if ((audioId.Length != 0 && !audioTargets.Contains(audioId)) || !encoders.Contains(encoderId))
                throw new ArgumentException("Choose an available audio target and encoder.");
            var quality = StreamingQuality.Select(qualityId, publishing, customQuality);
            StreamingQuality.ValidateAudio(audioBitrateKbps, publishing);
            return await ExchangeAsync(new { command = thumbnail ? "thumbnail" : "preview", sourceId,
                audioId = thumbnail ? "" : audioId, encoderId, audioBitrateKbps,
                quality = new { width = quality.Width, height = quality.Height, fps = quality.Fps, bitrateKbps = quality.BitrateKbps } });
        }
        finally { gate.Release(); }
    }

    public async Task<JsonObject> StatusAsync()
    {
        await gate.WaitAsync();
        try { return process is null ? new JsonObject { ["status"] = "idle" } : await ExchangeAsync(new { command = "status" }); }
        catch { await StopCoreAsync(); return new JsonObject { ["status"] = "error", ["error"] = "Native sharing stopped unexpectedly." }; }
        finally { gate.Release(); }
    }
    public async Task StopPreviewAsync(string id)
    {
        await gate.WaitAsync();
        try { if (process is not null && shareId == id && !publishingStarted) await ExchangeAsync(new { command = "stop" }); }
        finally { gate.Release(); }
    }
    private async Task<JsonObject> ExchangeAsync(object command)
    {
        if (process is null || process.HasExited) throw new IOException("Native sharing stopped unexpectedly.");
        await process.StandardInput.WriteLineAsync(System.Text.Json.JsonSerializer.Serialize(command));
        await process.StandardInput.FlushAsync();
        var line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15));
        if (line is null || line.Length > 512 * 1024 || JsonNode.Parse(line) is not JsonObject result) throw new IOException("Invalid native sharing response.");
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
        var child = process; process = null; shareId = null; sources.Clear(); audioTargets.Clear(); encoders.Clear(); publishingStarted = false;
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

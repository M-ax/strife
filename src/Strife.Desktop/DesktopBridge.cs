using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Strife;

public sealed class DesktopBridge(PreferencesStore preferences, VoiceEngine voice, Uri origin, Action<string> publish,
    Action? close = null, Func<string, Task<string>>? loadVideo = null) : IDisposable
{
    public string Token { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private readonly SemaphoreSlim gate = new(1);
    private readonly MumbleImport importer = new(preferences.DirectoryPath);
    private PreparedImport? preparedImport;
    private static readonly HashSet<string> VoiceCommands =
        ["disconnect", "join", "chat", "openLink", "mute", "deafen", "settings", "wizard", "certificate"];

    public bool IsTrusted(Uri? uri, string? token) =>
        uri is { IsAbsoluteUri: true } && uri.GetLeftPart(UriPartial.Path) == origin.AbsoluteUri && token == Token;

    private void Send(object value) => publish(JsonSerializer.Serialize(value, PreferencesStore.Json));

    public async Task ReceiveAsync(Uri? source, string text)
    {
        if (text.Length > 32768) return;
        JsonObject? message;
        try { message = JsonNode.Parse(text) as JsonObject; }
        catch (JsonException) { return; }
        if (message?["token"] is not JsonValue tokenValue || !tokenValue.TryGetValue<string>(out var token)
            || !IsTrusted(source, token)) return;
        if (message["id"] is not JsonValue idValue || !idValue.TryGetValue<string>(out var id) || id.Length > 64) return;
        await gate.WaitAsync();
        try
        {
            var command = message["command"]?.GetValue<string>() ?? "";
            if (command == "quit")
            {
                Send(new { type = "result", id, ok = true });
                close?.Invoke();
            }
            else if (command == "ready")
            {
                Send(new { type = "preferences", value = preferences.Current,
                    videoUrl = loadVideo is null ? preferences.Current.HelltubeUrl : await loadVideo(preferences.Current.HelltubeUrl) });
                if (voice.LastState is { } state) publish(state.GetRawText());
                if (voice.LastLog is { } log) publish(log.GetRawText());
                Send(new { type = "engine", ready = voice.IsReady, error = voice.Failure });
                Send(new { type = "result", id, ok = true });
            }
            else if (command == "start")
            {
                await voice.StartAsync();
                Send(new { type = "engine", ready = true });
                Send(new { type = "result", id, ok = true });
            }
            else if (command == "fonts")
                Send(new { type = "result", id, ok = true, batch = SystemFontCatalog.Shared.Read(message["offset"]?.GetValue<int>() ?? 0) });
            else if (command == "preferences")
            {
                var url = message["helltubeUrl"]?.GetValue<string>() ?? preferences.Current.HelltubeUrl;
                preferences.Save(preferences.Current with
                {
                    HelltubeUrl = PreferencesStore.ValidateHelltubeUrl(url).AbsoluteUri,
                    ChatCollapsed = message["chatCollapsed"]?.GetValue<bool>() ?? preferences.Current.ChatCollapsed,
                    WorkspaceLayout = message["workspaceLayout"] is { } layout
                        ? layout is JsonObject && layout.ToJsonString().Length <= 8192
                            ? JsonSerializer.SerializeToElement(layout)
                            : throw new ArgumentException("Invalid workspace layout.")
                        : preferences.Current.WorkspaceLayout,
                    Appearance = message["appearance"] is { } appearance
                        ? appearance.Deserialize<AppearancePreferences>(PreferencesStore.Json)
                            ?? throw new ArgumentException("Invalid appearance settings.")
                        : preferences.Current.Appearance
                });
                Send(new { type = "preferences", value = preferences.Current,
                    videoUrl = loadVideo is null ? preferences.Current.HelltubeUrl : await loadVideo(preferences.Current.HelltubeUrl) });
                Send(new { type = "result", id, ok = true });
            }
            else if (command == "importDiscover")
                Send(new { type = "result", id, ok = true, sources = MumbleImport.Discover() });
            else if (command == "importPreview")
            {
                preparedImport?.Dispose();
                preparedImport = null;
                preparedImport = await importer.PrepareAsync(message["settingsSource"]?.GetValue<string>() ?? "",
                    message["databaseSource"]?.GetValue<string>() ?? "", voice.ReadImportSettingsAsync);
                Send(new { type = "result", id, ok = true, preview = preparedImport.Summary });
            }
            else if (command == "importCancel")
            {
                preparedImport?.Dispose();
                preparedImport = null;
                Send(new { type = "result", id, ok = true });
            }
            else if (command == "importApply")
            {
                if (preparedImport is null || message["previewId"]?.GetValue<string>() != preparedImport.Id)
                    throw new ArgumentException("Review the import again before applying it.");
                if (voice.IsReady) await voice.EnsureImportReadyAsync();
                var selection = new ImportSelection(message["settings"]?.GetValue<bool>() ?? false,
                    message["database"]?.GetValue<bool>() ?? false, message["identity"]?.GetValue<bool>() ?? false);
                string backup;
                try
                {
                    backup = await importer.ApplyAsync(preparedImport, selection, async () =>
                    {
                        await voice.StopAsync();
                        Send(new { type = "engine", ready = false });
                    }, voice.StartAsync);
                }
                finally { Send(new { type = "engine", ready = voice.IsReady, error = voice.Failure }); }
                preparedImport.Dispose();
                preparedImport = null;
                Send(new { type = "result", id, ok = true, backup });
            }
            else if (command == "savedServers")
                Send(new { type = "result", id, ok = true, servers = importer.GetServers() });
            else if (command == "connect")
            {
                var host = message["host"]!.GetValue<string>();
                var port = message["port"]!.GetValue<int>();
                var username = message["username"]!.GetValue<string>();
                var password = message["password"]?.GetValue<string>() ?? "";
                if (message["savedServerId"] is { } savedId)
                {
                    var saved = importer.GetServer(savedId.GetValue<long>());
                    if (host != saved.Server.Host || port != saved.Server.Port || username != saved.Server.Username)
                        throw new ArgumentException("Select the saved server again or use a manual connection.");
                    if (password.Length == 0) password = saved.Password;
                }
                var url = PreferencesStore.MumbleUrl(host, port, username, password);
                preferences.Save(preferences.Current with { MumbleHost = host.Trim(), MumblePort = port, Username = username.Trim() });
                Send(new { type = "preferences", value = preferences.Current });
                if (!voice.IsReady) throw new InvalidOperationException("Voice engine is not ready.");
                await voice.SendAsync(new { command, id, url });
            }
            else if (VoiceCommands.Contains(command))
            {
                message.Remove("token");
                await voice.SendAsync(message);
            }
            else throw new ArgumentException("Unknown Strife command.");
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or IOException or System.ComponentModel.Win32Exception
            or OperationCanceledException or JsonException or NullReferenceException or PlatformNotSupportedException
            or Microsoft.Data.Sqlite.SqliteException or UnauthorizedAccessException or TimeoutException)
        {
            Send(new { type = "result", id, ok = false, error = e is OperationCanceledException ? "Voice engine startup timed out." : e.Message });
        }
        finally { gate.Release(); }
    }

    public void Dispose() => preparedImport?.Dispose();
}

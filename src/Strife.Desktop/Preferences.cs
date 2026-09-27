using System.Text.Json;

namespace Strife;

public sealed record Preferences(string HelltubeUrl = "http://127.0.0.1:3000",
    string MumbleHost = "", int MumblePort = 64738, string Username = "", bool ChatCollapsed = false,
    JsonElement? WorkspaceLayout = null);

public sealed class PreferencesStore(string directory)
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public string DirectoryPath { get; } = directory;
    public Preferences Current { get; private set; } = new();
    private readonly string path = Path.Combine(directory, "preferences.json");

    public void Load()
    {
        Directory.CreateDirectory(DirectoryPath);
        if (!File.Exists(path)) return;
        try
        {
            var value = JsonSerializer.Deserialize<Preferences>(File.ReadAllText(path), Json) ?? new();
            ValidateHelltubeUrl(value.HelltubeUrl);
            Current = value;
        }
        catch (Exception e) when (e is JsonException or ArgumentException) { Current = new(); }
    }

    public void Save(Preferences value)
    {
        ValidateHelltubeUrl(value.HelltubeUrl);
        Directory.CreateDirectory(DirectoryPath);
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(value, Json));
        File.Move(temporary, path, true);
        Current = value;
    }

    public static Uri ValidateHelltubeUrl(string value)
    {
        if (value.Length > 4096 || !Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || (uri.Scheme != "http" && uri.Scheme != "https") || string.IsNullOrEmpty(uri.Host)
            || !string.IsNullOrEmpty(uri.UserInfo))
            throw new ArgumentException("Enter an HTTP or HTTPS Helltube URL without embedded credentials.");
        return uri;
    }

    public static string MumbleUrl(string host, int port, string username, string password)
    {
        host = host.Trim();
        username = username.Trim();
        if (string.IsNullOrWhiteSpace(host) || host.Length > 253 || host.Any(char.IsWhiteSpace)
            || host.IndexOfAny(['/', '\\', '@', '?', '#']) >= 0 || port is < 1 or > 65535
            || string.IsNullOrWhiteSpace(username) || username.Length > 128 || password.Length > 1024)
            throw new ArgumentException("Enter a server hostname, port (1–65535), and username.");
        var builder = new UriBuilder("mumble", host, port)
        {
            UserName = Uri.EscapeDataString(username),
            Password = Uri.EscapeDataString(password),
            Query = "version=1.2.0"
        };
        return builder.Uri.AbsoluteUri;
    }
}

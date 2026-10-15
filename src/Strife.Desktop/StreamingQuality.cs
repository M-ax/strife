using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Strife;

// One catalog drives the picker and host validation. Native code independently
// validates the bounded numeric configuration before allocating capture resources.
public static class StreamingQuality
{
    public sealed record Preset(string Id, string Resolution, int Width, int Height, int Fps, int BitrateKbps, bool Enabled)
    {
        public string Label => $"{Resolution}{Fps} {(BitrateKbps / 1000m).ToString("0.#", CultureInfo.InvariantCulture)} Mbps";
    }
    private sealed record Catalog(int Version, string DefaultPreset, Preset[] Presets);
    private static readonly Catalog catalog = Load();
    public static string DefaultPreset => catalog.DefaultPreset;
    public static IReadOnlyList<Preset> Presets { get; } = Array.AsReadOnly(catalog.Presets);
    private static Catalog Load()
    {
        using var stream = typeof(StreamingQuality).Assembly.GetManifestResourceStream("Strife.streaming-quality.json")
            ?? throw new InvalidOperationException("Missing streaming quality catalog.");
        return JsonSerializer.Deserialize<Catalog>(stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("Invalid streaming quality catalog.");
    }
    public static bool Supported(Preset preset, JsonObject? publishing)
    {
        if (publishing is null) return preset.Width <= 1920 && preset.Height <= 1080 && preset.BitrateKbps <= 12000;
        static int Number(JsonObject value, string name) =>
            value[name] is JsonValue number && number.TryGetValue<int>(out var result) ? result : 0;
        return Number(publishing, "version") == 1 && publishing["codec"]?.ToString() == "h264"
            && publishing["profile"]?.ToString() == "baseline" && publishing["level"]?.ToString() == "5.2"
            && preset.Width <= Number(publishing, "width") && preset.Height <= Number(publishing, "height")
            && preset.Fps <= Number(publishing, "fps") && preset.BitrateKbps <= Number(publishing, "bitrateKbps");
    }
    public static void ValidateAudio(int bitrate, JsonObject? publishing)
    {
        if (bitrate is not (64 or 96 or 128 or 160 or 192) ||
            (publishing?["audioBitrateKbps"] is JsonValue value && (!value.TryGetValue<int>(out var limit) || bitrate > limit)))
            throw new ArgumentException("Choose a supported audio bitrate.");
    }
    public static Preset Select(string? id, JsonObject? publishing = null, JsonObject? custom = null)
    {
        Preset? preset;
        if (id == "custom")
        {
            static int Number(JsonObject? value, string key) =>
                value?[key] is JsonValue number && number.TryGetValue<int>(out var n) ? n : 0;
            var width = Number(custom, "width"); var height = Number(custom, "height");
            var fps = Number(custom, "fps"); var bitrate = Number(custom, "bitrateKbps");
            var resolution = Presets.FirstOrDefault(p => p.Width == width && p.Height == height)?.Resolution;
            if (resolution is null || fps is not (15 or 30 or 60) || bitrate < 500 || bitrate > 40000 || bitrate % 100 != 0)
                throw new ArgumentException("Invalid custom streaming quality.");
            preset = new("custom", resolution, width, height, fps, bitrate, true);
        }
        else preset = Presets.SingleOrDefault(p => p.Id == id);
        if (preset is null || !preset.Enabled || !Supported(preset, publishing))
            throw new ArgumentException("Choose an available streaming quality preset.");
        return preset;
    }
    public static JsonObject Describe() => new()
    {
        ["version"] = catalog.Version,
        ["defaultPreset"] = DefaultPreset,
        ["presets"] = new JsonArray(Presets.Select(p => (JsonNode)new JsonObject
        {
            ["id"] = p.Id, ["label"] = p.Label, ["enabled"] = p.Enabled,
            ["resolution"] = p.Resolution,
            ["width"] = p.Width, ["height"] = p.Height, ["fps"] = p.Fps, ["bitrateKbps"] = p.BitrateKbps,
            ["reason"] = "The server does not advertise support for this quality."
        }).ToArray())
    };
}

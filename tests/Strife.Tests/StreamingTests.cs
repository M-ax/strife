using Strife;
using System.Text.Json.Nodes;

internal static class StreamingTests
{
    public static async Task Run(Action<bool, string> check)
    {
        await using var engine = new StreamingEngine();
        check(engine.Available, "built streaming helper is available");
        var sources = await engine.SourcesAsync("managed-probe");
        var list = sources["sources"]!.AsArray();
        check(sources["quality"]!["defaultPreset"]!.GetValue<string>() == "1080p60", "owned helper supports the quality contract");
        check(list.Count > 0, "owned helper enumerates capture sources without publishing");
        check((await engine.StatusAsync())["status"]!.GetValue<string>() == "idle", "source picker does not start capturing or publishing");
        try
        {
            await engine.StartAsync("managed-probe", list[0]!["id"]!.GetValue<string>(), "", "https://video.example.test",
                new JsonObject { ["roomId"] = "lobby", ["path"] = "/api/whip/other", ["token"] = new string('a',64), ["expires"] = long.MaxValue },
                StreamingQuality.DefaultPreset);
            throw new Exception("Invalid destination accepted");
        }
        catch (ArgumentException) { check(true, "invalid credential stops helper before source activation"); }
        check((await engine.StatusAsync())["status"]!.GetValue<string>() == "idle", "failed start cleans up the owned helper");
        sources = await engine.SourcesAsync("managed-probe-2");
        check(!sources["sources"]!.AsArray().Any(s => list.Any(old => old!["id"]!.GetValue<string>() == s!["id"]!.GetValue<string>())),
            "helper restart invalidates all old source IDs");
        try
        {
            await engine.StartAsync("managed-probe-2", sources["sources"]![0]!["id"]!.GetValue<string>(), "", "https://video.example.test",
                new JsonObject { ["roomId"] = "lobby", ["path"] = "/api/whip/lobby", ["token"] = new string('a',64), ["expires"] = long.MaxValue },
                "4K60");
            throw new Exception("Disabled quality accepted");
        }
        catch (ArgumentException) { check(true, "disabled quality is rejected before native capture or publishing"); }
        check((await engine.StatusAsync())["status"]!.GetValue<string>() == "idle", "invalid quality cleans up the owned helper");
        sources = await engine.SourcesAsync("managed-probe-3");
        try
        {
            await engine.StartAsync("managed-probe-3", sources["sources"]![0]!["id"]!.GetValue<string>(), "forged-audio",
                "https://video.example.test", new JsonObject(), StreamingQuality.DefaultPreset);
            throw new Exception("Forged audio target accepted");
        }
        catch (ArgumentException) { check(true, "host rejects unenumerated audio before reading a credential"); }
        sources = await engine.SourcesAsync("managed-probe-4");
        if (Environment.GetEnvironmentVariable("STRIFE_STREAM_TEST_FIXTURE") is not null)
        {
            var sourceId = sources["sources"]![0]!["id"]!.GetValue<string>();
            var preview = await engine.PreviewAsync("managed-probe-4", sourceId, "", "1080p60", null, null, 128, "obs_x264", false);
            check(preview["status"]!.GetValue<string>() == "preview", "managed preview captures locally without publishing");
            check(preview["image"]!.GetValue<string>().StartsWith("data:image/bmp;base64,"), "bounded preview crosses managed IPC");
            check(preview["quality"]!["width"]!.GetValue<int>() <= 1920, "source-sized preview respects output limits");
            await engine.StopPreviewAsync("managed-probe-4");
            check((await engine.StatusAsync())["status"]!.GetValue<string>() == "idle", "preview cancellation releases capture without discarding enumeration");
        }
        await engine.StopAsync();
        check((await engine.StatusAsync())["status"]!.GetValue<string>() == "idle", "helper restarts and shuts down cleanly");
    }
}

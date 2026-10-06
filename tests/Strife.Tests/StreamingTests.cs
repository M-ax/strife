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
        check(list.Count > 0, "owned helper enumerates capture sources without publishing");
        check((await engine.StatusAsync())["status"]!.GetValue<string>() == "idle", "source picker does not start capturing or publishing");
        try
        {
            await engine.StartAsync("managed-probe", list[0]!["id"]!.GetValue<string>(), false, "https://video.example.test",
                new JsonObject { ["roomId"] = "lobby", ["path"] = "/api/whip/other", ["token"] = new string('a',64), ["expires"] = long.MaxValue });
            throw new Exception("Invalid destination accepted");
        }
        catch (ArgumentException) { check(true, "invalid credential stops helper before source activation"); }
        check((await engine.StatusAsync())["status"]!.GetValue<string>() == "idle", "failed start cleans up the owned helper");
        await engine.SourcesAsync("managed-probe-2");
        await engine.StopAsync();
        check((await engine.StatusAsync())["status"]!.GetValue<string>() == "idle", "helper restarts and shuts down cleanly");
    }
}

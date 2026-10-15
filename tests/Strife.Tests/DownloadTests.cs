using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Strife;

internal static class DownloadTests
{
    public static async Task Run(string temporary, Action<bool, string> check)
    {
        var directory = Path.Combine(temporary, "downloads");
        JsonElement state = default;
        using var manager = new DownloadManager(directory, message => state = JsonDocument.Parse(message).RootElement.Clone());
        check(DownloadManager.SafeName("../../CON.txt") == "_CON.txt" && DownloadManager.SafeName("a:b?.txt") == "a_b_.txt", "download filenames cannot escape the folder or use reserved Windows names");
        using var first = new ByteArrayContent([1, 2, 3]);
        await manager.SaveAsync(first, "../test.bin");
        using var second = new ByteArrayContent([4, 5]);
        await manager.SaveAsync(second, "test.bin");
        check(File.ReadAllBytes(Path.Combine(directory, "test.bin")).SequenceEqual(new byte[] {1, 2, 3})
            && File.ReadAllBytes(Path.Combine(directory, "test (1).bin")).SequenceEqual(new byte[] {4, 5}), "duplicate downloads preserve existing files");
        using var shortContent = new ByteArrayContent([1]);
        shortContent.Headers.ContentLength = 10;
        await manager.SaveAsync(shortContent, "short.bin");
        check(state.GetProperty("items")[2].GetProperty("state").GetString() == "failed" && !File.Exists(Path.Combine(directory, "short.bin")), "truncated download fails without publishing a partial file");
        DownloadManager? cancelling = null;
        using (cancelling = new DownloadManager(directory, message =>
        {
            state = JsonDocument.Parse(message).RootElement.Clone();
            var item = state.GetProperty("items")[0];
            if (item.GetProperty("state").GetString() == "downloading") cancelling!.Cancel(item.GetProperty("id").GetString()!);
        }))
        {
            using var content = new ByteArrayContent([1, 2]);
            await cancelling.SaveAsync(content, "cancel.bin");
            check(state.GetProperty("items")[0].GetProperty("state").GetString() == "cancelled"
                && !Directory.EnumerateFiles(directory, "*.part").Any(), "cancelled downloads clean up partial files");
        }
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        await using var upstream = builder.Build();
        upstream.MapGet("/file", async context =>
        {
            context.Response.Headers.ContentDisposition = "attachment; filename*=UTF-8''hello%20world.txt";
            if (context.Request.Headers.ContainsKey("Range")) context.Response.StatusCode = 206;
            await context.Response.WriteAsync("attachment bytes");
        });
        await upstream.StartAsync();
        var origin = upstream.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        await using var proxy = new HelltubeProxy(new Uri("http://127.0.0.1:12345/"), manager);
        var address = await proxy.LoadAsync(origin + "/file");
        using var client = new HttpClient();
        using var navigation = new HttpRequestMessage(HttpMethod.Get, address);
        navigation.Headers.Add("Sec-Fetch-Mode", "navigate");
        using var response = await client.SendAsync(navigation);
        check(response.StatusCode == HttpStatusCode.NoContent && !response.Content.Headers.Contains("Content-Disposition")
            && await File.ReadAllTextAsync(Path.Combine(directory, "hello world.txt")) == "attachment bytes", "proxy captures attachment navigation and suppresses browser download response");
        using var fetch = await client.GetAsync(address);
        check(await fetch.Content.ReadAsStringAsync() == "attachment bytes" && fetch.Content.Headers.ContentDisposition is not null,
            "ordinary fetch attachment responses pass through unchanged");
        using var range = new HttpRequestMessage(HttpMethod.Get, address);
        range.Headers.Add("Sec-Fetch-Mode", "navigate");
        range.Headers.Add("Range", "bytes=0-15");
        using var ranged = await client.SendAsync(range);
        check(ranged.StatusCode == HttpStatusCode.PartialContent && ranged.Content.Headers.ContentDisposition is not null,
            "partial responses are never saved as complete downloads");
        manager.Clear();
        check(state.GetProperty("items").GetArrayLength() == 0 && File.Exists(Path.Combine(directory, "test.bin")), "clearing history keeps downloaded files");
        await upstream.StopAsync();
    }
}

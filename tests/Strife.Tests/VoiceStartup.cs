using System.Text.Json;
using Strife;

internal static class VoiceStartup
{
    public static async Task Run(Action<bool, string> check)
    {
        var directory = Path.Combine(Path.GetTempPath(), "strife-voice-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            // Never transmit microphone audio from an automated packaging check.
            await File.WriteAllTextAsync(Path.Combine(directory, "mumble-settings.json"),
                """{"settings_version":1,"mumble_has_quit_normally":true,"audio":{"transmit_mode":"PTT"}}""");
            var state = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            var result = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            await using (var voice = new VoiceEngine(directory))
            {
                voice.Message += message =>
                {
                    if (message.GetProperty("type").GetString() == "state") state.TrySetResult(message);
                    if (message.GetProperty("type").GetString() == "result" &&
                        message.GetProperty("id").GetString() == "packaging-mute") result.TrySetResult(message);
                };
                await voice.StartAsync();
                check(voice.IsReady, "packaged native engine authenticates over the local transport");
                var snapshot = await state.Task.WaitAsync(TimeSpan.FromSeconds(15));
                check(snapshot.GetProperty("rnnoise").GetBoolean(), "packaged engine includes RNNoise");
                check(snapshot.GetProperty("transmitMode").GetInt32() == 2, "packaging test uses PTT without a binding");
                await voice.SendAsync(new { command = "mute", id = "packaging-mute" });
                var reply = await result.Task.WaitAsync(TimeSpan.FromSeconds(15));
                check(reply.GetProperty("ok").GetBoolean(), "packaged engine accepts host commands");
            }
            check(true, "packaged engine shuts down and releases its transport");
        }
        finally { Directory.Delete(directory, recursive: true); }
    }
}

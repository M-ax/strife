using System.Text;
using System.Text.Json;
using Strife;

var directory = Path.Combine(Path.GetTempPath(), "strife-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(directory);
var count = 0;
void Check(bool condition, string name)
{
    if (!condition) throw new Exception("FAIL: " + name);
    Console.WriteLine("PASS: " + name); count++;
}
void Reject(Action action, string name)
{
    try { action(); } catch (ArgumentException) { Check(true, name); return; }
    throw new Exception("FAIL: " + name);
}
foreach (var value in new[] { "file:///C:/Windows", "javascript:alert(1)", "https://user:pass@example.com", "//example.com" })
    Reject(() => PreferencesStore.ValidateHelltubeUrl(value), "reject unsafe Helltube address " + value.Split(':')[0]);
Check(PreferencesStore.ValidateHelltubeUrl("http://127.0.0.1:3000/path").Port == 3000, "local Helltube URL");
var url = new Uri(PreferencesStore.MumbleUrl("::1", 64738, "a@b", "p/#?@"));
Check(url.Host == "[::1]" && url.Port == 64738, "IPv6 Mumble address");
Check(Uri.UnescapeDataString(url.UserInfo) == "a@b:p/#?@", "Mumble credentials round trip without URL injection");
Reject(() => PreferencesStore.MumbleUrl("example.com/path", 64738, "test", ""), "reject host path injection");
Reject(() => PreferencesStore.MumbleUrl("example.com", 0, "test", ""), "reject invalid port");
var preferences = new PreferencesStore(directory);
preferences.Load();
preferences.Save(new("https://video.example.com", "voice.example.com", 64738, "alice", true));
var restored = new PreferencesStore(directory); restored.Load();
Check(restored.Current == preferences.Current, "preferences persist across launches");
Check(!File.ReadAllText(Path.Combine(directory, "preferences.json")).Contains("password"), "passwords excluded from preferences");
await using (var voice = new VoiceEngine(directory))
{
    var replies = new List<JsonElement>();
    var origin = new Uri("http://127.0.0.1:12345/");
    var bridge = new DesktopBridge(preferences, voice, origin, text => replies.Add(JsonSerializer.Deserialize<JsonElement>(text)));
    string Message(string token, string command = "ready") => JsonSerializer.Serialize(new { token, command, id = "test" });
    await bridge.ReceiveAsync(new Uri("https://evil.example/"), Message(bridge.Token));
    await bridge.ReceiveAsync(origin, Message("wrong"));
    await bridge.ReceiveAsync(origin, """{"token":[],"id":"test","command":"ready"}""");
    await bridge.ReceiveAsync(origin, "not json");
    Check(replies.Count == 0, "reject foreign origins, invalid capability tokens and malformed envelopes");
    await bridge.ReceiveAsync(origin, Message(bridge.Token));
    Check(replies.Any(r => r.GetProperty("type").GetString() == "preferences"), "trusted desktop receives preferences");
    replies.Clear();
    await bridge.ReceiveAsync(origin, JsonSerializer.Serialize(new { token = bridge.Token, command = "connect", id = "save",
        host = " saved.voice.test ", port = 64739, username = " SavedUser ", password = "do-not-save" }));
    var saved = new PreferencesStore(directory); saved.Load();
    Check(saved.Current.MumbleHost == "saved.voice.test" && saved.Current.MumblePort == 64739 && saved.Current.Username == "SavedUser",
        "Mumble address is saved even while the voice engine is unavailable");
    Check(replies.Any(r => r.GetProperty("type").GetString() == "preferences" &&
        r.GetProperty("value").GetProperty("username").GetString() == "SavedUser"), "saved connection form is synchronized to the UI");
    Check(!File.ReadAllText(Path.Combine(directory, "preferences.json")).Contains("do-not-save"), "connection password is never persisted");
    replies.Clear();
    await bridge.ReceiveAsync(origin, Message(bridge.Token, "arbitrary-executable"));
    Check(replies.Single().GetProperty("ok").GetBoolean() == false, "command allowlist rejects unknown operation");
}
using (var stream = new MemoryStream(Encoding.UTF8.GetBytes("{\"test\":\"✓\"}\nsecond\n")))
{
    Check(await VoiceEngine.ReadFrameAsync(stream, default) == "{\"test\":\"✓\"}", "UTF-8 IPC frame");
    Check(await VoiceEngine.ReadFrameAsync(stream, default) == "second", "coalesced frames remain separated");
}
using (var stream = new MemoryStream(new byte[1024 * 1024 + 1]))
{
    try { await VoiceEngine.ReadFrameAsync(stream, default); throw new Exception("Oversized frame accepted"); }
    catch (IOException) { Check(true, "oversized IPC frame rejected"); }
}
await ProxySmoke.Run(Check);
if (args.Contains("--native")) await NativeSmoke.Run(Check);
Console.WriteLine($"{count} checks passed.");

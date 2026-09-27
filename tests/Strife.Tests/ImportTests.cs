using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Strife;

internal static class ImportTests
{
    public static async Task Run(string directory, Action<bool, string> check)
    {
        var source = Path.Combine(directory, "mumble-source");
        var target = Path.Combine(directory, "import-target");
        Directory.CreateDirectory(source); Directory.CreateDirectory(target);
        var sourceSettings = Path.Combine(source, "mumble_settings.json");
        var targetSettings = Path.Combine(target, "mumble-settings.json");
        var sourceDb = Path.Combine(source, "mumble.sqlite");
        var targetDb = Path.Combine(target, "mumble.sqlite");
        const string original = """{"settings_version":1,"certificate":"old-identity","audio":{"transmit_mode":"PTT"}}""";
        await File.WriteAllTextAsync(targetSettings, original);
        await File.WriteAllTextAsync(sourceSettings, """{"settings_version":1,"certificate":"new-identity","audio":{"transmit_mode":"VAD"}}""");
        using var writer = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = sourceDb, Pooling = false }.ToString());
        writer.Open();
        using var sql = writer.CreateCommand();
        sql.CommandText = """
            PRAGMA journal_mode=WAL;
            CREATE TABLE servers (name TEXT, hostname TEXT, port INTEGER, username TEXT, password TEXT, url TEXT);
            CREATE TABLE tokens (digest TEXT, token TEXT);
            INSERT INTO servers VALUES ('Friends <script>', 'voice.example.test', 64739, 'Alice', 'saved-secret', '');
            INSERT INTO tokens VALUES ('server-hash', 'access-secret');
            """;
        sql.ExecuteNonQuery();
        var importer = new MumbleImport(target);
        Task<JsonElement> Read(string path) => Task.FromResult(JsonSerializer.SerializeToElement(new
        { settings = JsonNode.Parse(File.ReadAllText(path)), hasIdentity = true, databasePath = "" }));
        var starts = 0; var stops = 0;
        Task Stop() { stops++; return Task.CompletedTask; }
        Task Start() { starts++; return Task.CompletedTask; }
        using var staged = await importer.PrepareAsync(sourceSettings, "", Read);
        check(staged.HasDatabase && staged.Servers.Length == 1 && staged.Servers[0].HasPassword,
            "import finds adjacent database and snapshots committed WAL servers");
        var summary = JsonSerializer.Serialize(staged.Summary);
        check(!summary.Contains("new-identity") && !summary.Contains("saved-secret") && !summary.Contains("access-secret"),
            "import preview excludes identity, passwords and access tokens");
        check(File.ReadAllText(targetSettings) == original && !File.Exists(targetDb), "preview leaves the active profile unchanged");
        sql.CommandText = "INSERT INTO servers VALUES ('Added later', 'later.test', 64738, 'Bob', '', '')";
        sql.ExecuteNonQuery();
        var backup = await importer.ApplyAsync(staged, new(true, true, false), Stop, Start);
        var applied = JsonNode.Parse(File.ReadAllText(targetSettings))!;
        check(applied["certificate"]!.GetValue<string>() == "old-identity" && applied["audio"]!["transmit_mode"]!.GetValue<string>() == "VAD",
            "settings import preserves the existing identity when unchecked");
        check(applied["misc"]!["database_location"]!.GetValue<string>() == targetDb, "import binds database to Strife's own profile");
        check(File.ReadAllText(Path.Combine(backup, "mumble-settings.json")) == original && starts == 1 && stops == 1,
            "import backs up the previous profile and restarts voice");
        check(importer.GetServers().Length == 1 && importer.GetServer(staged.Servers[0].Id).Password == "saved-secret",
            "import applies the reviewed snapshot and retains server credentials privately");
        using (var importedDb = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = targetDb, Pooling = false }.ToString()))
        {
            importedDb.Open(); using var tokens = importedDb.CreateCommand();
            tokens.CommandText = "SELECT token FROM tokens";
            check(Equals(tokens.ExecuteScalar(), "access-secret"), "database import retains access tokens and other Mumble tables");
        }
        check(File.ReadAllText(sourceSettings).Contains("new-identity") && MumbleImport.ReadServers(sourceDb).Length == 2,
            "import does not modify the source installation");
        await importer.ApplyAsync(staged, new(false, false, true), Stop, Start);
        check(JsonNode.Parse(File.ReadAllText(targetSettings))!["certificate"]!.GetValue<string>() == "new-identity"
            && importer.GetServers().Length == 1, "identity can be imported independently");
        var beforeFailure = File.ReadAllText(targetSettings);
        var attemptedStarts = 0;
        try
        {
            await importer.ApplyAsync(staged, new(true, true, true), Stop, () =>
            {
                if (++attemptedStarts == 1) throw new IOException("Simulated engine failure");
                return Task.CompletedTask;
            });
            throw new Exception("Expected rollback");
        }
        catch (IOException)
        {
            check(attemptedStarts == 2 && File.ReadAllText(targetSettings) == beforeFailure && importer.GetServers().Length == 1,
                "failed engine restart rolls settings and database back and restarts the original profile");
        }
        foreach (var path in new[] { targetSettings, Path.Combine(source, "missing.json") })
        {
            try { using var invalid = await importer.PrepareAsync(path, "", Read); throw new Exception("Accepted invalid source"); }
            catch (ArgumentException) { check(true, "import rejects missing files and importing the active profile into itself"); }
        }
        var unrelated = Path.Combine(source, "unrelated.sqlite");
        using (var db = new SqliteConnection("Data Source=" + unrelated)) { db.Open(); }
        try { using var invalid = await importer.PrepareAsync("", unrelated, Read); throw new Exception("Accepted unrelated database"); }
        catch (SqliteException) { check(true, "import rejects databases without Mumble's server schema"); }
        using var databaseOnly = await importer.PrepareAsync("", sourceDb, _ => throw new Exception("Should not read settings"));
        check(databaseOnly.HasDatabase && !databaseOnly.HasIdentity, "database-only import works without settings");
        try { await importer.ApplyAsync(staged, new(false, false, false), Stop, Start); throw new Exception("Accepted empty import"); }
        catch (ArgumentException) { check(true, "empty import selection is rejected"); }
    }

    public static async Task Native(string directory, string profile, VoiceEngine voice, Action<bool, string> check)
    {
        var path = Path.Combine(directory, "legacy-import.ini");
        var text = "[audio]\ntransmit=2\nquality=48000\n[net]\nusername=ImportedUser\n";
        await File.WriteAllTextAsync(path, text);
        var imported = await voice.ReadImportSettingsAsync(path);
        var settings = imported.GetProperty("settings");
        check(settings.GetProperty("audio").GetProperty("transmit_mode").GetString() == "PTT",
            "native legacy INI import uses Mumble's shortcut and settings conversion");
        check(!imported.GetProperty("hasIdentity").GetBoolean() && File.ReadAllText(path) == text,
            "native import detects missing identity and leaves legacy source unchanged");
        var jsonPath = Path.Combine(directory, "import-settings.json");
        await File.WriteAllTextAsync(jsonPath, """{"settings_version":1,"audio":{"transmit_mode":"PTT"}}""");
        var json = await voice.ReadImportSettingsAsync(jsonPath);
        check(json.GetProperty("settings").GetProperty("audio").GetProperty("noise_cancel_mode").GetString() == "Speex",
            "sparse Mumble settings retain upstream noise suppression default during import");
        foreach (var invalid in new[] { "{", "{}", "{\"settings_version\":999}", "{\"settings_version\":1,\"audio\":{\"audio_quality\":\"invalid\"}}" })
        {
            await File.WriteAllTextAsync(jsonPath, invalid);
            try { await voice.ReadImportSettingsAsync(jsonPath); throw new Exception("Accepted invalid settings"); }
            catch (ArgumentException) { check(voice.IsReady, "invalid settings are rejected without stopping native voice"); }
        }
        await voice.EnsureImportReadyAsync();
        check(true, "native engine confirms it is disconnected and ready to import");
        var database = Path.Combine(directory, "import-native.sqlite");
        using (var from = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(profile, "mumble.sqlite"), Pooling = false }.ToString()))
        using (var to = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = database, Pooling = false }.ToString()))
        {
            from.Open(); to.Open(); from.BackupDatabase(to);
            using var query = to.CreateCommand();
            query.CommandText = "INSERT INTO servers (name,hostname,port,username,password,url) VALUES ('Native import','127.0.0.1',64738,'ImportedUser','','')";
            query.ExecuteNonQuery();
        }
        var importer = new MumbleImport(profile);
        using var staged = await importer.PrepareAsync(path, database, voice.ReadImportSettingsAsync);
        await importer.ApplyAsync(staged, new(true, true, false), voice.StopAsync, voice.StartAsync);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (voice.LastState is null && DateTime.UtcNow < deadline) await Task.Delay(50);
        check(voice.IsReady && voice.LastState?.GetProperty("transmitMode").GetInt32() == 2
            && voice.LastState?.GetProperty("rnnoise").GetBoolean() == false,
            "real native restart applies imported audio preferences without connecting");
        check(importer.GetServers().Single().Name == "Native import", "real native restart retains imported saved servers");
    }
}

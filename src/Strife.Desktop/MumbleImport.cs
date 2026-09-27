using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Microsoft.Win32;

namespace Strife;

public sealed record SavedServer(long Id, string Name, string Host, int Port, string Username, bool HasPassword);
public sealed record ImportSelection(bool Settings, bool Database, bool Identity);
public sealed record ImportSources(string[] Settings, string[] Databases);

/// <summary>Snapshots Mumble data without modifying the installation it came from.</summary>
public sealed class MumbleImport(string profile)
{
    private readonly string profile = Path.GetFullPath(profile);
    private const string SettingsFile = "mumble-settings.json";
    private const string DatabaseFile = "mumble.sqlite";

    public static ImportSources Discover()
    {
        var roots = new List<string>();
        foreach (var folder in new[] { Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.ApplicationData })
        {
            var root = Environment.GetFolderPath(folder);
            roots.Add(Path.Combine(root, "Mumble", "Mumble"));
            roots.Add(Path.Combine(root, "Mumble"));
        }
        var registry = false;
        if (OperatingSystem.IsWindows())
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Mumble\Mumble");
            registry = key is not null && (key.ValueCount > 0 || key.SubKeyCount > 0);
            if (key?.GetValue("InstPath") is string installed && Directory.Exists(installed)) roots.Add(installed);
        }
        var settings = FindFiles(roots, ["mumble_settings.json", "mumble.ini", "mumble.conf"]).ToList();
        if (registry) settings.Add("registry");
        var databases = FindFiles(roots, ["mumble.sqlite", ".mumble.sqlite"]);
        return new(settings.ToArray(), databases);
    }

    private static string[] FindFiles(IEnumerable<string> roots, string[] names) => roots
        .SelectMany(root => names.Select(name => Path.Combine(root, name)))
        .Where(File.Exists).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

    private string SourcePath(string value)
    {
        var path = Path.GetFullPath(Environment.ExpandEnvironmentVariables(value.Trim().Trim('"')));
        var relative = Path.GetRelativePath(profile, path);
        if (relative == "." || (!Path.IsPathRooted(relative) && relative != ".."
            && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)))
            throw new ArgumentException("Choose an existing Mumble installation outside this Strife profile.");
        if (!File.Exists(path)) throw new ArgumentException("The selected Mumble file does not exist.");
        return path;
    }

    public async Task<PreparedImport> PrepareAsync(string settingsSource, string databaseSource,
        Func<string, Task<JsonElement>> readSettings)
    {
        JsonObject? settings = null;
        var hasIdentity = false;
        settingsSource = settingsSource.Trim();
        databaseSource = databaseSource.Trim();
        if (settingsSource.Length > 0)
        {
            if (settingsSource != "registry") settingsSource = SourcePath(settingsSource);
            var result = await readSettings(settingsSource);
            settings = JsonNode.Parse(result.GetProperty("settings").GetRawText())!.AsObject();
            hasIdentity = result.GetProperty("hasIdentity").GetBoolean();
            if (databaseSource.Length == 0)
            {
                var configured = result.GetProperty("databasePath").GetString();
                if (!string.IsNullOrWhiteSpace(configured))
                {
                    databaseSource = Path.IsPathRooted(configured) || settingsSource == "registry" ? configured
                        : Path.Combine(Path.GetDirectoryName(settingsSource)!, configured);
                }
                else if (settingsSource != "registry")
                    databaseSource = FindFiles([Path.GetDirectoryName(settingsSource)!], ["mumble.sqlite", ".mumble.sqlite"]).FirstOrDefault() ?? "";
                else databaseSource = Discover().Databases.FirstOrDefault() ?? "";
                if (!File.Exists(databaseSource)) databaseSource = "";
            }
        }
        if (settings is null && databaseSource.Length == 0)
            throw new ArgumentException("Choose Mumble settings, a Mumble database, or both.");
        var stage = new PreparedImport(Path.Combine(profile, "import-staging", Guid.NewGuid().ToString("N")), settings, hasIdentity);
        try
        {
            Directory.CreateDirectory(stage.DirectoryPath);
            if (databaseSource.Length > 0)
            {
                databaseSource = SourcePath(databaseSource);
                SnapshotDatabase(databaseSource, Path.Combine(stage.DirectoryPath, DatabaseFile));
                stage.Servers = ReadServers(Path.Combine(stage.DirectoryPath, DatabaseFile));
                stage.HasDatabase = true;
            }
            stage.SettingsSource = settingsSource;
            stage.DatabaseSource = databaseSource;
            return stage;
        }
        catch { stage.Dispose(); throw; }
    }

    private static SqliteConnection OpenDatabase(string path, SqliteOpenMode mode)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = path, Mode = mode, Pooling = false, DefaultTimeout = 3 }.ToString());
        try { connection.Open(); return connection; }
        catch { connection.Dispose(); throw; }
    }

    private static void SnapshotDatabase(string source, string destination)
    {
        using var input = OpenDatabase(source, SqliteOpenMode.ReadOnly);
        using (var check = input.CreateCommand())
        {
            check.CommandText = "PRAGMA quick_check";
            if (!Equals(check.ExecuteScalar(), "ok")) throw new ArgumentException("The Mumble database is damaged.");
        }
        // SQLite's backup API includes committed WAL contents, unlike copying the main file.
        using var output = OpenDatabase(destination, SqliteOpenMode.ReadWriteCreate);
        input.BackupDatabase(output);
    }

    internal static SavedServer[] ReadServers(string path)
    {
        if (!File.Exists(path)) return [];
        using var db = OpenDatabase(path, SqliteOpenMode.ReadOnly);
        using var query = db.CreateCommand();
        query.CommandText = "SELECT rowid, name, hostname, port, username, length(coalesce(password,'')) > 0 FROM servers ORDER BY name, rowid";
        using var rows = query.ExecuteReader();
        var servers = new List<SavedServer>();
        while (rows.Read())
        {
            var port = rows.GetInt32(3);
            if (port is < 1 or > 65535 || rows.IsDBNull(2) || string.IsNullOrWhiteSpace(rows.GetString(2)))
                throw new ArgumentException("The Mumble database contains an invalid saved server.");
            servers.Add(new(rows.GetInt64(0), rows.IsDBNull(1) ? rows.GetString(2) : rows.GetString(1), rows.GetString(2), port,
                rows.IsDBNull(4) ? "" : rows.GetString(4), rows.GetBoolean(5)));
        }
        return servers.ToArray();
    }

    public SavedServer[] GetServers()
    {
        var path = Path.Combine(profile, DatabaseFile);
        // A new engine creates its schema during startup.
        if (!File.Exists(path) || new FileInfo(path).Length == 0) return [];
        return ReadServers(path);
    }

    public (SavedServer Server, string Password) GetServer(long id)
    {
        var server = GetServers().SingleOrDefault(s => s.Id == id)
            ?? throw new ArgumentException("That saved server is no longer available.");
        using var db = OpenDatabase(Path.Combine(profile, DatabaseFile), SqliteOpenMode.ReadOnly);
        using var query = db.CreateCommand();
        query.CommandText = "SELECT password FROM servers WHERE rowid = $id";
        query.Parameters.AddWithValue("$id", id);
        return (server, query.ExecuteScalar() as string ?? "");
    }

    public async Task<string> ApplyAsync(PreparedImport prepared, ImportSelection selection, Func<Task> stop, Func<Task> start)
    {
        if (!selection.Settings && !selection.Database && !selection.Identity)
            throw new ArgumentException("Select something to import.");
        if ((selection.Settings && prepared.Settings is null) || (selection.Identity && !prepared.HasIdentity)
            || (selection.Database && !prepared.HasDatabase)) throw new ArgumentException("The selected data is not available in this import.");
        var files = new List<string>();
        if (selection.Settings || selection.Identity) files.Add(SettingsFile);
        if (selection.Database) files.Add(DatabaseFile);
        await stop(); // Flush settings and close SQLite before backing up or replacing either file.
        var backup = Path.Combine(profile, "import-backups", DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N"));
        var original = new HashSet<string>();
        var backedUp = false;
        try
        {
            Directory.CreateDirectory(backup);
            foreach (var file in files)
            {
                var path = Path.Combine(profile, file);
                if (!File.Exists(path)) continue;
                if (file == DatabaseFile) SnapshotDatabase(path, Path.Combine(backup, file));
                else File.Copy(path, Path.Combine(backup, file));
                original.Add(file);
            }
            backedUp = true;
            if (selection.Settings || selection.Identity)
            {
                var path = Path.Combine(profile, SettingsFile);
                var current = File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))!.AsObject() : new JsonObject { ["settings_version"] = 1 };
                var next = (JsonObject)(selection.Settings ? prepared.Settings! : current).DeepClone();
                next["certificate"] = (selection.Identity ? prepared.Settings!["certificate"] : current["certificate"])?.DeepClone();
                next["mumble_has_quit_normally"] = true;
                next["misc"] ??= new JsonObject();
                next["misc"]!["database_location"] = Path.Combine(profile, DatabaseFile);
                var staged = Path.Combine(prepared.DirectoryPath, SettingsFile);
                File.WriteAllText(staged, next.ToJsonString());
                File.Copy(staged, path, true);
            }
            if (selection.Database)
            {
                RemoveSidecars();
                File.Copy(Path.Combine(prepared.DirectoryPath, DatabaseFile), Path.Combine(profile, DatabaseFile), true);
            }
            await start();
            return backup;
        }
        catch (Exception failure)
        {
            try
            {
                await stop();
                if (backedUp)
                {
                    if (selection.Database) RemoveSidecars();
                    foreach (var file in files)
                    {
                        var path = Path.Combine(profile, file);
                        if (original.Contains(file)) File.Copy(Path.Combine(backup, file), path, true);
                        else File.Delete(path);
                    }
                }
                await start();
            }
            catch (Exception recovery)
            {
                throw new IOException($"Import failed and voice could not restart. Your previous data is backed up in {backup}. {recovery.Message}", failure);
            }
            throw new IOException("Import failed; your previous Mumble data was restored. " + failure.Message, failure);
        }
    }

    private void RemoveSidecars()
    {
        foreach (var suffix in new[] { "-wal", "-shm", "-journal" }) File.Delete(Path.Combine(profile, DatabaseFile + suffix));
    }
}

public sealed class PreparedImport(string directory, JsonObject? settings, bool hasIdentity) : IDisposable
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public string DirectoryPath { get; } = directory;
    internal JsonObject? Settings { get; } = settings;
    public bool HasIdentity { get; } = hasIdentity;
    public bool HasDatabase { get; internal set; }
    public SavedServer[] Servers { get; internal set; } = [];
    public string SettingsSource { get; internal set; } = "";
    public string DatabaseSource { get; internal set; } = "";
    public object Summary => new { id = Id, hasSettings = Settings is not null, hasIdentity = HasIdentity,
        hasDatabase = HasDatabase, serverCount = Servers.Length, settingsSource = SettingsSource, databaseSource = DatabaseSource };
    public void Dispose()
    {
        if (Directory.Exists(DirectoryPath)) Directory.Delete(DirectoryPath, true);
    }
}

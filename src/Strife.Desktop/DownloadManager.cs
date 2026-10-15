using System.Diagnostics;
using System.Text.Json;

namespace Strife;

// Own only attachment responses already authenticated and fetched by HelltubeProxy.
public sealed class DownloadManager(string directory, Action<string> publish) : IDisposable
{
    private sealed class Entry(string name, long? total)
    {
        public string Id { get; } = Guid.NewGuid().ToString("N");
        public string Name = name;
        public long Bytes;
        public long? Total = total;
        public string State = "downloading";
        public string? Error;
        public CancellationTokenSource Cancel { get; } = new();
    }
    private readonly object sync = new();
    private readonly List<Entry> entries = [];
    private bool disposed;

    public static string SafeName(string? value)
    {
        var name = (value ?? "download").Trim('"').Replace('\\', '/').Split('/').Last();
        name = new string(name.Select(c => char.IsControl(c) || "<>:\"/\\|?*".Contains(c) ? '_' : c).ToArray());
        if (name.Length > 160) name = name[..160];
        name = name.Trim().TrimEnd('.');
        if (string.IsNullOrWhiteSpace(name)) name = "download";
        if (System.Text.RegularExpressions.Regex.IsMatch(name, @"^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])($|\.)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) name = "_" + name;
        return name;
    }

    public void Publish()
    {
        lock (sync) publish(JsonSerializer.Serialize(new { type = "downloads", directory,
            items = entries.Select(e => new { id = e.Id, name = e.Name, bytes = e.Bytes, total = e.Total, state = e.State, error = e.Error }).ToArray() }));
    }

    public void Cancel(string id) { lock (sync) entries.Find(e => e.Id == id && e.State == "downloading")?.Cancel.Cancel(); }
    public void Clear() { lock (sync) { foreach (var e in entries.Where(e => e.State != "downloading")) e.Cancel.Dispose(); entries.RemoveAll(e => e.State != "downloading"); } Publish(); }
    public void OpenFolder()
    {
        Directory.CreateDirectory(directory);
        Process.Start(new ProcessStartInfo(directory) { UseShellExecute = true });
    }

    public async Task SaveAsync(HttpContent content, string? name)
    {
        var entry = new Entry(SafeName(name), content.Headers.ContentLength);
        lock (sync) { if (disposed) { entry.Cancel.Dispose(); return; } entries.Add(entry); }
        Publish();
        var partial = Path.Combine(directory, "." + entry.Id + ".part");
        try
        {
            Directory.CreateDirectory(directory);
            var cancellation = entry.Cancel.Token;
            await using (var output = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
            await using (var input = await content.ReadAsStreamAsync(cancellation))
            {
                var buffer = new byte[65536];
                var last = Stopwatch.StartNew();
                int count;
                while ((count = await input.ReadAsync(buffer, cancellation)) > 0)
                {
                    await output.WriteAsync(buffer.AsMemory(0, count), cancellation);
                    lock (sync) entry.Bytes += count;
                    if (last.ElapsedMilliseconds >= 200) { Publish(); last.Restart(); }
                }
                if (entry.Total is { } total && total != entry.Bytes) throw new IOException("The download ended before all bytes arrived.");
            }
            lock (sync)
            {
                cancellation.ThrowIfCancellationRequested();
                var original = entry.Name;
                for (var suffix = 0; ; suffix++)
                {
                    var candidate = suffix == 0 ? original : Path.GetFileNameWithoutExtension(original) + " (" + suffix + ")" + Path.GetExtension(original);
                    try { File.Move(partial, Path.Combine(directory, candidate)); entry.Name = candidate; break; }
                    catch (IOException) when (File.Exists(Path.Combine(directory, candidate))) { }
                }
                entry.State = "completed";
            }
        }
        catch (Exception error) when (error is IOException or HttpRequestException or OperationCanceledException or UnauthorizedAccessException)
        {
            lock (sync) { entry.State = entry.Cancel.IsCancellationRequested ? "cancelled" : "failed"; entry.Error = entry.State == "failed" ? error.Message : null; }
        }
        finally
        {
            try { File.Delete(partial); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            Publish();
        }
    }

    public void Dispose() { lock (sync) { disposed = true; foreach (var entry in entries) entry.Cancel.Cancel(); } }
}

using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;

namespace Strife;

public sealed class VoiceEngine(string profileDirectory) : IAsyncDisposable
{
    private NamedPipeServerStream? pipe;
    private Process? process;
    private Task? reader;
    private readonly SemaphoreSlim writerLock = new(1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim startLock = new(1);
    public bool IsReady { get; private set; }
    public nint OwnerWindow { get; set; }
    public event Action<JsonElement>? Message;
    public event Action<string>? Stopped;
    public JsonElement? LastState { get; private set; }
    public JsonElement? LastLog { get; private set; }
    public string? Failure { get; private set; }

    public static string FindExecutable()
    {
        var configured = Environment.GetEnvironmentVariable("STRIFE_VOICE_ENGINE");
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
        var packaged = Path.Combine(AppContext.BaseDirectory, "voice", "strife-voice.exe");
        if (File.Exists(packaged)) return packaged;
        for (var current = new DirectoryInfo(AppContext.BaseDirectory); current is not null; current = current.Parent)
        {
            var candidate = Path.Combine(current.FullName, "artifacts", "voice", "strife-voice.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return packaged;
    }

    public async Task StartAsync()
    {
        await startLock.WaitAsync(lifetime.Token);
        try
        {
            if (IsReady) return;
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("This build uses the Windows Mumble engine.");
            var executable = FindExecutable();
            if (!File.Exists(executable))
                throw new FileNotFoundException("Voice engine has not been built. Run scripts/build-voice.ps1, then Retry voice engine.");
            await StopProcessAsync();
            if (reader is not null) { try { await reader; } catch (OperationCanceledException) { } }
            Directory.CreateDirectory(profileDirectory);
            var settings = Path.Combine(profileDirectory, "mumble-settings.json");
            if (!File.Exists(settings))
                await File.WriteAllTextAsync(settings, """{"settings_version":1,"mumble_has_quit_normally":true}""");
            var database = Path.Combine(profileDirectory, "mumble.sqlite");
            // Mumble prompts for a configured path that does not exist. An empty
            // SQLite file is valid and lets its normal schema initializer run.
            using (File.Open(database, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite)) { }
            var name = "Strife." + Guid.NewGuid().ToString("N");
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            var info = new ProcessStartInfo(executable)
            {
                UseShellExecute = false, CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(executable)!
            };
            info.ArgumentList.Add("--multiple");
            info.ArgumentList.Add("--hidden");
            info.ArgumentList.Add("--config");
            info.ArgumentList.Add(settings);
            info.ArgumentList.Add("--default-certificate-dir");
            info.ArgumentList.Add(profileDirectory);
            info.ArgumentList.Add("--skip-settings-backup-prompt");
            info.Environment["STRIFE_PIPE"] = name;
            info.Environment["STRIFE_PIPE_TOKEN"] = token;
            info.Environment["STRIFE_DATABASE"] = database;
            info.Environment["STRIFE_PARENT_WINDOW"] = OwnerWindow.ToString(System.Globalization.CultureInfo.InvariantCulture);
            info.Environment["STRIFE_PARENT_PID"] = Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var temporaryDirectory = Path.Combine(profileDirectory, "temp");
            Directory.CreateDirectory(temporaryDirectory);
            info.Environment["TEMP"] = temporaryDirectory;
            info.Environment["TMP"] = temporaryDirectory;
            process = Process.Start(info) ?? throw new IOException("Could not start the voice engine.");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            var connected = pipe.WaitForConnectionAsync(timeout.Token);
            var exited = process.WaitForExitAsync(timeout.Token);
            if (await Task.WhenAny(connected, exited) == exited)
                throw new IOException($"Voice engine exited during startup (code {process.ExitCode}).");
            await connected;
            var input = new BufferedStream(pipe, 16 * 1024);
            var hello = JsonSerializer.Deserialize<JsonElement>(await ReadFrameAsync(input, timeout.Token));
            if (hello.GetProperty("type").GetString() != "hello" || hello.GetProperty("protocol").GetInt32() != 1
                || hello.GetProperty("token").GetString() != token)
                throw new IOException("Voice engine authentication failed.");
            await WriteAsync(new { command = "hello" }, timeout.Token);
            IsReady = true;
            Failure = null;
            reader = ReadLoopAsync(input);
        }
        catch
        {
            await StopProcessAsync();
            throw;
        }
        finally { startLock.Release(); }
    }

    // A length limit prevents an unterminated/malicious frame from growing memory.
    internal static async Task<string> ReadFrameAsync(Stream stream, CancellationToken token)
    {
        using var bytes = new MemoryStream();
        var one = new byte[1];
        while (await stream.ReadAsync(one, token) != 0)
        {
            if (one[0] == '\n') return Encoding.UTF8.GetString(bytes.GetBuffer(), 0, (int)bytes.Length);
            if (bytes.Length >= 1024 * 1024) throw new IOException("Voice event exceeded its size limit.");
            bytes.WriteByte(one[0]);
        }
        throw new EndOfStreamException("Voice engine disconnected.");
    }

    private async Task ReadLoopAsync(Stream stream)
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                var message = JsonSerializer.Deserialize<JsonElement>(await ReadFrameAsync(stream, lifetime.Token));
                switch (message.GetProperty("type").GetString())
                {
                    case "state": LastState = message; break;
                    case "log": LastLog = message; break;
                }
                Message?.Invoke(message);
            }
        }
        catch (Exception e) when (e is IOException or JsonException or OperationCanceledException or ObjectDisposedException)
        {
            IsReady = false;
            LastState = null;
            if (!lifetime.IsCancellationRequested)
            {
                Failure = "Voice engine stopped. Retry to reconnect.";
                Stopped?.Invoke(Failure);
            }
        }
    }

    public async Task SendAsync(object command)
    {
        if (!IsReady) throw new InvalidOperationException("Voice engine is not ready.");
        if (OperatingSystem.IsWindows() && process is { HasExited: false })
            AllowSetForegroundWindow(process.Id);
        await WriteAsync(command, lifetime.Token);
    }

    private async Task WriteAsync(object command, CancellationToken token)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(command, PreferencesStore.Json) + "\n");
        await writerLock.WaitAsync(token);
        try
        {
            if (pipe is null || !pipe.IsConnected) throw new IOException("Voice engine is disconnected.");
            await pipe.WriteAsync(bytes, token);
            await pipe.FlushAsync(token);
        }
        finally { writerLock.Release(); }
    }

    private async Task StopProcessAsync()
    {
        IsReady = false;
        if (process is { HasExited: false })
        {
            try { await WriteAsync(new { command = "shutdown" }, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(1)); }
            catch (Exception e) when (e is IOException or TimeoutException or ObjectDisposedException) { }
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) { if (!process.HasExited) process.Kill(true); }
        }
        pipe?.Dispose();
        pipe = null;
        process?.Dispose();
        process = null;
    }

    public async ValueTask DisposeAsync()
    {
        await lifetime.CancelAsync();
        await StopProcessAsync();
        if (reader is not null) await reader;
        lifetime.Dispose();
        writerLock.Dispose();
        startLock.Dispose();
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(int processId);
}

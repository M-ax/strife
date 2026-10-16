using System.Runtime.InteropServices;

// A dedicated process/window for opt-in native capture tests. Plays only the
// supplied generated WAV; never opens a microphone or captures user content.
internal static class CaptureFixture
{
    public static void Run(string title, string wav)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var window = CreateWindowExW(0, "STATIC", title, 0x10cf0000, 40, 40, 640, 360, 0, 0, 0, 0);
        if (window == 0 || !PlaySoundW(Path.GetFullPath(wav), 0, 0x00020009))
            throw new InvalidOperationException("Could not start window/audio fixture.");
        // Override STARTUPINFO's hidden-window flag without stealing focus.
        ShowWindow(window, 4);
        ShowWindow(window, 8);
        var thread = GetCurrentThreadId();
        _ = Task.Run(async () =>
        {
            await Task.WhenAny(Console.In.ReadLineAsync(), Task.Delay(TimeSpan.FromMinutes(3)));
            PostMessageW(window, 0x0010, 0, 0);
            PostThreadMessageW(thread, 0x0012, 0, 0);
        });
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { ready = true, title }));
        Console.Out.Flush();
        while (GetMessageW(out var message, 0, 0, 0) > 0) { TranslateMessage(ref message); DispatchMessageW(ref message); }
        PlaySoundW(null, 0, 0);
        DestroyWindow(window);
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Message { public nint Window; public uint Id; public nuint WParam; public nint LParam; public uint Time; public int X, Y; public uint Private; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, nint parent, nint menu, nint instance, nint param);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] private static extern bool PlaySoundW(string? file, nint module, uint flags);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool PostMessageW(nint window, uint message, nuint wp, nint lp);
    [DllImport("user32.dll")] private static extern bool PostThreadMessageW(uint thread, uint message, nuint wp, nint lp);
    [DllImport("user32.dll")] private static extern int GetMessageW(out Message message, nint window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern nint DispatchMessageW(ref Message message);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(nint window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint window, int command);
}

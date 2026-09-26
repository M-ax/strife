param([Parameter(Mandatory)][int]$HostProcessId)
$ErrorActionPreference = 'Stop'
# Address only the isolated desktop test and its own native voice child.
# Activation clicks a verified test title bar; dialog keys target its HWND.
$voiceProcess = Get-CimInstance Win32_Process -Filter "ParentProcessId=$HostProcessId AND Name='strife-voice.exe'"
if (!$voiceProcess) { throw 'The test desktop has no native voice child.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class StrifeWindowProbe : IDisposable {
    public sealed class Window {
        public long Handle;
        public long Owner;
        public string Title;
        public string Class;
        public bool Visible;
    }
    private readonly uint hostPid, voicePid;
    private readonly ConcurrentQueue<long> shown = new ConcurrentQueue<long>();
    private readonly Thread events;
    private volatile bool stopped;
    private readonly ManualResetEventSlim ready = new ManualResetEventSlim();
    public StrifeWindowProbe(uint hostPid, uint voicePid) {
        this.hostPid = hostPid; this.voicePid = voicePid;
        events = new Thread(Watch) { IsBackground = true };
        events.Start();
        if (!ready.Wait(5000)) throw new Exception("Window event hook did not start.");
    }
    public long Foreground { get { return GetForegroundWindow().ToInt64(); } }
    public long[] Shown { get { return shown.ToArray(); } }
    public Window[] Windows(bool host) {
        var result = new List<Window>();
        EnumWindows((hwnd, unused) => {
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (pid != (host ? hostPid : voicePid)) return true;
            var title = new StringBuilder(512); GetWindowText(hwnd, title, title.Capacity);
            var cls = new StringBuilder(256); GetClassName(hwnd, cls, cls.Capacity);
            result.Add(new Window { Handle = hwnd.ToInt64(), Owner = GetWindow(hwnd, 4).ToInt64(),
                Title = title.ToString(), Class = cls.ToString(), Visible = IsWindowVisible(hwnd) });
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    public bool ActivateHost() {
        foreach (var window in Windows(true)) {
            if (!window.Visible || window.Title != "Strife") continue;
            var hwnd = new IntPtr(window.Handle);
            if (SetForegroundWindow(hwnd)) return true;
            // A background runner has no foreground permission. Reproduce
            // the user's activation with a click on this test's title bar.
            Rect bounds; Point previous;
            GetWindowRect(hwnd, out bounds); GetCursorPos(out previous);
            SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, 0x13);
            var point = new Point { X = bounds.Left + (bounds.Right - bounds.Left) / 2, Y = bounds.Top + 12 };
            if (GetAncestor(WindowFromPoint(point), 2) != hwnd)
                throw new Exception("Test title bar is obscured; refusing to click another window.");
            try {
                SetCursorPos(point.X, point.Y);
                var input = new [] { new Input { Mouse = new MouseInput { Flags = 2 } },
                                     new Input { Mouse = new MouseInput { Flags = 4 } } };
                if (SendInput(2, input, Marshal.SizeOf(typeof(Input))) != 2)
                    throw new Exception("Unable to activate the test window.");
            } finally { SetCursorPos(previous.X, previous.Y); }
            return true;
        }
        throw new Exception("Test Strife window is missing.");
    }
    public void Key(long handle, uint key) {
        var hwnd = new IntPtr(handle);
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        if (pid != voicePid || !IsWindowVisible(hwnd)) throw new Exception("Not a visible test voice window.");
        PostMessage(hwnd, 0x100, new UIntPtr(key), new IntPtr(1));
        PostMessage(hwnd, 0x101, new UIntPtr(key), new IntPtr(unchecked((int)0xc0000001)));
    }
    private void Watch() {
        WinEvent callback = (hook, evt, hwnd, objectId, childId, thread, time) => {
            if (objectId == 0 && childId == 0 && GetAncestor(hwnd, 2) == hwnd) shown.Enqueue(hwnd.ToInt64());
        };
        var handle = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, callback, voicePid, 0, 0);
        if (handle == IntPtr.Zero) return;
        ready.Set();
        while (!stopped) {
            Message message;
            while (PeekMessage(out message, IntPtr.Zero, 0, 0, 1)) {
                TranslateMessage(ref message); DispatchMessage(ref message);
            }
            Thread.Sleep(5);
        }
        UnhookWinEvent(handle);
        GC.KeepAlive(callback);
    }
    public void Dispose() { stopped = true; events.Join(5000); ready.Dispose(); }
    private delegate bool EnumWindow(IntPtr window, IntPtr argument);
    private delegate void WinEvent(IntPtr hook, uint evt, IntPtr hwnd, int objectId, int childId, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential)] private struct Message {
        public IntPtr Hwnd; public uint Id; public UIntPtr WParam; public IntPtr LParam;
        public uint Time; public int X, Y; public uint Private;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput {
        public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public MouseInput Mouse; }
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr argument);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int length);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
}
'@
$probe = [StrifeWindowProbe]::new($HostProcessId, $voiceProcess.ProcessId)
try {
    [Console]::WriteLine('{"ready":true}')
    while ($line = [Console]::ReadLine()) {
        $request = $line | ConvertFrom-Json
        switch ($request.command) {
            'foreground' { $activated = $probe.ActivateHost() }
            'accept' { $probe.Key($request.handle, 13) }
            'cancel' { $probe.Key($request.handle, 27) }
        }
        if ($request.command -eq 'quit') { break }
        $result = @{ windows = @($probe.Windows($false)); host = @($probe.Windows($true)); foreground = $probe.Foreground; shown = @($probe.Shown) }
        [Console]::WriteLine(($result | ConvertTo-Json -Depth 5 -Compress))
    }
} finally { $probe.Dispose() }

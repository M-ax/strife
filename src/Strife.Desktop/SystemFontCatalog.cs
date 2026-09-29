using System.Runtime.InteropServices;

namespace Strife;

public sealed record FontBatch(string[] Families, int Next, bool Complete, string? Error);

// Discovery runs independently of voice and the bridge's command gate. The
// append-only process cache lets both pickers (and reloaded WebViews) page it.
public sealed class SystemFontCatalog
{
    public static SystemFontCatalog Shared { get; } = new();
    private readonly object sync = new();
    private readonly List<string> families = [];
    private readonly HashSet<string> seen = new(StringComparer.OrdinalIgnoreCase);
    private readonly Action<Action<string>> enumerate;
    private bool started, complete;
    private string? error;

    public SystemFontCatalog() : this(Enumerate) { }
    internal SystemFontCatalog(Action<Action<string>> enumerate) => this.enumerate = enumerate;

    public FontBatch Read(int offset)
    {
        lock (sync)
        {
            if (offset < 0 || offset > families.Count) throw new ArgumentException("Invalid font offset.");
            if (!started)
            {
                started = true;
                _ = Task.Run(() =>
                {
                    try { enumerate(Add); }
                    catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException
                        or InvalidOperationException or System.ComponentModel.Win32Exception)
                    {
                        lock (sync) error = "System fonts could not be loaded. Restart Strife to try again.";
                    }
                    finally { lock (sync) complete = true; }
                });
            }
            var batch = families.Skip(offset).Take(32).ToArray();
            var next = offset + batch.Length;
            return new(batch, next, complete && next == families.Count, error);
        }
    }

    private void Add(string name)
    {
        name = name.Trim();
        if (!AppearancePreferences.IsLocalFont("local:" + name) || name.StartsWith('@')) return;
        lock (sync) if (seen.Add(name)) families.Add(name);
    }

    private static void Enumerate(Action<string> add)
    {
        if (OperatingSystem.IsWindows()) EnumerateWindows(add);
        else if (OperatingSystem.IsMacOS()) EnumerateMac(add);
        else if (OperatingSystem.IsLinux()) EnumerateLinux(add);
        else throw new InvalidOperationException("Unsupported font platform.");
    }

    // LOGFONTW's face name starts after five LONGs and eight BYTEs. Using
    // explicit offsets avoids platform-dependent managed character layouts.
    private static void EnumerateWindows(Action<string> add)
    {
        var dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var filter = Marshal.AllocHGlobal(92);
        try
        {
            Marshal.Copy(new byte[92], 0, filter, 92);
            Marshal.WriteByte(filter, 23, 1); // DEFAULT_CHARSET: every character set.
            FontCallback callback = (font, _, _, _) =>
            {
                var name = Marshal.PtrToStringUni(IntPtr.Add(font, 28));
                if (name is not null) add(name);
                return 1;
            };
            EnumFontFamiliesExW(dc, filter, callback, IntPtr.Zero, 0);
            GC.KeepAlive(callback);
        }
        finally { Marshal.FreeHGlobal(filter); DeleteDC(dc); }
    }

    private static void EnumerateMac(Action<string> add)
    {
        var array = CTFontManagerCopyAvailableFontFamilyNames();
        if (array == IntPtr.Zero) throw new InvalidOperationException("Font discovery failed.");
        try
        {
            for (nint i = 0, count = CFArrayGetCount(array); i < count; i++)
            {
                var name = CFArrayGetValueAtIndex(array, i);
                var bytes = new byte[4096];
                if (CFStringGetCString(name, bytes, bytes.Length, 0x08000100))
                    add(System.Text.Encoding.UTF8.GetString(bytes, 0, Array.IndexOf(bytes, (byte)0)));
            }
        }
        finally { CFRelease(array); }
    }

    private static void EnumerateLinux(Action<string> add)
    {
        var config = FcInitLoadConfigAndFonts();
        if (config == IntPtr.Zero) throw new InvalidOperationException("Font discovery failed.");
        IntPtr pattern = IntPtr.Zero, objects = IntPtr.Zero, fonts = IntPtr.Zero;
        try
        {
            pattern = FcPatternCreate(); objects = FcObjectSetCreate();
            if (pattern == IntPtr.Zero || objects == IntPtr.Zero || !FcObjectSetAdd(objects, "family"))
                throw new InvalidOperationException("Font discovery failed.");
            fonts = FcFontList(config, pattern, objects);
            if (fonts == IntPtr.Zero) throw new InvalidOperationException("Font discovery failed.");
            var set = Marshal.PtrToStructure<FontSet>(fonts);
            for (var i = 0; i < set.Count; i++)
            {
                var font = Marshal.ReadIntPtr(set.Fonts, i * IntPtr.Size);
                for (var j = 0; FcPatternGetString(font, "family", j, out var value) == 0; j++)
                    if (Marshal.PtrToStringUTF8(value) is { } name) add(name);
            }
        }
        finally
        {
            if (fonts != IntPtr.Zero) FcFontSetDestroy(fonts);
            if (objects != IntPtr.Zero) FcObjectSetDestroy(objects);
            if (pattern != IntPtr.Zero) FcPatternDestroy(pattern);
            FcConfigDestroy(config);
        }
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate int FontCallback(IntPtr font, IntPtr metrics, uint type, IntPtr parameter);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", ExactSpelling = true)]
    private static extern int EnumFontFamiliesExW(IntPtr dc, IntPtr filter, FontCallback callback, IntPtr parameter, uint flags);

    private const string CoreText = "/System/Library/Frameworks/CoreText.framework/CoreText";
    private const string CoreFoundation = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
    [DllImport(CoreText)] private static extern IntPtr CTFontManagerCopyAvailableFontFamilyNames();
    [DllImport(CoreFoundation)] private static extern nint CFArrayGetCount(IntPtr array);
    [DllImport(CoreFoundation)] private static extern IntPtr CFArrayGetValueAtIndex(IntPtr array, nint index);
    [DllImport(CoreFoundation)] [return: MarshalAs(UnmanagedType.I1)]
    private static extern bool CFStringGetCString(IntPtr value, byte[] buffer, nint size, uint encoding);
    [DllImport(CoreFoundation)] private static extern void CFRelease(IntPtr value);

    [StructLayout(LayoutKind.Sequential)] private struct FontSet { public int Count, Capacity; public IntPtr Fonts; }
    private const string Fontconfig = "libfontconfig.so.1";
    [DllImport(Fontconfig)] private static extern IntPtr FcInitLoadConfigAndFonts();
    [DllImport(Fontconfig)] private static extern void FcConfigDestroy(IntPtr config);
    [DllImport(Fontconfig)] private static extern IntPtr FcPatternCreate();
    [DllImport(Fontconfig)] private static extern void FcPatternDestroy(IntPtr pattern);
    [DllImport(Fontconfig)] private static extern IntPtr FcObjectSetCreate();
    [DllImport(Fontconfig)] private static extern bool FcObjectSetAdd(IntPtr objects, [MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    [DllImport(Fontconfig)] private static extern void FcObjectSetDestroy(IntPtr objects);
    [DllImport(Fontconfig)] private static extern IntPtr FcFontList(IntPtr config, IntPtr pattern, IntPtr objects);
    [DllImport(Fontconfig)] private static extern void FcFontSetDestroy(IntPtr fonts);
    [DllImport(Fontconfig)] private static extern int FcPatternGetString(IntPtr pattern, [MarshalAs(UnmanagedType.LPUTF8Str)] string name, int index, out IntPtr value);
}

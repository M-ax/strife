using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;
using Photino.NET;

namespace Strife;

public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        var profile = Environment.GetEnvironmentVariable("STRIFE_PROFILE")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Strife");
        Directory.CreateDirectory(profile);
        using var profileLock = OpenProfileLock(profile);
        if (profileLock is null) return 1;
        var preferences = new PreferencesStore(profile);
        preferences.Load();
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel(options => options.ListenLocalhostForStrife());
        var server = builder.Build();
        server.Use(async (context, next) =>
        {
            context.Response.Headers["Content-Security-Policy"] =
                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
                "frame-src http: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
            context.Response.Headers["Referrer-Policy"] = "no-referrer";
            context.Response.Headers["X-Content-Type-Options"] = "nosniff";
            await next();
        });
        var files = new PhysicalFileProvider(Path.Combine(AppContext.BaseDirectory, "wwwroot"));
        server.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
        server.UseStaticFiles(new StaticFileOptions { FileProvider = files });
        server.StartAsync().GetAwaiter().GetResult();
        var address = server.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        var origin = new Uri(address + "/");
        var voice = new VoiceEngine(profile);
        var video = new HelltubeProxy(origin);
        var app = new PhotinoApplication();
        var window = new PhotinoWindow().SetTitle("Strife").SetUseOsDefaultSize(false).SetSize(1480, 900).SetMinSize(900, 620)
            .SetUserDataFolder(Path.Combine(profile, "webview"))
            .SetDevToolsEnabled(args.Contains("--devtools"))
            .SetMediaAutoplayEnabled(true).SetMediaStreamEnabled(true);
        var closing = false;
        void Publish(string message)
        {
            if (!closing) app.Dispatcher.BeginInvoke(() =>
            {
                if (!closing) window.SendWebMessage(message);
            });
        }
        var bridge = new DesktopBridge(preferences, voice, origin, Publish, () => app.Dispatcher.BeginInvoke(window.Close), video.LoadAsync);
        voice.Message += message => Publish(message.GetRawText());
        voice.Stopped += error => Publish(System.Text.Json.JsonSerializer.Serialize(new { type = "engine", ready = false, error }));
        window.RegisterCreatedHandler((_, _) => voice.OwnerWindow = window.WindowHandle);
        window.RegisterWebMessageReceivedHandler(async (_, e) => await bridge.ReceiveAsync(e.Uri, e.Message));
        window.RegisterNavigationStartingHandler((_, e) =>
        {
            if (e.Uri.GetLeftPart(UriPartial.Path) != origin.AbsoluteUri) e.Cancel = true;
        });
        window.RegisterClosingHandler((_, _) => closing = true);
        window.Load(origin.AbsoluteUri + "#" + bridge.Token);
        try { return app.Run(window); }
        finally
        {
            closing = true;
            voice.DisposeAsync().AsTask().GetAwaiter().GetResult();
            video.DisposeAsync().AsTask().GetAwaiter().GetResult();
            server.StopAsync().GetAwaiter().GetResult();
            server.DisposeAsync().AsTask().GetAwaiter().GetResult();
            files.Dispose();
        }
    }

    private static void ListenLocalhostForStrife(this Microsoft.AspNetCore.Server.Kestrel.Core.KestrelServerOptions options)
        => options.Listen(System.Net.IPAddress.Loopback, 0);

    private static FileStream? OpenProfileLock(string profile)
    {
        try { return new FileStream(Path.Combine(profile, "desktop.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException)
        {
            if (OperatingSystem.IsWindows())
                MessageBox(IntPtr.Zero, "Strife is already using this profile. Switch to its existing window.", "Strife", 0x40);
            return null;
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "MessageBoxW", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int MessageBox(IntPtr window, string text, string caption, uint type);
}

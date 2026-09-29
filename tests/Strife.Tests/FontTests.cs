using Strife;

internal static class FontTests
{
    public static async Task Run(Action<bool, string> check)
    {
        using var firstBatch = new ManualResetEventSlim();
        using var continueLoading = new ManualResetEventSlim();
        var calls = 0;
        var catalog = new SystemFontCatalog(add =>
        {
            Interlocked.Increment(ref calls);
            add("Zulu"); add("Alpha"); add("zulu"); add("@Vertical");
            firstBatch.Set();
            continueLoading.Wait(TimeSpan.FromSeconds(5));
            add("Beta");
        });
        check(!catalog.Read(0).Complete, "font discovery returns immediately while worker starts");
        check(await Task.Run(() => firstBatch.Wait(TimeSpan.FromSeconds(5))), "font worker begins discovery");
        try
        {
            var first = catalog.Read(0);
            check(first.Families.SequenceEqual(["Zulu", "Alpha"]) && !first.Complete && first.Next == 2,
                "font batches preserve discovery order and deduplicate variants before discovery finishes");
        }
        finally { continueLoading.Set(); }
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!catalog.Read(0).Complete && DateTime.UtcNow < deadline) await Task.Delay(10);
        var second = catalog.Read(2);
        check(second.Complete && second.Families.SequenceEqual(["Beta"]) && calls == 1,
            "both font readers reuse the same append-only cache");
        var fonts = new List<string>();
        FontBatch batch;
        deadline = DateTime.UtcNow.AddSeconds(20);
        do
        {
            batch = SystemFontCatalog.Shared.Read(fonts.Count); fonts.AddRange(batch.Families);
            if (!batch.Complete) await Task.Delay(10);
        } while (!batch.Complete && DateTime.UtcNow < deadline);
        check(batch.Complete && batch.Error is null && fonts.Count > 0, "installed system fonts enumerate through the platform API");
        check(fonts.Distinct(StringComparer.OrdinalIgnoreCase).Count() == fonts.Count && fonts.All(name => AppearancePreferences.IsLocalFont("local:" + name)),
            "installed font families are valid and unique");
        new AppearancePreferences(ChatFont: "local:" + fonts[0], UiFont: "local:Unicode 雪 \"Quoted\"").Validate();
        check(true, "appearance accepts installed font names and safe Unicode family names");
    }
}

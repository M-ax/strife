#requires -Version 7.0
# Deliberately separate from the Mumble cache inputs.
function Test-StrifeStreamingPayload {
    param([Parameter(Mandatory)][string]$Directory, [switch]$Smoke)
    $directoryPath = [IO.Path]::GetFullPath($Directory)
    $manifestPath = Join-Path $directoryPath 'build-info.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.runtime -ne 'win-x64' -or $manifest.prototype -ne $true -or
        $manifest.revision -ne 'b5bfb79093e26ce4b0e71d999f59b6b22f961121') {
        throw 'Unsupported streaming payload provenance.'
    }
    if (!$manifest.files -or $manifest.files.Count -gt 4096) { throw 'Invalid streaming file manifest.' }
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $prefix = $directoryPath.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    foreach ($entry in $manifest.files) {
        if (!$entry.path -or [IO.Path]::IsPathRooted($entry.path) -or $entry.path -match '(^|[/\\])\.\.([/\\]|$)|:' -or
            $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid streaming manifest path or hash.' }
        $path = [IO.Path]::GetFullPath((Join-Path $directoryPath $entry.path))
        if (!$path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or !$paths.Add($path)) {
            throw 'Duplicate or escaping streaming manifest entry.'
        }
        if (!(Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Streaming hash mismatch: $($entry.path)" }
    }
    foreach ($entry in Get-ChildItem -LiteralPath $directoryPath -Recurse -Force) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Streaming payload cannot contain links.' }
        if (!$entry.PSIsContainer -and $entry.FullName -ne $manifestPath -and !$paths.Contains($entry.FullName)) {
            throw "Unlisted streaming payload file: $($entry.Name)"
        }
    }
    $root = Split-Path $PSScriptRoot -Parent
    foreach ($entry in Get-ChildItem (Join-Path $root 'streaming') -Recurse -File) {
        $relative = [IO.Path]::GetRelativePath((Join-Path $root 'streaming'), $entry.FullName)
        $staged = Join-Path $directoryPath "source/$relative"
        if (!(Test-Path -LiteralPath $staged) -or (Get-FileHash $staged).Hash -ne (Get-FileHash $entry.FullName).Hash) {
            throw 'Streaming source changed since the payload was built. Rebuild streaming.'
        }
    }
    if ((Get-FileHash (Join-Path $directoryPath 'source/build-streaming.ps1')).Hash -ne
        (Get-FileHash (Join-Path $PSScriptRoot 'build-streaming.ps1')).Hash) { throw 'Streaming build recipe is stale.' }
    foreach ($required in @('OBS-LICENSE', 'bin/64bit/strife-stream.exe', 'obs-plugins/64bit/obs-webrtc.dll',
        'obs-plugins/64bit/win-wasapi.dll', 'bin/64bit/obs-nvenc-test.exe', 'bin/64bit/obs-qsv-test.exe', 'bin/64bit/obs-amf-test.exe')) {
        if (!(Test-Path -LiteralPath (Join-Path $directoryPath $required))) { throw "Missing streaming dependency: $required" }
    }
    if ($Smoke) {
        if (!$IsWindows) { throw 'Run the Windows streaming smoke test on Windows.' }
        $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $directoryPath 'bin/64bit/strife-stream.exe'))
        $start.WorkingDirectory = Split-Path $start.FileName -Parent
        $start.UseShellExecute = $false; $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
        $start.Environment['PATH'] = Join-Path $env:SystemRoot 'System32'
        $start.Environment.Remove('STRIFE_STREAM_TEST_FIXTURE') | Out-Null
        $process = [Diagnostics.Process]::Start($start)
        $diagnostics = $process.StandardError.ReadToEndAsync()
        try {
            $process.StandardInput.WriteLine('{"command":"sources"}')
            $line = $process.StandardOutput.ReadLineAsync().WaitAsync([TimeSpan]::FromSeconds(20)).GetAwaiter().GetResult()
            $reply = $line | ConvertFrom-Json
            if (!$reply.ok -or $reply.qualityVersion -ne 3 -or $reply.previewVersion -ne 1 -or $reply.audioVersion -ne 1) {
                throw 'Packaged streaming startup/protocol check failed.'
            }
            $process.StandardInput.Close()
            if (!$process.WaitForExit(5000) -or $process.ExitCode -ne 0) { throw 'Packaged streaming helper did not exit cleanly.' }
        } finally {
            if (!$process.HasExited) { $process.Kill($true); $process.WaitForExit() }
            $process.Dispose()
        }
        # A helper must never leave mutable plugin state in its install directory.
        Test-StrifeStreamingPayload -Directory $directoryPath
    }
}

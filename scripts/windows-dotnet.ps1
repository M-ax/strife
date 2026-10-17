# Shared packaging checks; no machine installation or network access on import.
function Get-StrifeDotNetFrameworks([string]$Directory) {
    $options = (Get-Content (Join-Path $Directory 'Strife.runtimeconfig.json') -Raw | ConvertFrom-Json).runtimeOptions
    $frameworks = @($options.frameworks)
    if ($options.includedFrameworks -or $options.rollForward -ne 'LatestPatch' -or $frameworks.Count -ne 2) {
        throw 'Installed payload must be framework-dependent with LatestPatch roll-forward and both required frameworks.'
    }
    foreach ($name in @('Microsoft.NETCore.App', 'Microsoft.AspNetCore.App')) {
        $matches = @($frameworks | Where-Object name -CEQ $name)
        if ($matches.Count -ne 1 -or $matches[0].version -cnotmatch '^\d+\.\d+\.\d+$') {
            throw "Missing or invalid framework requirement: $name"
        }
    }
    if (Test-Path (Join-Path $Directory 'coreclr.dll')) { throw 'Installed payload contains the bundled .NET runtime.' }
    return $frameworks
}

function Assert-StrifePortableRuntime([string]$Directory) {
    $options = (Get-Content (Join-Path $Directory 'Strife.runtimeconfig.json') -Raw | ConvertFrom-Json).runtimeOptions
    if ($options.framework -or $options.frameworks -or !$options.includedFrameworks -or
        !(Test-Path (Join-Path $Directory 'coreclr.dll'))) {
        throw 'Windows portable payload must retain its self-contained .NET runtime.'
    }
}

function Get-StrifeDotNetDownload($Framework, $Metadata) {
    $required = [version]$Framework.version
    $component = switch -CaseSensitive ($Framework.name) {
        'Microsoft.NETCore.App' { 'runtime' }
        'Microsoft.AspNetCore.App' { 'aspnetcore-runtime' }
        default { throw 'Unsupported .NET framework.' }
    }
    # Select only stable servicing releases within the required major/minor.
    $candidates = @($Metadata.releases | ForEach-Object { $_.$component } | Where-Object {
        $_.version -cmatch '^\d+\.\d+\.\d+$' -and
        ([version]$_.version).Major -eq $required.Major -and
        ([version]$_.version).Minor -eq $required.Minor -and
        [version]$_.version -ge $required
    } | Sort-Object { [version]$_.version } -Descending)
    if (!$candidates.Count) { throw "No compatible Microsoft release for $($Framework.name) $required." }
    $files = @($candidates[0].files | Where-Object { $_.rid -eq 'win-x64' -and $_.url.EndsWith('.exe') })
    if ($files.Count -ne 1 -or $files[0].url -cnotmatch '^https://' -or $files[0].hash -cnotmatch '^[a-fA-F0-9]{128}$') {
        throw "Missing or invalid Windows x64 installer metadata for $($Framework.name)."
    }
    return $files[0]
}

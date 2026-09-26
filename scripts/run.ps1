param([switch]$DevTools)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$arguments = @('run', '--project', (Join-Path $root 'src/Strife.Desktop/Strife.Desktop.csproj'), '-c', 'Release', '--')
if ($DevTools) { $arguments += '--devtools' }
& dotnet @arguments
exit $LASTEXITCODE

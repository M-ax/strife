param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Account-based installer tests may only run on disposable GitHub-hosted Windows runners.'
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$name = 'StrifeTest' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$password = ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'aA!9') -AsPlainText -Force
$credential = [pscredential]::new(".\$name", $password)
$stage = Join-Path $root 'artifacts/standard-user-test'
New-Item -ItemType Directory -Force $stage | Out-Null
try {
    New-LocalUser -Name $name -Password $password -AccountNeverExpires | Out-Null
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545').Name -Member $name
    & icacls $root /grant "${name}:(OI)(CI)M"
    if ($LASTEXITCODE) { throw 'Cannot grant test account access to the disposable workspace.' }
    $command = @"
`$ErrorActionPreference = 'Stop'
`$env:CI = 'true'
Set-Location '$($root.Replace("'", "''"))'
if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Installer tests must be non-elevated.' }
dotnet tool restore
if (`$LASTEXITCODE) { throw 'Cannot restore update test tool.' }
& ./tests/windows/installer.ps1 -Installer '$($Installer.Replace("'", "''"))'
& ./tests/windows/updates.ps1
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $process = Start-Process (Get-Process -Id $PID).Path -Credential $credential -LoadUserProfile -ArgumentList '-NoProfile', '-EncodedCommand', $encoded `
        -WorkingDirectory $root -RedirectStandardOutput (Join-Path $stage 'stdout.log') -RedirectStandardError (Join-Path $stage 'stderr.log') -PassThru
    if (!$process.WaitForExit(900000)) { $process.Kill($true); throw 'Standard-user installer test timed out.' }
    Get-Content (Join-Path $stage 'stdout.log')
    Get-Content (Join-Path $stage 'stderr.log')
    if ($process.ExitCode) { throw "Standard-user installer tests failed: $($process.ExitCode)" }
    Write-Host 'PASS: installer and OTA tests ran without administrator membership.'
} finally {
    if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $name }
}

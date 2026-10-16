param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Account-based installer tests may only run on disposable GitHub-hosted Windows runners.'
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$name = 'StrifeTest' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$password = ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'aA!9') -AsPlainText -Force
$credential = [pscredential]::new("$env:COMPUTERNAME\$name", $password)
$stage = Join-Path $root 'artifacts/standard-user-test'
New-Item -ItemType Directory -Force $stage | Out-Null
try {
    New-LocalUser -Name $name -Password $password -AccountNeverExpires | Out-Null
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545').Name -Member $name
    & icacls $root /grant "${name}:(OI)(CI)M"
    if ($LASTEXITCODE) { throw 'Cannot grant test account access to the disposable workspace.' }
    # CreateProcessWithLogonW limits its command line to 1024 characters.
    # Keep the test body in a file rather than passing an encoded script.
    $script = Join-Path $PSScriptRoot 'standard-user-tests.ps1'
    $process = Start-Process (Get-Process -Id $PID).Path -Credential $credential -LoadUserProfile `
        -ArgumentList "-NoProfile -File `"$script`" -Installer `"$Installer`"" -WorkingDirectory $root `
        -RedirectStandardOutput (Join-Path $stage 'stdout.log') -RedirectStandardError (Join-Path $stage 'stderr.log') -PassThru
    $completed = $process.WaitForExit(900000)
    if (!$completed) { $process.Kill($true) }
    Get-Content (Join-Path $stage 'stdout.log')
    Get-Content (Join-Path $stage 'stderr.log')
    if (!$completed) { throw 'Standard-user installer test timed out.' }
    if ($process.ExitCode) { throw "Standard-user installer tests failed: $($process.ExitCode)" }
    Write-Host 'PASS: installer and OTA tests ran without administrator membership.'
} finally {
    if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $name }
}

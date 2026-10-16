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
Start-Transcript -Path '$((Join-Path $stage 'stdout.log').Replace("'", "''"))' -Force
try {
if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Installer tests must be non-elevated.' }
dotnet tool restore
if (`$LASTEXITCODE) { throw 'Cannot restore update test tool.' }
& ./tests/windows/installer.ps1 -Installer '$($Installer.Replace("'", "''"))'
& ./tests/windows/updates.ps1
exit 0
} catch { Write-Output `$_; exit 1 } finally { Stop-Transcript }
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    # GitHub's service session does not support CreateProcessWithLogon reliably.
    # Task Scheduler gives the disposable account a normal batch logon/profile.
    $action = New-ScheduledTaskAction -Execute (Get-Process -Id $PID).Path -Argument "-NoProfile -EncodedCommand $encoded" -WorkingDirectory $root
    Register-ScheduledTask -TaskName $name -Action $action -User "$env:COMPUTERNAME\$name" `
        -Password $credential.GetNetworkCredential().Password -RunLevel Limited | Out-Null
    $before = (Get-ScheduledTaskInfo -TaskName $name).LastRunTime
    Start-ScheduledTask -TaskName $name
    $deadline = [DateTime]::UtcNow.AddMinutes(15)
    do {
        Start-Sleep -Seconds 2
        $info = Get-ScheduledTaskInfo -TaskName $name
        $state = (Get-ScheduledTask -TaskName $name).State
    } while (($info.LastRunTime -le $before -or $state -in @('Running', 'Queued')) -and [DateTime]::UtcNow -lt $deadline)
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Standard-user installer test timed out.' }
    Get-Content (Join-Path $stage 'stdout.log')
    if ($info.LastTaskResult) { throw "Standard-user installer tests failed: $($info.LastTaskResult)" }
    Write-Host 'PASS: installer and OTA tests ran without administrator membership.'
} finally {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $name
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
    if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $name }
}

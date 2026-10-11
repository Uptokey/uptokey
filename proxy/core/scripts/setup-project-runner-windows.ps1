# Official WSL + Podman setup for the existing Uptokey OCI runtime.
# Run explicitly in an administrator PowerShell. No automatic reboot or daemon restart.
[CmdletBinding()]
param([switch]$InstallHost, [switch]$PrepareMachine)
$ErrorActionPreference = 'Stop'
$taskPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$taskAdmin = $taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($InstallHost) {
    if (-not $taskAdmin) { throw 'Administrator PowerShell is required to install WSL. No changes made.' }
    # wsl.exe may be absent (WSL never installed) or exit non-zero: neither may abort under ErrorActionPreference Stop.
    $wslReady = $false
    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
        $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { & wsl.exe --status *> $null; $wslReady = ($LASTEXITCODE -eq 0) } catch { $wslReady = $false } finally { $ErrorActionPreference = $previous }
    }
    if (-not $wslReady) {
        & wsl.exe --install --no-distribution --no-launch
        if ($LASTEXITCODE -notin @(0,3010)) { throw 'WSL installation did not complete. Review Windows output.' }
        Write-Output 'WSL installation requested. If Windows requests a restart, restart manually before PrepareMachine.'
    }
    & winget.exe install --id RedHat.Podman --exact --version 5.8.3 --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity --silent
    if ($LASTEXITCODE -notin @(0,3010)) { throw 'Podman installation did not complete. Review winget output.' }
}
if ($PrepareMachine) {
    $taskPodman = Get-Command podman.exe -ErrorAction SilentlyContinue
    if (-not $taskPodman) { throw 'Open a new PowerShell after installing Podman so PATH is refreshed.' }
    # The default machine and unrelated VMs are never reset, stopped, or deleted.
    $env:CONTAINERS_MACHINE_PROVIDER = 'wsl'
    & podman.exe machine inspect uptokey-runner *> $null
    if ($LASTEXITCODE -ne 0) {
        & podman.exe machine init --rootful=false --cpus=2 --memory=2048 uptokey-runner
        if ($LASTEXITCODE -ne 0) { throw 'Podman machine initialization failed; no native execution fallback is used.' }
    }
    $taskMachine = (& podman.exe machine inspect uptokey-runner | ConvertFrom-Json)[0]
    if ($taskMachine.State -ne 'running') {
        & podman.exe machine start uptokey-runner
        if ($LASTEXITCODE -ne 0) { throw 'Podman machine failed to start.' }
    }
    # --userns=auto needs a subordinate ID range for the 'containers' user inside the machine.
    & podman.exe machine ssh uptokey-runner "grep -q '^containers:' /etc/subuid || echo 'containers:2147483647:2147483648' | sudo tee -a /etc/subuid /etc/subgid >/dev/null"
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the subordinate ID range for --userns=auto.' }
    $env:UPTOKEY_PODMAN_CONNECTION = 'uptokey-runner'
    # On WSL, rootless containers cannot enforce memory limits: opt in to the rootful connection explicitly with
    # UPTOKEY_PODMAN_CONNECTION=uptokey-runner-root and UPTOKEY_RUNNER_ALLOW_ROOTFUL=1.
    Write-Output 'Machine prepared. In this shell run: node proxy/core/scripts/setup-project-runner.mjs --prepare-images'
}
if (-not $InstallHost -and -not $PrepareMachine) {
    [pscustomobject]@{Administrator=$taskAdmin;PodmanAvailable=[bool](Get-Command podman.exe -ErrorAction SilentlyContinue);Install='-InstallHost';Machine='-PrepareMachine'} | ConvertTo-Json -Compress
}

#Requires -RunAsAdministrator
<#
  Install FridaMcpDaemon as a Windows service via NSSM.
  Prerequisites: pnpm build already run; tools verified on device.
#>
param(
  [string]$ServiceName = "FridaMcpDaemon",
  [string]$RepoRoot = "D:\Project\tk\frida-mcp",
  [int]$Port = 18765
)

$ErrorActionPreference = "Stop"

function Find-Nssm {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "D:\Project\nssm\nssm.exe",
    "C:\Program Files\nssm\nssm.exe",
    "C:\tools\nssm\nssm.exe"
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  throw "nssm not found on PATH or known locations"
}

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "node.exe not found on PATH" }
  return $cmd.Source
}

$nssm = Find-Nssm
$node = Find-Node
$daemonJs = Join-Path $RepoRoot "dist\daemon.js"
$logs = Join-Path $RepoRoot "logs"

if (-not (Test-Path $daemonJs)) {
  throw "Missing $daemonJs — run: cd $RepoRoot; pnpm build"
}
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$existing = & $nssm status $ServiceName 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Service $ServiceName already exists. Removing..."
  & $nssm stop $ServiceName 2>$null
  & $nssm remove $ServiceName confirm
}

& $nssm install $ServiceName $node
& $nssm set $ServiceName AppDirectory $RepoRoot
& $nssm set $ServiceName AppParameters $daemonJs
& $nssm set $ServiceName AppEnvironmentExtra "FRIDA_MCP_PORT=$Port" "FRIDA_MCP_HOST=127.0.0.1"
& $nssm set $ServiceName AppStdout (Join-Path $logs "daemon.stdout.log")
& $nssm set $ServiceName AppStderr (Join-Path $logs "daemon.stderr.log")
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName Description "Frida iOS MCP session daemon (TCP 127.0.0.1:$Port)"

Write-Host "Installed $ServiceName"
Write-Host "Start:  nssm start $ServiceName"
Write-Host "Or:     Start-Service $ServiceName"
Write-Host "MCP:    set FRIDA_MCP_MODE=daemon (or FRIDA_MCP_DAEMON=1) for thin stdio client"

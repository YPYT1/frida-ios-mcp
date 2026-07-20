#Requires -RunAsAdministrator
param(
  [string]$ServiceName = "FridaMcpDaemon"
)

$ErrorActionPreference = "Stop"

function Find-Nssm {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "D:\Project\nssm\nssm.exe",
    "C:\Program Files\nssm\nssm.exe"
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  throw "nssm not found"
}

$nssm = Find-Nssm
& $nssm stop $ServiceName 2>$null
& $nssm remove $ServiceName confirm
Write-Host "Removed $ServiceName"

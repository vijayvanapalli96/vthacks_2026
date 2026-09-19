[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'Hirewire'
$credentialPath = Join-Path $credentialDirectory 'ans-credential.clixml'

New-Item -ItemType Directory -Force -Path $credentialDirectory | Out-Null

$key = Read-Host 'GoDaddy classic API key' -AsSecureString
$secret = Read-Host 'GoDaddy classic API secret' -AsSecureString

[pscustomobject]@{
  Key = ConvertFrom-SecureString $key
  Secret = ConvertFrom-SecureString $secret
  StoredAt = (Get-Date).ToUniversalTime().ToString('o')
} | Export-Clixml -LiteralPath $credentialPath

Write-Host "ANS credential encrypted for the current Windows user at $credentialPath"
Write-Host 'Load it into a PowerShell session by dot-sourcing load-ans-credential.ps1.'

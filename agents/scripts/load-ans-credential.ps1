[CmdletBinding()]
param(
  [ValidateSet('ote', 'production')]
  [string]$Environment = 'production'
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path $env:LOCALAPPDATA 'Hirewire\ans-credential.clixml'
if (-not (Test-Path -LiteralPath $credentialPath)) {
  throw "No encrypted ANS credential found. Run store-ans-credential.ps1 first."
}

$stored = Import-Clixml -LiteralPath $credentialPath
$keySecure = ConvertTo-SecureString $stored.Key
$secretSecure = ConvertTo-SecureString $stored.Secret
$key = [System.Net.NetworkCredential]::new('', $keySecure).Password
$secret = [System.Net.NetworkCredential]::new('', $secretSecure).Password

$env:ANS_API_KEY = "${key}:${secret}"
$env:ANS_BASE_URL = if ($Environment -eq 'production') {
  'https://api.godaddy.com'
} else {
  'https://api.ote-godaddy.com'
}

Remove-Variable key, secret, keySecure, secretSecure
Write-Host "ANS credential loaded into this PowerShell process for $Environment."

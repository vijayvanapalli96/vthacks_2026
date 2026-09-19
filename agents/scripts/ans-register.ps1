[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9.-]+\.[a-z]{2,}$')]
  [string]$Domain,

  [Parameter(Mandatory = $true)]
  [string]$Organization,

  [string]$Version = '1.0.0',
  [string]$BaseUrl = 'https://api.godaddy.com',
  [switch]$Register
)

$ErrorActionPreference = 'Stop'

$cli = Get-Command ans-cli -ErrorAction SilentlyContinue
if (-not $cli) {
  throw 'ans-cli is not on PATH. Open a new PowerShell window and retry.'
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$certRoot = Join-Path $repoRoot 'certs'
$agents = @(
  @{
    Slug = 'applicant'
    Name = 'Hirewire Applicant Agent'
    Description = 'Candidate-controlled agent that verifies employers and releases approved application fields.'
    Function = 'verify-and-apply:Verify Employer and Apply:identity,trust,privacy'
  },
  @{
    Slug = 'employer'
    Name = 'Hirewire Employer Agent'
    Description = 'Demo employer agent that receives privacy-gated job application packets.'
    Function = 'receive-application:Receive Job Application:jobs,a2a,privacy'
  }
)

foreach ($agent in $agents) {
  $hostName = "$($agent.Slug).$Domain"
  $outDir = Join-Path $certRoot $agent.Slug
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  if (-not (Test-Path (Join-Path $outDir 'identity.csr'))) {
    & $cli.Source generate-csr `
      --host $hostName `
      --org $Organization `
      --version $Version `
      --country US `
      --out-dir $outDir
    if ($LASTEXITCODE -ne 0) { throw "CSR generation failed for $hostName" }
  } else {
    Write-Host "Keeping existing CSR and private keys for $hostName"
  }
}

if (-not $Register) {
  Write-Host ''
  Write-Host "CSRs generated under $certRoot. No registration request was sent."
  Write-Host 'After both public HTTPS endpoints resolve, rerun this command with -Register.'
  exit 0
}

if (-not $env:ANS_API_KEY -and -not $env:ANS_OAUTH_TOKEN) {
  throw 'Set ANS_API_KEY or ANS_OAUTH_TOKEN in this PowerShell session before registration.'
}
if ($env:ANS_API_KEY -and $env:ANS_API_KEY -notmatch '^[^:]+:[^:]+$') {
  throw 'ANS_API_KEY must contain the classic GoDaddy key and secret in key:secret format.'
}

$env:ANS_BASE_URL = $BaseUrl
foreach ($agent in $agents) {
  $hostName = "$($agent.Slug).$Domain"
  $outDir = Join-Path $certRoot $agent.Slug
  Write-Host "Registering $hostName against $BaseUrl"
  & $cli.Source register `
    --name $agent.Name `
    --host $hostName `
    --version $Version `
    --description $agent.Description `
    --identity-csr (Join-Path $outDir 'identity.csr') `
    --server-csr (Join-Path $outDir 'server.csr') `
    --endpoint-url "https://$hostName/a2a/apply" `
    --metadata-url "https://$hostName/.well-known/agent-card.json" `
    --endpoint-protocol A2A `
    --endpoint-transports STREAMABLE-HTTP `
    --function $agent.Function `
    --json
  if ($LASTEXITCODE -ne 0) { throw "Registration failed for $hostName" }
}

Write-Host ''
Write-Host 'Copy each returned agentId and DNS challenge. Add the TXT records before running verify-acme.'

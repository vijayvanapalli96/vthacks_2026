param(
  [Parameter(Mandatory = $true)]
  [string]$HostIp,
  [string]$SshUser = "root",
  [string]$IdentityFile
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$identityArgs = @()
if ($IdentityFile) {
  $resolvedIdentity = (Resolve-Path $IdentityFile).Path
  $identityArgs = @("-i", $resolvedIdentity)
}

$requiredFiles = @(
  (Join-Path $repoRoot "certs/employer/server.crt.pem"),
  (Join-Path $repoRoot "certs/employer/server.key"),
  (Join-Path $repoRoot "certs/applicant/server.crt.pem"),
  (Join-Path $repoRoot "certs/applicant/server.key")
)
foreach ($requiredFile in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $requiredFile)) {
    throw "Missing required deployment file: $requiredFile"
  }
}

$stagingRoot = Join-Path $repoRoot "work/vultr-deploy"
if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/employer") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/applicant") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/shared") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingRoot "certs") -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $PSScriptRoot "docker-compose.yml") -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Caddyfile") -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/Dockerfile") -Destination (Join-Path $stagingRoot "agents/employer")
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/server.mjs") -Destination (Join-Path $stagingRoot "agents/employer")
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/agent-card.json") -Destination (Join-Path $stagingRoot "agents/employer")
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/applicant/Dockerfile") -Destination (Join-Path $stagingRoot "agents/applicant")
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/applicant/server.mjs") -Destination (Join-Path $stagingRoot "agents/applicant")
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/applicant/agent-card.json") -Destination (Join-Path $stagingRoot "agents/applicant")
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/remote-agent.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/trust-policy.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/mutual-match.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
Copy-Item -LiteralPath $requiredFiles[0] -Destination (Join-Path $stagingRoot "certs/employer.leaf.pem")
Copy-Item -LiteralPath $requiredFiles[1] -Destination (Join-Path $stagingRoot "certs/employer.key")
Copy-Item -LiteralPath $requiredFiles[2] -Destination (Join-Path $stagingRoot "certs/applicant.leaf.pem")
Copy-Item -LiteralPath $requiredFiles[3] -Destination (Join-Path $stagingRoot "certs/applicant.key")

# The ANS leaf chains to "GoDaddy TLS Root CA - R1", which Node's bundled root
# store (and so the Databricks app and both agents) does not trust yet. GoDaddy's
# DV bundle adds R1 cross-signed by "Go Daddy Root Certificate Authority - G2",
# which Node does trust. Serve leaf + intermediate + cross-signed R1; the
# self-signed G2 root at the end of the bundle is left out, as clients hold it.
$bundlePath = Join-Path $stagingRoot "certs/godaddy-dv-r1-g2-bundle.pem"
Invoke-WebRequest -Uri "https://certs.godaddy.com/repository/gd_bundle_dv-r1-g2.crt.pem" -OutFile $bundlePath
$bundleText = Get-Content -Raw -LiteralPath $bundlePath
$bundlePems = [regex]::Matches($bundleText, '-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----') | ForEach-Object { $_.Value }
if ($bundlePems.Count -lt 2) { throw "The GoDaddy DV bundle did not contain the expected certificates." }

$sha256 = [System.Security.Cryptography.SHA256]::Create()
function Get-PemFingerprint([string]$pem) {
  $base64 = ($pem -replace '-----(BEGIN|END) CERTIFICATE-----', '') -replace '\s', ''
  $der = [Convert]::FromBase64String($base64)
  ([BitConverter]::ToString($sha256.ComputeHash($der))).Replace('-', '')
}
$pinned = @(
  @{ Name = "GoDaddy TLS Intermediate CA DV - R1v1"; Fingerprint = "7A43BC7747D0633FBD90FF900C9242417C027DBDCA05AF72DA9A70E3518DBE2E" },
  @{ Name = "GoDaddy TLS Root CA - R1 (cross-signed by G2)"; Fingerprint = "7BCB0F2F2D1031A6AF8D61BAA835D2835A3B8BCC26D94A3B048B1655FB81298C" }
)
for ($i = 0; $i -lt $pinned.Count; $i++) {
  if ((Get-PemFingerprint $bundlePems[$i]) -ne $pinned[$i].Fingerprint) {
    throw "The downloaded $($pinned[$i].Name) fingerprint did not match the pinned value."
  }
}
$chainPem = $bundlePems[0].Trim() + "`n" + $bundlePems[1].Trim() + "`n"
foreach ($kind in "employer", "applicant") {
  $leafPem = Get-Content -Raw -LiteralPath (Join-Path $stagingRoot "certs/$kind.leaf.pem")
  [System.IO.File]::WriteAllText(
    (Join-Path $stagingRoot "certs/$kind.fullchain.pem"),
    $leafPem.TrimEnd() + "`n" + $chainPem
  )
}

$archive = Join-Path $repoRoot "work/hirewire-vultr.tgz"
tar -czf $archive -C $stagingRoot .
if ($LASTEXITCODE -ne 0) { throw "Could not create deployment archive." }

$destination = "${SshUser}@${HostIp}"
ssh @identityArgs $destination "mkdir -p /opt/hirewire"
if ($LASTEXITCODE -ne 0) { throw "Could not prepare /opt/hirewire on the server." }
scp @identityArgs $archive "${destination}:/tmp/hirewire-vultr.tgz"
if ($LASTEXITCODE -ne 0) { throw "Could not upload the deployment archive." }
# Docker writes progress to stderr; fold it into stdout so Windows PowerShell 5.1
# does not treat build progress as a failure. The exit code still decides success.
ssh @identityArgs $destination "tar -xzf /tmp/hirewire-vultr.tgz -C /opt/hirewire && chmod 600 /opt/hirewire/certs/employer.key /opt/hirewire/certs/applicant.key && cd /opt/hirewire && docker compose up -d --build --quiet-pull 2>&1"
if ($LASTEXITCODE -ne 0) { throw "Remote Docker deployment failed." }

Write-Host "Both agents deployed. Point employer.hirewire.biz and applicant.hirewire.biz A records to $HostIp, then run verify-public.ps1."

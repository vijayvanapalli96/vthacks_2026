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
Copy-Item -LiteralPath $requiredFiles[0] -Destination (Join-Path $stagingRoot "certs/employer.leaf.pem")
Copy-Item -LiteralPath $requiredFiles[1] -Destination (Join-Path $stagingRoot "certs/employer.key")
Copy-Item -LiteralPath $requiredFiles[2] -Destination (Join-Path $stagingRoot "certs/applicant.leaf.pem")
Copy-Item -LiteralPath $requiredFiles[3] -Destination (Join-Path $stagingRoot "certs/applicant.key")

$intermediatePath = Join-Path $stagingRoot "certs/godaddy-dv-r1v1.pem"
Invoke-WebRequest -Uri "https://certs.godaddy.com/repository/gd_tls_issuing_dv-r1v1.crt.pem" -OutFile $intermediatePath
$intermediateText = Get-Content -Raw -LiteralPath $intermediatePath
$intermediateBase64 = $intermediateText -replace '-----BEGIN CERTIFICATE-----', ''
$intermediateBase64 = $intermediateBase64 -replace '-----END CERTIFICATE-----', ''
$intermediateBase64 = $intermediateBase64 -replace '\s', ''
$intermediateDer = [Convert]::FromBase64String([string]$intermediateBase64)
$intermediateCertificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$intermediateDer)
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$certificateBytes = [byte[]]$intermediateCertificate.RawData
$actualFingerprint = ([BitConverter]::ToString($sha256.ComputeHash($certificateBytes))).Replace('-', '')
$expectedFingerprint = "7A43BC7747D0633FBD90FF900C9242417C027DBDCA05AF72DA9A70E3518DBE2E"
if ($actualFingerprint -ne $expectedFingerprint) {
  throw "The downloaded GoDaddy intermediate certificate fingerprint did not match the official repository."
}
$intermediatePem = $intermediateText
foreach ($kind in "employer", "applicant") {
  $leafPem = Get-Content -Raw -LiteralPath (Join-Path $stagingRoot "certs/$kind.leaf.pem")
  [System.IO.File]::WriteAllText(
    (Join-Path $stagingRoot "certs/$kind.fullchain.pem"),
    $leafPem.TrimEnd() + "`n" + $intermediatePem.Trim() + "`n"
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
ssh @identityArgs $destination "tar -xzf /tmp/hirewire-vultr.tgz -C /opt/hirewire && chmod 600 /opt/hirewire/certs/employer.key /opt/hirewire/certs/applicant.key && cd /opt/hirewire && docker compose up -d --build"
if ($LASTEXITCODE -ne 0) { throw "Remote Docker deployment failed." }

Write-Host "Both agents deployed. Point employer.hirewire.biz and applicant.hirewire.biz A records to $HostIp, then run verify-public.ps1."

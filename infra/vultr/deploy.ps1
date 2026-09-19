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
  (Join-Path $repoRoot "certs/employer/server.key")
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
New-Item -ItemType Directory -Path (Join-Path $stagingRoot "certs") -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $PSScriptRoot "docker-compose.yml") -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Caddyfile") -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/Dockerfile") -Destination (Join-Path $stagingRoot "agents/employer")
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/server.mjs") -Destination (Join-Path $stagingRoot "agents/employer")
Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/agent-card.json") -Destination (Join-Path $stagingRoot "agents/employer")
Copy-Item -LiteralPath $requiredFiles[0] -Destination (Join-Path $stagingRoot "certs/server.crt.pem")
Copy-Item -LiteralPath $requiredFiles[1] -Destination (Join-Path $stagingRoot "certs/server.key")

$archive = Join-Path $repoRoot "work/hirewire-vultr.tgz"
tar -czf $archive -C $stagingRoot .
if ($LASTEXITCODE -ne 0) { throw "Could not create deployment archive." }

$destination = "${SshUser}@${HostIp}"
ssh @identityArgs $destination "mkdir -p /opt/hirewire"
if ($LASTEXITCODE -ne 0) { throw "Could not prepare /opt/hirewire on the server." }
scp @identityArgs $archive "${destination}:/tmp/hirewire-vultr.tgz"
if ($LASTEXITCODE -ne 0) { throw "Could not upload the deployment archive." }
ssh @identityArgs $destination "tar -xzf /tmp/hirewire-vultr.tgz -C /opt/hirewire && chmod 600 /opt/hirewire/certs/server.key && cd /opt/hirewire && docker compose up -d --build"
if ($LASTEXITCODE -ne 0) { throw "Remote Docker deployment failed." }

Write-Host "Employer agent deployed. Point employer.hirewire.biz A to $HostIp, then run verify-public.ps1."

param(
  [Parameter(Mandatory = $true)]
  [string]$HostIp,
  [string]$SshUser = "root",
  [string]$IdentityFile,
  # The web app's own Databricks identity. Databricks Apps injected these for us;
  # off-platform we carry our own service principal. Secret is never written to
  # the repo - pass it, or export HIREWIRE_DB_CLIENT_SECRET.
  [string]$DatabricksProfile = "DEFAULT",
  [string]$DatabricksClientId = $env:HIREWIRE_DB_CLIENT_ID,
  [string]$DatabricksClientSecret = $env:HIREWIRE_DB_CLIENT_SECRET,
  [string]$AppOrigin = "https://hirewire.biz",
  # Ship only the web app, Caddyfile and compose file. The agents and their ANS
  # key material stay exactly as they are on the server, so app deploys do not
  # need the certs/ directory present locally at all.
  [switch]$AppOnly,
  # The ATS worker is opt-in. Without this the deployed stack is exactly what it
  # was before that service existed, so a broken Chromium build cannot take the
  # employer and applicant agents down with it.
  [switch]$IncludeAts
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
if (-not $AppOnly) {
  foreach ($requiredFile in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
      throw "Missing required deployment file: $requiredFile"
    }
  }
}

$stagingRoot = Join-Path $repoRoot "work/vultr-deploy"
if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $stagingRoot "app") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "docker-compose.yml") -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Caddyfile") -Destination $stagingRoot

# The agents and their ANS key material. Skipped by -AppOnly: they are already
# on the server and unchanged, and an app deploy has no business handling the
# identity keys.
if (-not $AppOnly) {
  New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/employer") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/applicant") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/shared") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingRoot "certs") -Force | Out-Null
  if ($IncludeAts) {
    New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/ats") -Force | Out-Null
  }

  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/Dockerfile") -Destination (Join-Path $stagingRoot "agents/employer")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/server.mjs") -Destination (Join-Path $stagingRoot "agents/employer")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/agent-card.json") -Destination (Join-Path $stagingRoot "agents/employer")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/applicant/Dockerfile") -Destination (Join-Path $stagingRoot "agents/applicant")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/applicant/server.mjs") -Destination (Join-Path $stagingRoot "agents/applicant")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/applicant/agent-card.json") -Destination (Join-Path $stagingRoot "agents/applicant")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/remote-agent.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/trust-policy.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/mutual-match.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/signed-envelope.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
  if ($IncludeAts) {
    foreach ($atsFile in "Dockerfile", "server.mjs", "providers.mjs", "form-filler.mjs") {
      Copy-Item -LiteralPath (Join-Path $repoRoot "agents/ats/$atsFile") -Destination (Join-Path $stagingRoot "agents/ats")
    }
    # docker compose reads ATS_WORKER_TOKEN from a .env beside the compose file and
    # refuses to start the service without it. Fail here, with a useful message,
    # rather than half-deploying and leaving the stack down.
    $atsEnv = Join-Path $PSScriptRoot ".env"
    if (-not (Test-Path -LiteralPath $atsEnv)) {
      throw "Missing $atsEnv. Copy infra/vultr/.env.example to .env and set ATS_WORKER_TOKEN before deploying with -IncludeAts."
    }
    Copy-Item -LiteralPath $atsEnv -Destination (Join-Path $stagingRoot ".env")
  }
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
}

# ---------------------------------------------------------------------------
# The web app. It is served from here rather than Databricks Apps because that
# platform gates every anonymous request behind a workspace OAuth login, so a
# visitor without a Databricks account can never reach our own sign-in page.
# ---------------------------------------------------------------------------
if (-not $DatabricksClientId -or -not $DatabricksClientSecret) {
  throw "Pass -DatabricksClientId and -DatabricksClientSecret (or set HIREWIRE_DB_CLIENT_ID / HIREWIRE_DB_CLIENT_SECRET). The app cannot reach the SQL warehouse without them, and nobody can sign in."
}

$appSource = Join-Path $repoRoot "app/vthacks-career-app"
# robocopy returns 0-7 for success; 8+ is a real failure.
robocopy $appSource (Join-Path $stagingRoot "app") /MIR /NFL /NDL /NJH /NJS /NP `
  /XD node_modules .next .git .databricks `
  /XF ".env" ".env.local" "*.tsbuildinfo" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Could not stage the app source (robocopy exit $LASTEXITCODE)." }
$global:LASTEXITCODE = 0

# One source of truth for the runtime secrets: the `hirewire` Databricks secret
# scope, the same one the Databricks App reads. Written to a gitignored staging
# file, shipped inside the archive, and never committed.
# Google sign-in is optional by design: src/lib/providers.ts hides the button
# when the client is not configured, so a missing key degrades to email/password
# rather than to a button that throws when pressed.
function Get-OptionalHirewireSecret([string]$key) {
  $json = databricks secrets get-secret hirewire $key -p $DatabricksProfile 2>$null | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $json) { $global:LASTEXITCODE = 0; return $null }
  [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($json.value))
}

function Get-HirewireSecret([string]$key) {
  $json = databricks secrets get-secret hirewire $key -p $DatabricksProfile | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Could not read secret '$key' from scope 'hirewire'." }
  [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($json.value))
}

# Multi-line PEMs cannot survive a Docker env_file; src/lib/ans/envelope.ts
# un-escapes \n for exactly this case.
function ConvertTo-EnvLine([string]$name, [string]$value) {
  "$name=" + ($value -replace "`r`n", "`n" -replace "`n", "\n")
}

$appEnv = @(
  "AUTH_URL=$AppOrigin",
  "AUTH_TRUST_HOST=true",
  (ConvertTo-EnvLine "AUTH_SECRET" (Get-HirewireSecret "auth-secret")),
  "DATABRICKS_HOST=https://dbc-0bfd7b56-c2eb.cloud.databricks.com",
  "DATABRICKS_WAREHOUSE_ID=441b670a0ff475e0",
  "DATABRICKS_CLIENT_ID=$DatabricksClientId",
  "DATABRICKS_CLIENT_SECRET=$DatabricksClientSecret",
  (ConvertTo-EnvLine "APPLICANT_IDENTITY_KEY" (Get-HirewireSecret "applicant-identity-key")),
  (ConvertTo-EnvLine "APPLICANT_IDENTITY_CERT" (Get-HirewireSecret "applicant-identity-cert")),
  (ConvertTo-EnvLine "EMPLOYER_IDENTITY_KEY" (Get-HirewireSecret "employer-identity-key")),
  (ConvertTo-EnvLine "EMPLOYER_IDENTITY_CERT" (Get-HirewireSecret "employer-identity-cert")),
  (ConvertTo-EnvLine "MONGODB_URI" (Get-HirewireSecret "mongodb-uri"))
)

$googleId = Get-OptionalHirewireSecret "google-client-id"
$googleSecret = Get-OptionalHirewireSecret "google-client-secret"
if ($googleId -and $googleSecret) {
  $appEnv += (ConvertTo-EnvLine "AUTH_GOOGLE_ID" $googleId)
  $appEnv += (ConvertTo-EnvLine "AUTH_GOOGLE_SECRET" $googleSecret)
  Write-Host "Google sign-in: configured."
} else {
  Write-Host "Google sign-in: not configured (no google-client-id/google-client-secret in the hirewire scope). Email and password still work."
}

# Keys that never made it into the Databricks scope (ElevenLabs, Gemini, Google
# OAuth) go in this gitignored file, one KEY=value per line. Absent is fine:
# every feature behind them degrades to a stated reason, not a crash.
$extras = Join-Path $PSScriptRoot "app.env.local"
if (Test-Path -LiteralPath $extras) {
  $appEnv += (Get-Content -LiteralPath $extras | Where-Object { $_ -match "^[A-Z0-9_]+=" })
}

[System.IO.File]::WriteAllText((Join-Path $stagingRoot "app.env"), ($appEnv -join "`n") + "`n")

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
$composeProfile = if ($IncludeAts) { "--profile ats " } else { "" }
ssh @identityArgs $destination "tar -xzf /tmp/hirewire-vultr.tgz -C /opt/hirewire && chmod 600 /opt/hirewire/certs/employer.key /opt/hirewire/certs/applicant.key /opt/hirewire/app.env && cd /opt/hirewire && docker compose ${composeProfile}up -d --build --quiet-pull 2>&1"
if ($LASTEXITCODE -ne 0) { throw "Remote Docker deployment failed." }

Write-Host "App and both agents deployed."
Write-Host "Point hirewire.biz, www, employer and applicant A records to $HostIp, then run verify-public.ps1."

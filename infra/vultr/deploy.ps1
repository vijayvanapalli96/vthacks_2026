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

# The ATS worker. Independent of -AppOnly: it carries no ANS key material, so
# there is no reason for it to ride along with the agent certificates.
if ($IncludeAts) {
  New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/ats") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/shared") -Force | Out-Null
  foreach ($atsFile in "Dockerfile", "server.mjs", "providers.mjs", "form-filler.mjs") {
    Copy-Item -LiteralPath (Join-Path $repoRoot "agents/ats/$atsFile") -Destination (Join-Path $stagingRoot "agents/ats")
  }
  # server.mjs imports ../shared/audit.mjs. Under -AppOnly the shared directory
  # is not staged, so without this the worker builds and then dies on start with
  # ERR_MODULE_NOT_FOUND.
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/audit.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
  # docker compose reads ATS_WORKER_TOKEN from a .env beside the compose file and
  # refuses to start the service without it. Fail here, with a useful message,
  # rather than half-deploying and leaving the stack down.
  $atsEnv = Join-Path $PSScriptRoot ".env"
  if (-not (Test-Path -LiteralPath $atsEnv)) {
    throw "Missing $atsEnv. Copy infra/vultr/.env.example to .env and set ATS_WORKER_TOKEN before deploying with -IncludeAts."
  }
  Copy-Item -LiteralPath $atsEnv -Destination (Join-Path $stagingRoot ".env")
}

# The agents and their ANS key material. Skipped by -AppOnly: they are already
# on the server and unchanged, and an app deploy has no business handling the
# identity keys.
if (-not $AppOnly) {
  New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/employer") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/applicant") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingRoot "agents/shared") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingRoot "certs") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/Dockerfile") -Destination (Join-Path $stagingRoot "agents/employer")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/server.mjs") -Destination (Join-Path $stagingRoot "agents/employer")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/employer/agent-card.json") -Destination (Join-Path $stagingRoot "agents/employer")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/applicant/Dockerfile") -Destination (Join-Path $stagingRoot "agents/applicant")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/applicant/server.mjs") -Destination (Join-Path $stagingRoot "agents/applicant")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/applicant/agent-card.json") -Destination (Join-Path $stagingRoot "agents/applicant")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/remote-agent.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/trust-policy.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/mutual-match.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
  # THIS LIST IS THE DEPLOY. A shared module that is not named here is simply
  # absent from the image, and the agent crash-loops on an ERR_MODULE_NOT_FOUND
  # the moment it is imported — which is exactly what screening.mjs did, taking
  # both live agents down until it was added. Add the file here in the same
  # commit that adds the import.
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/screening.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
  Copy-Item -LiteralPath (Join-Path $repoRoot "agents/shared/signed-envelope.mjs") -Destination (Join-Path $stagingRoot "agents/shared")
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

# PROFILE ON A LAPTOP, ENVIRONMENT IN CI.
#
# `-p DEFAULT` names a profile in ~/.databrickscfg, which does not exist on a
# GitHub runner - the CLI there authenticates from DATABRICKS_HOST and
# DATABRICKS_TOKEN, and naming an absent profile is a hard error rather than a
# fallback. So the flag is added only when there is no token in the environment.
$script:ProfileArgs = if ($env:DATABRICKS_TOKEN) { @() } else { @('-p', $DatabricksProfile) }

function Get-OptionalHirewireSecret([string]$key) {
  $json = databricks secrets get-secret hirewire $key @script:ProfileArgs 2>$null | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $json) { $global:LASTEXITCODE = 0; return $null }
  [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($json.value))
}

function Get-HirewireSecret([string]$key) {
  $json = databricks secrets get-secret hirewire $key @script:ProfileArgs | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Could not read secret '$key' from scope 'hirewire'." }
  [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($json.value))
}

# ---------------------------------------------------------------------------
# The web app. It is served from here rather than Databricks Apps because that
# platform gates every anonymous request behind a workspace OAuth login, so a
# visitor without a Databricks account can never reach our own sign-in page.
# ---------------------------------------------------------------------------
# FALL BACK TO THE SECRET SCOPE, which is where every other runtime secret in
# this script already comes from. Before this, the service principal's OAuth
# secret lived only in whoever-deployed-last's shell history: a secret's VALUE is
# shown once at creation and the API returns hashes afterwards, so a deploy from
# a fresh machine meant minting a new credential. The two Get-*HirewireSecret
# helpers are hoisted above this block so the lookup can happen here, before the
# first use of the credentials.
if (-not $DatabricksClientId) { $DatabricksClientId = Get-OptionalHirewireSecret "databricks-client-id" }
if (-not $DatabricksClientSecret) { $DatabricksClientSecret = Get-OptionalHirewireSecret "databricks-client-secret" }
if (-not $DatabricksClientId -or -not $DatabricksClientSecret) {
  throw "No service principal credentials. Put them in the hirewire scope as databricks-client-id / databricks-client-secret, or pass -DatabricksClientId and -DatabricksClientSecret (or set HIREWIRE_DB_CLIENT_ID / HIREWIRE_DB_CLIENT_SECRET). The app cannot reach the SQL warehouse without them, and nobody can sign in."
}

$appSource = Join-Path $repoRoot "app/vthacks-career-app"

# STAGE THE APP SOURCE. Cross-platform, because this script also runs on the
# ubuntu runner in .github/workflows/deploy-vultr.yml and robocopy is Windows-only.
#
# PRUNED, NOT FILTERED. The obvious version - Get-ChildItem -Recurse then discard
# unwanted paths - still ENUMERATES node_modules, a couple of hundred megabytes
# since the Presage native payloads landed, and took a two minute deploy past ten.
# This walks a queue and never descends into an excluded directory at all.
#
# The exclusions are not an optimisation. node_modules and .next are rebuilt in
# the image anyway, and .env / .env.local hold real secrets that must never ship:
# the container's environment is app.env below, built from the Databricks scope.
$excludedDirs = @('node_modules', '.next', '.git', '.databricks')
$excludedFiles = @('.env', '.env.local')
$appStage = Join-Path $stagingRoot "app"
$sourceRoot = (Resolve-Path $appSource).Path

$queue = [System.Collections.Generic.Queue[string]]::new()
$queue.Enqueue($sourceRoot)
while ($queue.Count -gt 0) {
  $dir = $queue.Dequeue()
  $relativeDir = $dir.Substring($sourceRoot.Length).TrimStart([char]92, [char]47)
  $targetDir = if ($relativeDir) { Join-Path $appStage $relativeDir } else { $appStage }
  if (-not (Test-Path -LiteralPath $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  }

  foreach ($entry in Get-ChildItem -LiteralPath $dir -Force) {
    if ($entry.PSIsContainer) {
      if ($excludedDirs -notcontains $entry.Name) { $queue.Enqueue($entry.FullName) }
      continue
    }
    if ($excludedFiles -contains $entry.Name) { continue }
    if ($entry.Name -like '*.tsbuildinfo') { continue }
    Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $targetDir $entry.Name) -Force
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $appStage "package.json"))) {
  throw "Staging the app source produced no package.json. Nothing was uploaded."
}

# One source of truth for the runtime secrets: the `hirewire` Databricks secret
# scope, the same one the Databricks App reads. Written to a gitignored staging
# file, shipped inside the archive, and never committed.
# Google sign-in is optional by design: src/lib/providers.ts hides the button
# when the client is not configured, so a missing key degrades to email/password
# rather than to a button that throws when pressed.
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

# The mock interview room's own keys. ALL OPTIONAL, each independently: a missing
# one degrades to a stated reason on screen rather than a crash, which is the
# contract that feature is built to.
#
# ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are deliberately NOT in this list —
# the Voice block below already carries them, and it pairs them because a key
# without an agent id has nothing to connect to. The same key also serves Scribe
# speech-to-text and persona 2, so the interviewer agent id below is useless
# without that block having run.
foreach ($pair in @(
    @{ Secret = "elevenlabs-interviewer-agent-id"; Env = "ELEVENLABS_INTERVIEWER_AGENT_ID" },
    @{ Secret = "presage-api-key"; Env = "PRESAGE_API_KEY" },
    @{ Secret = "google-generative-ai-api-key"; Env = "GOOGLE_GENERATIVE_AI_API_KEY" }
  )) {
  $value = Get-OptionalHirewireSecret $pair.Secret
  if ($value) {
    $appEnv += (ConvertTo-EnvLine $pair.Env $value)
    Write-Host "$($pair.Env): configured."
  } else {
    Write-Host "$($pair.Env): not set in the hirewire scope; the feature behind it will say so on screen."
  }
}

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
# The app calls the ATS worker over the compose network and needs the same
# shared token the worker checks. It lives in infra/vultr/.env, which is where
# the worker's own compose variables already are.
# Voice. Optional like Google: src/lib/elevenlabs.ts disables the microphone and
# says why when either is missing, rather than offering a dead button. Both are
# needed - a key without an agent id has nothing to connect to.
$voiceKey = Get-OptionalHirewireSecret "elevenlabs-api-key"
$voiceAgent = Get-OptionalHirewireSecret "elevenlabs-agent-id"
if ($voiceKey -and $voiceAgent) {
  $appEnv += (ConvertTo-EnvLine "ELEVENLABS_API_KEY" $voiceKey)
  $appEnv += (ConvertTo-EnvLine "ELEVENLABS_AGENT_ID" $voiceAgent)
  Write-Host "Voice: configured."
} else {
  Write-Host "Voice: not configured (needs elevenlabs-api-key and elevenlabs-agent-id in the hirewire scope). The microphone stays disabled and says why."
}

$atsEnvFile = Join-Path $PSScriptRoot ".env"
if (Test-Path -LiteralPath $atsEnvFile) {
  # Parsed in a plain loop, NOT a Where-Object | ForEach-Object pipeline: in
  # that form $matches inside the ForEach block is whatever the last -match
  # anywhere left behind, so the app was handed a 64-character value while the
  # worker held the real 48-character one, and every call came back
  # "unauthorized".
  $atsToken = $null
  foreach ($line in Get-Content -LiteralPath $atsEnvFile) {
    if ($line -match '^ATS_WORKER_TOKEN=(.+)$') {
      $atsToken = $Matches[1].Trim()
      break
    }
  }
  if ($atsToken) {
    $appEnv += "ATS_WORKER_TOKEN=$atsToken"
    Write-Host "Autofill worker: token wired to the app."
  }
}

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
# tar OVERWRITES but never DELETES, so a directory on the server accumulates
# files from every tree anyone has ever deployed from. On 2026-09-20 that broke
# the build: a teammate's deploy left behind files importing `jpeg-js` and
# `interviewerConfig`, neither of which exists anywhere in main, and every later
# deploy layered on top without removing them. The build compiled the union and
# failed on imports nobody could find in the repo.
#
# So clear what this run is about to replace, and ONLY that. `app` is staged on
# every run. `agents` and `certs` are NOT staged under -AppOnly -- removing them
# there would delete the live ANS key material and take both agents down.
# /opt/hirewire/app.env is a FILE, untouched by removing the `app` directory.
$purge = if ($AppOnly) { "rm -rf /opt/hirewire/app" } else { "rm -rf /opt/hirewire/app /opt/hirewire/agents" }
ssh @identityArgs $destination "$purge && tar -xzf /tmp/hirewire-vultr.tgz -C /opt/hirewire && chmod 600 /opt/hirewire/certs/employer.key /opt/hirewire/certs/applicant.key /opt/hirewire/app.env && cd /opt/hirewire && docker compose ${composeProfile}up -d --build --quiet-pull 2>&1"
if ($LASTEXITCODE -ne 0) { throw "Remote Docker deployment failed." }

Write-Host "App and both agents deployed."
Write-Host "Point hirewire.biz, www, employer and applicant A records to $HostIp, then run verify-public.ps1."

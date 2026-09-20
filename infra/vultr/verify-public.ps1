$ErrorActionPreference = "Stop"

# The reason this deployment exists: a visitor with no Databricks account has to
# reach OUR sign-in page. Databricks Apps answered an anonymous request with a
# 302 to the workspace OAuth login, which is a dead end for every applicant and
# employer we are asking to sign up.
$apex = "https://hirewire.biz"
$anonymous = Invoke-WebRequest -Uri $apex -MaximumRedirection 0 -ErrorAction SilentlyContinue
$apexStatus = if ($anonymous) { [int]$anonymous.StatusCode } else { 0 }
if ($apexStatus -ne 200) {
  $where = if ($anonymous) { $anonymous.Headers.Location } else { "(no response)" }
  throw "$apex returned $apexStatus -> $where instead of serving the app directly."
}
if ($anonymous.Content -match "databricks") {
  throw "$apex served a page mentioning Databricks; an anonymous visitor is still being sent to the workspace login."
}

$baseUrl = "https://employer.hirewire.biz"
$applicantBaseUrl = "https://applicant.hirewire.biz"

$health = Invoke-RestMethod -Uri "$baseUrl/health"
$card = Invoke-RestMethod -Uri "$baseUrl/.well-known/agent-card.json"
if ($health.status -ne "ok") { throw "Employer health endpoint did not return ok." }
if ($card.name -ne "ans://v1.0.0.employer.hirewire.biz") { throw "Published ANS name is incorrect." }
if ($card.endpoint -ne "$baseUrl/a2a/apply") { throw "Published A2A endpoint is incorrect." }
$applicantHealth = Invoke-RestMethod -Uri "$applicantBaseUrl/health"
$applicantCard = Invoke-RestMethod -Uri "$applicantBaseUrl/.well-known/agent-card.json"
if ($applicantHealth.status -ne "ok") { throw "Applicant health endpoint did not return ok." }
if ($applicantCard.name -ne "ans://v1.0.0.applicant.hirewire.biz") { throw "Published applicant ANS name is incorrect." }

# An unverified caller must be refused. Windows PowerShell 5.1 has no
# -SkipHttpErrorCheck, so read the status code from the thrown response.
$refusalStatus = $null
try {
  Invoke-RestMethod -Method Post -Uri "$baseUrl/a2a/apply" -ContentType "application/json" -Body '{"verification":{"verdict":"refuse"}}' | Out-Null
} catch {
  if ($_.Exception.Response) { $refusalStatus = [int]$_.Exception.Response.StatusCode }
}
if ($refusalStatus -ne 403) { throw "The refusal probe returned '$refusalStatus' instead of HTTP 403." }

Write-Host "Anonymous access to $apex, health, agent cards, and the unverified-caller refusal (HTTP 403) verified."
$health | ConvertTo-Json
$card | ConvertTo-Json -Depth 5
$applicantCard | ConvertTo-Json -Depth 5

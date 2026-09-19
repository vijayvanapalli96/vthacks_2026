$ErrorActionPreference = "Stop"
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

$refusal = Invoke-RestMethod -Method Post -Uri "$baseUrl/a2a/apply" -ContentType "application/json" -Body '{"verification":{"verdict":"refuse"}}' -SkipHttpErrorCheck
Write-Host "Health and agent card verified. The refusal probe should return HTTP 403."
$health | ConvertTo-Json
$card | ConvertTo-Json -Depth 5
$applicantCard | ConvertTo-Json -Depth 5

$ErrorActionPreference = "Stop"
$baseUrl = "https://employer.hirewire.biz"

$health = Invoke-RestMethod -Uri "$baseUrl/health"
$card = Invoke-RestMethod -Uri "$baseUrl/.well-known/agent-card.json"
if ($health.status -ne "ok") { throw "Employer health endpoint did not return ok." }
if ($card.name -ne "ans://v1.0.0.employer.hirewire.biz") { throw "Published ANS name is incorrect." }
if ($card.endpoint -ne "$baseUrl/a2a/apply") { throw "Published A2A endpoint is incorrect." }

$refusal = Invoke-RestMethod -Method Post -Uri "$baseUrl/a2a/apply" -ContentType "application/json" -Body '{"verification":{"verdict":"refuse"}}' -SkipHttpErrorCheck
Write-Host "Health and agent card verified. The refusal probe should return HTTP 403."
$health | ConvertTo-Json
$card | ConvertTo-Json -Depth 5

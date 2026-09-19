param(
    [string]$Profile = "DEFAULT",
    [string]$WarehouseId = "441b670a0ff475e0"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$sqlPath = Join-Path $repositoryRoot "databricks\sql\bootstrap.sql"
$sqlText = Get-Content -Raw -LiteralPath $sqlPath
$statements = [regex]::Split($sqlText, ';\s*(?=CREATE)')

foreach ($statement in $statements) {
    $statement = $statement.Trim()
    if (-not $statement) {
        continue
    }

    & databricks experimental aitools tools query `
        --warehouse $WarehouseId `
        --profile $Profile `
        --output json `
        $statement

    if ($LASTEXITCODE -ne 0) {
        throw "Databricks bootstrap failed with exit code $LASTEXITCODE"
    }
}

Write-Host "Databricks bootstrap completed for workspace.vthacks_2026"

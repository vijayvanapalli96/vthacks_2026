param(
    [string]$Profile = "DEFAULT",
    [string]$WarehouseId = "441b670a0ff475e0"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$sqlPath = Join-Path $repositoryRoot "sql\schema.sql"
$statements = [System.Collections.Generic.List[string]]::new()
$buffer = [System.Text.StringBuilder]::new()
foreach ($line in Get-Content -LiteralPath $sqlPath) {
    [void]$buffer.AppendLine($line)
    if ($line.TrimEnd().EndsWith(';')) {
        $statements.Add($buffer.ToString())
        [void]$buffer.Clear()
    }
}
if ($buffer.ToString().Trim()) {
    $statements.Add($buffer.ToString())
}

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

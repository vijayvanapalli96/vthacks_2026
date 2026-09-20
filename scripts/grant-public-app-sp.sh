#!/usr/bin/env bash
# Grants the self-hosted web app's service principal exactly what it needs.
#
# Run once, from a login that owns `workspace.vthacks_2026`. Separate from
# deploy.ps1 because granting permissions is a workspace change, not a deploy
# step, and should be reviewed on its own.
#
#   bash scripts/grant-public-app-sp.sh [profile]
set -euo pipefail

PROFILE="${1:-DEFAULT}"
SP="30cc20aa-4522-464e-a43b-ba94b97dfe2e"   # hirewire-public-app, id 73681624498281
WAREHOUSE="441b670a0ff475e0"

q() { databricks experimental aitools tools query "$1" --profile "$PROFILE" >/dev/null; }

# Unity Catalog. SELECT and MODIFY on the schema cover every table the app reads
# and writes; profile_memory is append-only by rule, not by privilege.
q "GRANT USE CATALOG ON CATALOG workspace TO \`$SP\`"
q "GRANT USE SCHEMA, SELECT, MODIFY ON SCHEMA workspace.vthacks_2026 TO \`$SP\`"

# Resume and document uploads (src/lib/uploads.ts writes through the Files API).
q "GRANT READ VOLUME, WRITE VOLUME ON VOLUME workspace.vthacks_2026.uploads TO \`$SP\`"

# ai_query() in src/lib/extract/databricks.ts runs as the caller.
databricks serving-endpoints update-permissions databricks-llama-4-maverick \
  --json "{\"access_control_list\":[{\"service_principal_name\":\"$SP\",\"permission_level\":\"CAN_QUERY\"}]}" \
  --profile "$PROFILE" >/dev/null

# SQL warehouse. update-permissions is additive; `set-permissions` would replace
# the whole ACL and silently drop the Databricks App and the team group.
databricks warehouses update-permissions "$WAREHOUSE" \
  --json "{\"access_control_list\":[{\"service_principal_name\":\"$SP\",\"permission_level\":\"CAN_USE\"}]}" \
  --profile "$PROFILE" >/dev/null

echo "hirewire-public-app can now use the warehouse, the schema, the uploads volume, and ai_query."

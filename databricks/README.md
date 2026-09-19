# Databricks workspace assets

The project uses the `workspace.vthacks_2026` Unity Catalog schema for governed analytical history. Tiger Data remains the operational source of truth for mutable application state.

## Bootstrap

```powershell
./databricks/scripts/bootstrap.ps1
```

The bootstrap creates:

- `workspace.vthacks_2026.documents`, a managed Volume for resumes, job descriptions, and approved generated files.
- `job_snapshots`, append-only versions of job postings.
- `match_evaluations`, explainable resume-to-job scoring results.
- `application_events`, application lifecycle history.
- `email_classifications`, Gmail response classifications.
- `voice_events`, accessibility and ElevenLabs interaction telemetry.
- `latest_application_state`, a view exposing the newest state per application.

Use the explicit `DEFAULT` profile and serverless warehouse ID shown above when reproducing the setup in this workspace.

## Application hosting

The AppKit React source will live under `app/` in this repository. Deployment packages the frontend and its API backend as a Databricks App. Teammates use the Databricks-hosted HTTPS URL; they do not run the frontend from a notebook.

Workspace access should be granted to an account-level `vthacks-team` group. The app deployment must declare its SQL warehouse and Unity Catalog resources so Databricks grants the app service principal the required runtime permissions.

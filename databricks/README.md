# Databricks workspace assets

The project uses the `workspace.vthacks_2026` Unity Catalog schema for governed analytical history. Tiger Data remains the operational source of truth for mutable application state.

## Bootstrap

```powershell
./databricks/scripts/bootstrap.ps1
```

The bootstrap executes the canonical `sql/schema.sql` file. That schema creates:

- `workspace.vthacks_2026.documents`, a managed Volume for resumes, job descriptions, and approved generated files.
- `job_snapshots`, append-only versions of job postings.
- `match_evaluations`, explainable resume-to-job scoring results.
- `application_events`, application lifecycle history.
- `email_classifications`, Gmail response classifications.
- `voice_events`, accessibility and ElevenLabs interaction telemetry.
- `users`, shared applicant and employer sign-in accounts.
- `agent_verifications`, the shared ANS and Trust Index audit record for either
  side of the handshake, identified by `agent_ans_name`.
- Candidate profile memory, courses, goals, embeddings, and generated artifacts.

Do not add a second Databricks DDL file for these objects. `sql/schema.sql` is the
single source of truth; the bootstrap script only applies it to the workspace.

Use the explicit `DEFAULT` profile and serverless warehouse ID shown above when reproducing the setup in this workspace.

## Application hosting

The AppKit React source will live under `app/` in this repository. Deployment packages the frontend and its API backend as a Databricks App. Teammates use the Databricks-hosted HTTPS URL; they do not run the frontend from a notebook.

Workspace access should be granted to an account-level `vthacks-team` group. The app deployment must declare its SQL warehouse and Unity Catalog resources so Databricks grants the app service principal the required runtime permissions.

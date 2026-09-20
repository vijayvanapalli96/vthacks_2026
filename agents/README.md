# Vijay lane: ANS identity and privacy-gated A2A applications

This directory implements the locally runnable portion of Vijay's P0 lane in
`docs/TASK_DIVISION.md`:

- versioned ANS-style applicant and employer identities;
- public employer and applicant agent cards with exact ANS registry discovery;
- five explained Trust Index dimensions scored as integers from 0 to 100;
- certificate/domain and HTTPS policy checks;
- human approval and a strict PII allowlist before an A2A POST;
- a refusal result with a spoken reason and zero released fields;
- an append-only, hash-chained development audit log.

The local demo uses deterministic fixtures. Production verification in the
frontend reads the public ANS registry and transparency log and requires the live
agent card to match the registered name and endpoint.

## Run

Requires Node 22 or newer. No package install is needed.

```bash
cd agents
npm test
npm run demo
npm run demo -- --refuse
npm run start:employer
npm run start:applicant
```

The employer service exposes:

- `GET /.well-known/agent-card.json`
- `GET /health`
- `POST /a2a/apply`

The employer independently resolves and verifies the claimed applicant ANS
identity before accepting an application. The applicant service exposes the same
discovery endpoints and accepts verified recruiting invitations for candidate
approval; it never publishes resume or contact data in its agent card.

## API contracts

Verification returns:

```json
{
  "verdict": "pass",
  "dimensions": [{ "name": "identity", "score": 0.95, "reason": "..." }],
  "spoken_reason": "...",
  "checked_at": "2026-09-19T00:00:00.000Z"
}
```

Application orchestration returns:

```json
{
  "status": "submitted",
  "fields_released": ["full_name", "email", "resume_url"],
  "audit_id": "...",
  "spoken_reason": "..."
}
```

A refusal always returns `fields_released: []` and does not call the employer.

## Applying at volume

Two lanes sit on top of the single-job path above. Both default to sending
nothing.

`applicant/auto-apply.mjs` fans out over `applyToEmployer`:

- `plan({ jobs })` verifies every employer and releases nothing. It does not POST
  an application and does not read candidate PII, so a plan file is safe to write
  to disk and safe to run unattended.
- `submit({ plan, approvedJobIds, candidate })` applies to the approved subset.
  `approvedJobIds` is required — there is no approve-all default — and an
  approval cannot upgrade a refusal.

`ats/` drives Greenhouse, Lever and Ashby application forms in Playwright.
`CLAUDE.md` lists ATS form automation as out of scope; that was revisited and
reversed, on the basis that an ANS-registered agent filling a form is a different
claim from an anonymous headless browser. The ANS name rides in the user agent
and is what carries that claim.

- `fill()` prepares the form, screenshots it, records which fields were filled
  and which were skipped, and stops. `submit: true` is what clicks.
- An unrecognised ATS is never typed into and no browser is launched.
- `ats/server.mjs` is the deployed worker. It is not published — see
  `../infra/vultr/README.md` for why, and for the two default-safe switches.

## Real infrastructure handoff

1. Applicant and employer identities are ACTIVE in ANS; certificates are stored
   only in the gitignored local `certs/` directory.
2. Deploy `employer/Dockerfile` to Vultr using `../infra/vultr/` and create the
   `employer.hirewire.biz` A record.
3. Replace `MemoryAuditLog`/`HashChainAuditLog` with the MongoDB audit adapter.
4. Persist the five-dimension result to Tarang's `agent_verifications` table.

Secrets belong in environment variables or the deployment secret store. Never
commit downloaded certificates, private keys, API keys, or connection strings.

See `../docs/VIJAY_ANS_SETUP.md` for the credential and registration procedure.

# Vijay lane: ANS identity and privacy-gated A2A applications

This directory implements the locally runnable portion of Vijay's P0 lane in
`docs/TASK_DIVISION.md`:

- versioned ANS-style applicant and employer identities;
- a public employer agent card;
- five explained Trust Index dimensions scored as integers from 0 to 100;
- certificate/domain and HTTPS policy checks;
- human approval and a strict PII allowlist before an A2A POST;
- a refusal result with a spoken reason and zero released fields;
- an append-only, hash-chained development audit log.

The included certificate and trust evidence are fixtures. They make the demo and
tests deterministic; they are not a substitute for ANS verification or ACME.

## Run

Requires Node 22 or newer. No package install is needed.

```bash
cd agents
npm test
npm run demo
npm run demo -- --refuse
npm run start:employer
```

The employer service exposes:

- `GET /.well-known/agent-card.json`
- `GET /health`
- `POST /a2a/apply`

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

## Real infrastructure handoff

1. Register the team domain and create applicant/employer ANS identities.
2. Complete DNS/ACME verification and replace fixture certificate evidence with
   output from the official ANS verifier or SDK.
3. Deploy `employer/Dockerfile` to a public HTTPS host (Vultr is the prize-track
   target) and set `EMPLOYER_ANS_NAME` and `EMPLOYER_ENDPOINT_URL`.
4. Replace `MemoryAuditLog`/`HashChainAuditLog` with the MongoDB audit adapter.
5. Persist the five-dimension result to Tarang's `agent_verifications` table.

Secrets belong in environment variables or the deployment secret store. Never
commit downloaded certificates, private keys, API keys, or connection strings.

See `../docs/VIJAY_ANS_SETUP.md` for the credential and registration procedure.

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

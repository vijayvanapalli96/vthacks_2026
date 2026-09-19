# Vultr deployment handoff

Deploy `agents/employer/Dockerfile` on a small public instance or container host,
terminate TLS for the team domain, and expose port 8787 through the HTTPS reverse
proxy. Configure these secrets at deploy time:

```text
EMPLOYER_ANS_NAME=ans://v1.0.0.<employer-agent-domain>
EMPLOYER_ENDPOINT_URL=https://<employer-agent-domain>/a2a/apply
PORT=8787
```

Before switching the applicant flow away from fixtures, verify that both
`https://<domain>/.well-known/agent-card.json` and `/health` are publicly
reachable and that the production certificate matches the domain.

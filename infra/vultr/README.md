# Vultr employer-agent deployment

The deployment runs the employer and applicant Node agents behind Caddy using
their ANS-issued certificates. No private key is committed.

1. Create an Ubuntu 24.04 Vultr instance with a public IPv4 address and paste
   `cloud-init.yaml` into its user-data field.
2. Wait for cloud-init to finish, then deploy from the repository root:

   ```powershell
   .\infra\vultr\deploy.ps1 -HostIp <PUBLIC_IPV4> -IdentityFile <SSH_PRIVATE_KEY>
   ```

3. In Porkbun DNS, add `A` records named `employer` and `applicant`, both pointing
   to the public IPv4 address. Keep the existing ANS HTTPS, TXT, badge, and TLSA records.
4. After DNS resolves, verify the public service:

   ```powershell
   .\infra\vultr\verify-public.ps1
   ```

Required public endpoints:

- `GET https://employer.hirewire.biz/health`
- `GET https://employer.hirewire.biz/.well-known/agent-card.json`
- `POST https://employer.hirewire.biz/a2a/apply`
- `GET https://applicant.hirewire.biz/health`
- `GET https://applicant.hirewire.biz/.well-known/agent-card.json`
- `POST https://applicant.hirewire.biz/a2a/apply`

The local `certs/` directory and generated `work/` archive remain gitignored.

## Current deployment

| | |
|---|---|
| Instance | `hirewire-agents`, Vultr `vc2-2c-4gb`, New York (`ewr`), Ubuntu 24.04 |
| Public IPv4 | `45.77.96.207` |
| DNS | Porkbun `A` records `employer` and `applicant` → `45.77.96.207`, TTL 600 |
| SSH | `root@45.77.96.207`, key auth only |

`deploy.ps1` packages the files in your working tree, not what is on GitHub.
Deploy from a checkout that matches `main`, or the server drifts from the repo.
Destroy the instance after judging; a stopped instance is still billed.

## ATS worker (Playwright lane)

Added 2026-09-19. `CLAUDE.md` lists ATS form automation as out of scope; that was
revisited and reversed, on the basis that an **ANS-registered** agent driving the
form is a different claim from an anonymous headless browser. The worker puts the
ANS name in its user agent — keep it there or the reversal loses its rationale.

The `ats` service is **not published**. It has no `ports:` block and no Caddy
vhost, and is reachable only from the compose network. Driving a headless browser
at a caller-supplied URL is an open proxy if exposed, and would let a stranger
borrow the `hirewire.biz` identity. It also requires `X-Ats-Token`.

Two switches, both default-safe:

| | |
|---|---|
| `ATS_WORKER_TOKEN` | Required. Unset, every request is rejected. |
| `ATS_ALLOW_SUBMIT` | `false` deploys a box that can only *prepare* a form, never send it. A caller asking to submit gets the form prepared and told why. |

The worker is **opt-in at deploy time**. A plain `deploy.ps1` run ships and
starts exactly what it did before this service existed — `employer`, `applicant`,
`caddy` — because `ats` sits behind a compose profile and `deploy.ps1` does not
copy its sources unless asked. That is deliberate: a Chromium image that fails to
build must not be able to take the two agents ANS depends on down with it.

To include it:

```powershell
cp infra/vultr/.env.example infra/vultr/.env   # then fill ATS_WORKER_TOKEN
.\infraultr\deploy.ps1 -HostIp 45.77.96.207 -IdentityFile <SSH_KEY> -IncludeAts
```

Without `-IncludeAts` the compose file on the server still *contains* the `ats`
service, but it is never started and its sources are absent. `deploy.ps1` throws
early if `-IncludeAts` is passed without `infra/vultr/.env`, rather than
half-deploying and leaving the stack down.

Deploy from a checkout that has `certs/` — worktrees do not share it, because it
is gitignored.

`POST /ats/prepare` with `{ job_url, candidate, submit }` returns a record naming
the fields filled, the fields skipped, and the screenshot path for review.
Greenhouse, Lever and Ashby are the supported vendors; anything else returns
`unsupported_ats` without opening a browser.

# Vijay — GoDaddy ANS setup

## Credentials are separate

1. A GoDaddy account owns the domain and its DNS zone. Use the hackathon code
   during checkout in the GoDaddy UI. No repository secret is required for a
   manual purchase.
2. `ANS_API_KEY` authenticates `ans-cli` to the ANS Registry Authority. Despite
   its singular name, the current CLI expects a classic GoDaddy developer
   credential in `<KEY>:<SECRET>` format and sends it as an `sso-key` header.
   It can alternatively use an `ANS_OAUTH_TOKEN` bearer token.
3. A GoDaddy Domains API PAT is optional. It is needed only if DNS or domain
   operations will be automated. The manual setup does not need one.

Never paste any of these credentials into chat, source files, GitHub issues, or
terminal arguments.

If a credential was pasted into chat, revoke it immediately and generate a new
pair before storing or using it.

## Already completed on this Windows machine

- Installed `ans-cli` from the official Go module.
- Added `C:\Users\Vijay\go\bin` to the user PATH.
- Added a guarded registration helper at `agents/scripts/ans-register.ps1`.
- Ensured `certs/`, `.env`, `*.key`, and `*.pem` are ignored by Git.

Open a new PowerShell window before continuing so the updated PATH is loaded.

## Steps Vijay must complete

### 1. Register or choose the domain

Sign in to GoDaddy and register the team domain using the hackathon promotion
code. Do not use `gddy domain purchase` during setup unless you intentionally
want the command to charge the account.

Choose these names:

```text
applicant.<TEAM_DOMAIN>
employer.<TEAM_DOMAIN>
```

### 2. Obtain the ANS credential

The official ANS docs do not currently expose a separate self-service ANS key
page, and the linked ANS OpenAPI pages return 404. First create a classic test
key at `https://classic-developer.godaddy.com/keys`. The classic GoDaddy guide
says the first key targets OTE. Then confirm with the sponsor that this key is
enabled for the hackathon ANS Registry Authority.

Ask the GoDaddy sponsor channel for:

- the hackathon `ANS_API_KEY` or OAuth token;
- whether the event uses `https://api.ote-godaddy.com` or
  `https://api.godaddy.com`;
- any event-specific registration or DNS instructions.

Store a replacement pair encrypted with Windows DPAPI by running:

```powershell
.\agents\scripts\store-ans-credential.ps1
```

The prompts are hidden. The encrypted file is stored outside the repository at
`%LOCALAPPDATA%\Hirewire\ans-credential.clixml` and can only be decrypted by the
same Windows user on the same computer.

Load the credential into the current PowerShell session by dot-sourcing:

```powershell
. .\agents\scripts\load-ans-credential.ps1 -Environment production
```

The stored credential was validated successfully against the production ANS
Registry Authority on 2026-09-19. It was rejected by OTE, so production is the
default for this project.

If the registration endpoint returns `401` or `403`, the credential lacks ANS
access. There is no client-side workaround; ask the event sponsor to enable the
key or issue an OAuth token.

### Public discovery works without credentials

Registration is protected, but the production search and transparency
verification surfaces are public. The applicant implementation can therefore
develop against live agents while registration is blocked:

```text
GET https://api.godaddy.com/v1/ans/registered-agents?query=<agent>
GET https://transparency.ans.godaddy.com/root-keys
GET https://transparency.ans.godaddy.com/checkpoint
```

The implementation lives in `agents/applicant/ans-discovery.mjs`.

### 3. Generate local private keys and CSRs

From the repository root:

```powershell
.\agents\scripts\ans-register.ps1 `
  -Domain '<TEAM_DOMAIN>' `
  -Organization 'VT Hacks 2026 Team'
```

This creates separate applicant and employer material under `certs/`. It does
not call GoDaddy or register anything without `-Register`.

Back up the private keys in a secure password manager or secret store. Do not
send them to teammates in Discord.

### 4. Make the two HTTPS endpoints reachable

The registration helper declares:

```text
https://applicant.<TEAM_DOMAIN>/.well-known/agent-card.json
https://applicant.<TEAM_DOMAIN>/a2a/apply
https://employer.<TEAM_DOMAIN>/.well-known/agent-card.json
https://employer.<TEAM_DOMAIN>/a2a/apply
```

Point both DNS names at the public host used for the agent service. The Vultr
deployment is the preferred hackathon path. Confirm the agent cards and health
checks are reachable over HTTPS before registration.

### 5. Register both agents

After confirming the base URL with the sponsor:

```powershell
.\agents\scripts\ans-register.ps1 `
  -Domain '<TEAM_DOMAIN>' `
  -Organization 'VT Hacks 2026 Team' `
  -BaseUrl $env:ANS_BASE_URL `
  -Register
```

Save both returned `agentId` values. The response should also contain the DNS
challenge record required for domain verification.

### 6. Add the DNS TXT challenges

In GoDaddy Domain Portfolio:

1. Open the domain.
2. Open DNS records.
3. Select **Add New Record** and choose **TXT**.
4. Enter the exact host/name and value returned by `ans-cli register`.
5. Save and wait for public DNS propagation.

Do not invent the TXT record name or value; use the registration response.

### 7. Verify and retrieve certificates

Run these commands for each returned ID:

```powershell
ans-cli verify-acme '<AGENT_ID>' --json
ans-cli status '<AGENT_ID>' --json
ans-cli verify-dns '<AGENT_ID>' --json
ans-cli get-identity-certs '<AGENT_ID>' --json
ans-cli get-server-certs '<AGENT_ID>' --json
ans-cli badge '<AGENT_ID>' --audit --checkpoint --json
```

Repeat `status` after DNS propagation until certificate issuance completes.

### 8. Validate discovery

```powershell
ans-cli resolve "employer.<TEAM_DOMAIN>" --version '^1.0.0' --json
ans-cli resolve "applicant.<TEAM_DOMAIN>" --version '^1.0.0' --json
```

The returned endpoints and version should match the deployed agent cards.

## Optional GoDaddy Domains API credential

If the team wants to automate DNS later, generate a scoped PAT in the GoDaddy
Developer Portal and store it in a password manager. The current manual flow
does not need this credential. Prefer a narrowly scoped, expiring PAT and inject
it at runtime; never commit it.

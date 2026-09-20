# Vultr public deployment

The deployment runs the web app and the employer and applicant Node agents
behind Caddy. The agents use their ANS-issued certificates; the apex gets an
ordinary Let's Encrypt certificate that Caddy obtains on first boot. No private
key is committed.

**Why the app is here and not on Databricks Apps.** Databricks Apps authenticates
at its own edge: an anonymous request to
`vthacks-career-app-7474648702108753.aws.databricksapps.com` is answered with a
302 to the workspace OAuth login, before our container is reached. There is no
setting that turns it off - app permissions can only be granted to workspace
users and groups, and each of those is still a Databricks account. So every
applicant and employer we ask to sign up would have hit a Databricks login
first. The Databricks App still exists and still deploys; it is no longer the
public entrance. Databricks remains the data plane, reached with the
`hirewire-public-app` service principal's OAuth credentials.

1. Create an Ubuntu 24.04 Vultr instance with a public IPv4 address and paste
   `cloud-init.yaml` into its user-data field.
2. Grant the app service principal its workspace access, once:

   ```bash
   bash scripts/grant-public-app-sp.sh DEFAULT
   ```

3. Wait for cloud-init to finish, then deploy from the repository root. The
   client id is `hirewire-public-app`; its secret is not in the repo:

   ```powershell
   .\infra\vultr\deploy.ps1 -HostIp <PUBLIC_IPV4> -IdentityFile <SSH_PRIVATE_KEY> `
     -DatabricksClientId 30cc20aa-4522-464e-a43b-ba94b97dfe2e `
     -DatabricksClientSecret <OAUTH_SECRET>
   ```

   The remaining runtime secrets are read at deploy time from the `hirewire`
   Databricks secret scope, so there is one source of truth for them. Keys that
   never reached that scope (ElevenLabs, Gemini, Google OAuth) go in
   `infra/vultr/app.env.local`, which is gitignored.

4. In Porkbun DNS, point the apex at the box and add `A` records named `www`,
   `employer` and `applicant`, all to the public IPv4 address. **Delete the apex
   URL-forwarding record** - that forward is what sent visitors to the Databricks
   login. Keep the existing ANS HTTPS, TXT, badge, and TLSA records.
5. After DNS resolves, verify the public service:

   ```powershell
   .\infra\vultr\verify-public.ps1
   ```

Required public endpoints:

- `GET https://hirewire.biz/` - 200, served directly, no redirect to any login
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
| DNS | Porkbun `A` records apex, `www`, `employer`, `applicant` → `45.77.96.207`, TTL 600 |
| SSH | `root@45.77.96.207`, key auth only |

`deploy.ps1` packages the files in your working tree, not what is on GitHub.
Deploy from a checkout that matches `main`, or the server drifts from the repo.
Destroy the instance after judging; a stopped instance is still billed.

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

## Google sign-in

The provider, the server action and the button are already built; they are gated
on `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` (see `src/lib/providers.ts`). With the
keys absent the button is hidden and email/password still works, so this is
configuration, not code.

1. In Google Cloud Console -> APIs & Services -> Credentials, create an
   **OAuth 2.0 Client ID** of type **Web application**.
2. Add this **exact** authorized redirect URI - Auth.js derives it from
   `AUTH_URL`, and Google rejects anything that does not match character for
   character:

   ```
   https://hirewire.biz/api/auth/callback/google
   ```

   Add `http://localhost:3000/api/auth/callback/google` too if you want the
   button locally.
3. Add `https://hirewire.biz` as an authorized JavaScript origin.
4. Put the credentials in the `hirewire` secret scope, the same place every other
   runtime secret lives, so they never touch the repo:

   ```bash
   databricks secrets put-secret hirewire google-client-id --string-value "<CLIENT_ID>" -p DEFAULT
   databricks secrets put-secret hirewire google-client-secret --string-value "<CLIENT_SECRET>" -p DEFAULT
   ```

5. Redeploy. The script says which way it went:

   ```
   Google sign-in: configured.
   ```

While the app is on an unverified "Testing" OAuth consent screen, only accounts
listed as test users can sign in. Publish the consent screen, or add every
demo account as a test user, before anyone else tries it.

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

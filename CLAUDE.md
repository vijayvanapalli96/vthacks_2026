# HIREWIRE — VTHacks 14

Voice-first career agent with verified agent-to-agent apply. Finds roles against a
student's skills **and coursework**, tailors the materials, proves the employer is
real before releasing any PII, and refuses out loud when it can't.

**Ship: Sunday 2026-09-20 08:00 ET. Code freeze T-3h. 3 people.**

| Read this | For |
|---|---|
| [`docs/FEATURE_LIST.md`](docs/FEATURE_LIST.md) | What we're building, tiered P0/P1/P2, with owners |
| [`docs/TASK_DIVISION.md`](docs/TASK_DIVISION.md) | Who does what, hour by hour, checkpoints, API contracts |
| [`docs/VTHACKS14_STRATEGY.txt`](docs/VTHACKS14_STRATEGY.txt) | Why this shape wins; sponsor tracks; the pitch |
| [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md) | Longer-form system design (pre-dates the 3-person cut) |

Ownership: **Vijay** = identity/ANS/A2A · **Tarang** = data/match/analytics ·
**Nidhi** = voice/agent-loop/frontend. Stay in your lane's directories; cross-lane
changes go through the fixture contracts in `TASK_DIVISION.md` §4.

---

## Repo layout

```
app/vthacks-career-app/   Next.js 16.3.5 + React 19. The product. (Nidhi)
  src/fixtures/*.json     Fixture contracts — every lane builds against these first
agents/applicant/         ANS-registered agent acting for the student (Vijay)
agents/employer/          ANS-registered employer agent, hosted publicly (Vijay)
sql/ data/ scripts/       Databricks DDL, ingestion, match, analytics (Tarang)
certs/                    ANS identity + server certs — GITIGNORED, never commit
docs/                     Plans, design, sponsor briefs, diagrams
```

`../career-ops/` is a **sibling donor repo, not a dependency.** MIT licensed
(© 2026 Santiago Fernández de Valderrama), v1.33.0. Copy the `.mjs` files we need
into this repo and keep the header comment with attribution. Do not `npm install`
it, do not submodule it, do not edit it.

High-value lifts — check here before writing anything from scratch:

| Need | Lift from |
|---|---|
| Job boards (99 ATS readers incl. Ashby, Greenhouse, Lever) | `career-ops/providers/*.mjs` |
| Stable job identity for write-once storage | `career-ops/url-key.mjs`, `fingerprint-core.mjs` |
| JD from ATS API instead of scraping HTML | `career-ops/fetch-jd.mjs` |
| Canonical skill vocabulary + extractor | `career-ops/skill-extract.mjs` |
| Zero-LLM skill-gap classification | `career-ops/jd-skill-gap.mjs` |
| Cover letter → PDF | `career-ops/generate-cover-letter.mjs` |
| CV render → PDF | `career-ops/build-cv-{latex,html}.mjs`, `generate-pdf.mjs` |
| Claim-level CV fact verification | `career-ops/verify-cv-facts.mjs` |
| LinkedIn `Connections.csv` join | `career-ops/linkedin-join.mjs` |
| Resume/LinkedIn intake + source fingerprinting | `career-ops/intake.mjs` |

---

## Stack

- **Frontend/API** Next.js 16.3.5 (App Router), React 19, TypeScript, shadcn/ui
  (Radix underneath → keyboard + ARIA correct by default), Tremor for charts.
- **Hosting** The public site is the **Vultr box behind Caddy** (`infra/vultr/`),
  and so are both agents. Databricks Apps authenticates at its own edge: an
  anonymous request is answered with a 302 to the workspace OAuth login before
  our container runs, and no setting turns that off — app permissions only reach
  workspace users and groups, all of whom have Databricks accounts. It would
  have put a Databricks login in front of every applicant and employer. The
  Databricks App (`databricks.yml`) still deploys and is fine for internal use;
  it is not the public entrance. Databricks stays the **data plane**, reached
  with the `hirewire-public-app` service principal's OAuth credentials.
- **Data plane** Databricks `workspace.vthacks_2026` (Delta + UC Volumes) ·
  MongoDB Atlas (`jd_raw`, `a2a_audit`).
  The schema already exists with `job_snapshots`, `match_evaluations`,
  `application_events`, `voice_events`, `email_classifications`, and the
  `latest_application_state` view. **Extend it; do not build a parallel schema.**
  **TigerData is NOT wired to anything** — no connection string, no client, no env
  key. Earlier revisions of this file listed it here as the primary store for an
  `application_events` hypertable with continuous aggregates; that was a plan, not
  a fact, and `docs/FEATURE_LIST.md` F9.1 still describes it that way. The
  application pipeline writes Delta only (`sql/schema.sql` §8) and does its
  time-in-stage arithmetic there. Say so rather than claiming the hypertable —
  hard rule 8.
  `latest_application_state` is real and was verified on the live workspace on
  2026-09-19, but §8 **replaced** its definition: it now resolves one stage per
  `(user_id, job_id)` rather than per `application_id`, because the pipeline is
  per-user. It is a superset — every old column keeps its name and type.
- **Models** `ai_query()` in plain SQL for embeddings and bulk scoring (no
  external key, no rate limit); Gemini for multimodal PDF understanding and
  function-calling tool routing. Keep that split clean — it's how judges from both
  companies each hear a reason their tech was chosen.
- **Voice** ElevenLabs Agents, two personas (calm assistant / interviewer).
- **Auth** Auth.js v5 (`next-auth@beta`), email/password + Google, JWT sessions.
  Every account carries `role: 'applicant' | 'employer'`, and the app has two
  guarded pathways under `/applicant/*` and `/employer/*`. We do **not** use
  Databricks Apps SSO for this: it cannot distinguish the two roles, and employer
  users are external to the workspace. Guards live in the route-group layouts via
  `requireRole()` — there is deliberately no middleware.
- **Identity** GoDaddy ANS — `ans://v1.0.0.applicant.<domain>` and
  `ans://v1.0.0.employer.<domain>`.

---

## Environment

**Build on the TEAM workspace, profile `TEAM`.** The personal Free Edition
workspace (profile `DEFAULT`) set up earlier on Sept 19 is a throwaway — do not
build there. **Every CLI call needs `-p TEAM`.**

| | |
|---|---|
| Workspace host | `https://dbc-0bfd7b56-c2eb.cloud.databricks.com` (workspace id `7474648702108753`) |
| CLI profile | `TEAM` (`DEFAULT` = throwaway, ignore) |
| SQL warehouse | `441b670a0ff475e0` ("Serverless Starter", 2X-Small, serverless) |
| Catalog / schema | **`workspace.vthacks_2026`** — already exists, tables built, rows empty |
| Vector Search endpoint | `vthacks-vs` (ONLINE, 0 indexes) |
| Embeddings | `databricks-gte-large-en` → 1024-dim (verified on TEAM) |
| LLM | `databricks-llama-4-maverick` (verified on TEAM), `databricks-gpt-oss-120b`, others |
| Group | `vthacks-team` |

**Settled by inspection — `databricks.yml` is correct, do not "fix" it.** Logged in
on 2026-09-19 as `tarangnair98@gmail.com` and confirmed against that host:
`workspace.vthacks_2026` is present with all six team objects (`job_snapshots`,
`match_evaluations`, `application_events`, `voice_events`,
`email_classifications`, `latest_application_state`), and warehouse
`441b670a0ff475e0` resolves there as "Serverless Starter Warehouse", 2X-Small.
So `dbc-0bfd7b56-c2eb` **is** the team workspace. Two earlier revisions of this
file called it a throwaway and told you to repoint the bundle; both were wrong,
inferred from the strategy doc's layout rather than checked.

Secrets live in `.env.local` (gitignored) and, in production, in the Databricks
App `resources` block. Never commit a key, a cert, or a real DNS token.

## Commands

```bash
# app
cd app/vthacks-career-app
npm run dev          # next dev -H 0.0.0.0
npm run typecheck    # tsc --noEmit   <- run before you push
npm run lint         # eslint (jsx-a11y is part of this and is not advisory)

# databricks — note -p TEAM on every single call
databricks api post /api/2.0/sql/statements --json @q.json -p TEAM  # SQL: ALWAYS via @file
databricks warehouses get 441b670a0ff475e0 -p TEAM                  # is it awake?
databricks current-user me -p TEAM                                  # am I on the right workspace?
databricks bundle deploy                                            # deploy the app
databricks auth login --host https://dbc-0bfd7b56-c2eb.cloud.databricks.com --profile TEAM
```

### Gotchas that have already bitten us
- **Inline JSON with quotes gets mangled by the shell.** Put SQL in a file and use
  `--json @q.json`. Always.
- **The warehouse cold-starts in 20–30 s** and stops between uses. Fire a dummy
  query ~2 minutes before demoing so it's warm on stage.
- macOS has no `timeout` (use `gtimeout`, or omit it).
- Tarang is on **Windows**; `ans-cli` is a Homebrew formula, so ANS work happens on
  Vijay's machine. Don't write bash that assumes one or the other.

---

## Hard rules

These are correctness, not style. Breaking one breaks the pitch.

1. **`profile_memory` is append-only.** Never `UPDATE`, never `DELETE`. Every fact
   carries `source`, `confidence`, `observed_at`; read current state through the
   `profile_current` view. This is what makes the profile a memory that grows
   rather than a form that gets overwritten. (New table — we add it to the
   existing schema.)
2. **A job is stored exactly once.** `job_id` is derived deterministically from
   the posting URL via `career-ops/url-key.mjs`; ingestion into `job_snapshots` is
   `MERGE INTO … WHEN NOT MATCHED THEN INSERT`. `description_text` and
   `raw_payload_json` are never rewritten once captured.
3. **No PII moves before verification passes.** Order is: ANS resolve → certificate
   check → Trust Index → policy gate → human confirm → *then* fields. A refusal
   must return `fields_released: []`. If that array is ever non-empty on a refusal,
   drop everything and fix it — that single bug turns the whole pitch into a lie.
4. **Every Trust Index dimension carries a reason string.** Five dimensions
   (Integrity, Identity, Solvency, Behavior, Safety). A score without a reason is
   a bug. Judges came to see the reasons.
5. **Voice and UI call the same endpoints.** No parallel code path for voice.
   "Everything you can say, you can type" has to be true at the API layer.
6. **Accessibility is not a feature.** Keyboard-reachable, correct tab order, ARIA
   labels, visible focus, 4.5:1 body contrast — as you type, not in a later pass.
   It is the entire thesis of the product.
7. **Real content only.** Real VT majors, real course codes, real company names
   from real scraped JDs. No lorem ipsum, no "John Doe," no "Acme Corp."
8. **Don't overclaim.** We do not work with Workday today. Say so. A named gap
   costs fewer points than a caught exaggeration.

## Out of scope — decided, not up for rediscussion at 4 AM

Playwright / ATS form automation (replaced by A2A) · Solana (no honest fit) ·
payments · mobile · resume WYSIWYG · Presage · Gmail ingestion (the
`email_classifications` table exists; we are not filling it in 15 hours).

## Working agreements

- **Build against the fixtures in `src/fixtures/`** before the real endpoint
  exists. Change the fixture first, then the handler.
- Tier discipline: finish your P0 list before touching P1, and P1 in the written
  order — it's sorted by points-per-hour, not by interest.
- The descope switches in `TASK_DIVISION.md` are **pre-authorized**. Hit a red
  checkpoint, flip the switch, tell the team in one sentence, keep moving.
- Nothing is added to P0 after T-12. Nothing is typed after T-3.
- **Never commit directly to `main`.** Every change goes on a branch and lands
  through a PR — `feat/<thing>`, `fix/<thing>`, `docs/<thing>`. Keep branches
  small and short-lived so review is seconds, not minutes; with 15 hours the
  point of the PR is a second pair of eyes, not ceremony.
- Rebase onto `main` before pushing (`git pull --rebase`); teammates are pushing
  constantly and a merge bubble per branch will make the history unreadable.
- Run `npm run typecheck && npm run lint && npm run build` before you open a PR.
  A red branch costs a teammate more time than it saved you.
- **One checkout per worker — human or agent.** If two of you (or two coding
  agents) edit the same working tree, a `git add -A` sweeps up the other's
  half-finished files and neither of you can tell which are yours. Give each
  concurrent worker its own tree:
  `git worktree add ../vthacks-<lane> -b feat/<thing> origin/main`, then merge
  through a PR like any other branch. Run `git worktree list` before you assume
  you are alone in here — and never switch branches in a tree someone else is
  working in, because it changes files under them.

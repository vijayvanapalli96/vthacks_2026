# HIREWIRE — Feature List

Derived from `docs/VTHACKS14_STRATEGY.txt` + `docs/SYSTEM_DESIGN.md`, reconciled
against the product flow we actually want to demo.

**Ship:** Sunday 2026-09-20, 08:00 ET · Judging 10:30 ET
**Team:** 3 (Nidhi, Tarang, Vijay) · **Wall clock at time of writing:** ~15 h

---

## 0. Scope reality check — read this before picking up a ticket

The strategy doc budgets **~56 person-hours** for its MUST list at 4 people.
We have **3 people × 15 h = 45 p-h raw**, realistically **~36 p-h** after food,
integration, the demo video, and Devpost. The MUST list as written does not fit.

So features are tiered, and the tiers are contracts:

| Tier | Meaning | Rule |
|---|---|---|
| **P0** | The demo spine. If a P0 is missing there is no pitch. | ~10 h per person. Nothing gets added to P0 after T-12. |
| **P1** | One distinct beat in the 4-minute pitch each. | Pull from the top only when your P0 lane is green. |
| **P2** | Nice-to-have. Cut silently, tell nobody. | Touch only if P0+P1 are done. |
| **CUT** | Decided no. Not revisited at 4 AM. | — |

Decisions already locked: ANS lane is **Vijay**. All three datastores
(Databricks + TigerData + MongoDB) are **in**, which is why the SHOULD list
below is thin — S4–S7 from the strategy doc are P2 or CUT.

**CUT, permanently:** Playwright / real ATS form filling · Solana · payments ·
mobile · multi-user collaboration · resume WYSIWYG editor · Presage.

---

## Epic 0 — Foundation

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F0.1 | Domain registered via GoDaddy Registry (MLH code `MLH0918VTH`) — doubles as the ANS identity anchor | **P0** | Vijay | 15 m |
| F0.2 | ANS agent registration ×2 (`applicant.<domain>`, `employer.<domain>`): CSRs → register → DNS TXT → ACME verify → identity certs | **P0** | Vijay | 2.5 h |
| F0.3 | Vultr host serving the employer agent over public HTTPS (ANS requires a reachable endpoint; gift code `MAJORLEAGUEHACKING`) | **P0** | Vijay | 1 h |
| F0.4 | Extend the existing `workspace.vthacks_2026` schema with our new tables — incl. `agent_verifications`, which the strategy doc flags as a GAP and which Vijay is blocked on (§ Data model below) | **P0** | Tarang | 45 m |
| F0.5 | Next.js app shell (already scaffolded at `app/vthacks-career-app`) + shadcn/ui init + `eslint-plugin-jsx-a11y` | **P0** | Nidhi | 45 m |
| F0.6 | Secret/env convention: `.env.local` locally, Databricks App `resources` in prod. Nothing real committed. | **P0** | Vijay | 15 m |

> **Time-critical:** the GoDaddy sponsor table (Sat 13:00–15:30) has closed.
> Get the ANS API key via **#godaddy on Discord** immediately. F0.2 is the only
> wall-clock-bound item on the board — DNS propagation cannot be parallelized.

---

## Epic 1 — Identity & access — **two pathways: applicant and employer**

**Superseded decision.** This epic originally said "we do not build auth — read
the Databricks Apps SSO identity." That is wrong for this product: SSO cannot
tell an applicant from an employer, and employer users are *external* to our
Databricks workspace entirely. Agent-to-agent needs both sides to be real,
signed-in principals, so we build auth: Auth.js v5, email/password + Google, with
a role on the account.

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F1.1 | Auth.js v5 (`next-auth@beta`) — Credentials + Google providers, JWT sessions, `trustHost: true` for Databricks Apps | **P0** | Nidhi | 1 h |
| F1.2 | `Role = applicant \| employer` on the account, chosen at signup; carried in the JWT and the session | **P0** | Nidhi | 30 m |
| F1.3 | Two route groups — `/applicant/*` and `/employer/*` — guarded at the layout by `requireRole()`. Wrong role redirects to your own dashboard, not an error page. | **P0** | Nidhi | 30 m |
| F1.4 | ~~`/choose-role`~~ **REMOVED — route now 404s.** The pathway is picked once on the landing page and rides through OAuth as `?role=…`. If it is still missing (Google sign-in begun directly at `/signin`), `/continue` silently writes `applicant`. **Open gap:** the code calls that "recoverable" but there is no in-app way to change your role, so an employer arriving that way is stuck in the applicant workspace. See F1.8. | ~~P0~~ | Nidhi | — |
| F1.8 | **Role recovery** — either restore a role prompt for the genuinely-unknown case, or add a "switch pathway" control. Cheap, and it closes the hole F1.4 opened. | **P0** | Nidhi | 20 m |
| F1.5 | User store behind a stable interface (`findUserByEmail`, `createUser`, `setUserRole`, `verifyPassword`). **DONE — `workspace.vthacks_2026.users` in Databricks**, via `src/lib/databricks.ts`. The JSON file store is gone, so accounts now survive redeploys. | **P0** ✅ | Nidhi → Tarang | 45 m |
| F1.6 | Public landing with the two pathways stated plainly ("I'm looking for a role" / "I'm hiring") | **P0** | Nidhi | 30 m |
| F1.7 | Sign-in screen copy that states what the agent will and will not do with PII | P1 | Nidhi | 30 m |

**Cost of this change:** ~+3 h on Nidhi's lane versus the 20-minute SSO plan, and
the employer dashboard becomes a real surface we have to design rather than a
service Vijay curls. Pull it out of Nidhi's P1 list (see `TASK_DIVISION.md`); the
`cmdk` palette and the designed empty states are the first casualties.

**What we give up:** the free "we used Databricks for auth" line in Q&A. Worth it
— "both sides of the handshake are authenticated principals" is a much better
answer for the track we are actually trying to win.

**Where `users` lives — corrected.** An earlier version of F1.5 said swap the dev
JSON store for `workspace.vthacks_2026.users`. That is wrong, and it would have
been a bad thing to discover on stage:

- Every single login would wait on the SQL warehouse, which is **STOPPED between
  uses and cold-starts in 20–30 s**. The first sign-in of the demo hangs for half
  a minute while a judge watches.
- Delta has **no enforced unique constraint**, so "this email is already
  registered" becomes a race that cannot be closed at the storage layer.
- Delta is an analytics store. Auth is OLTP: tiny, latency-sensitive point reads.

**BUILT ON DATABRICKS ANYWAY — and nobody actually decided that.** To be accurate
about the provenance, because it matters for whether this gets revisited: the
TigerData recommendation above was never overridden by Tarang or anyone else. A
coding agent built the Delta version while the recommendation stood, then
recorded it as a human decision. It is being kept because it works, it is
verified, and it fixes the one thing that would certainly have broken the demo —
accounts vanishing on every redeploy of an ephemeral filesystem. The three
objections above were not answered; they were accepted. TigerData remains the
correct home for this table. Live now as
`workspace.vthacks_2026.users` (DDL in `sql/schema.sql`), read and written by
`src/lib/users.ts` through the SQL Statement Execution API with parameterized
statements. Verified end to end: sign-in → role read from the table → routed to
the right dashboard.

The two caveats stand and are worked around rather than solved:
- **Cold start is real.** Warm the warehouse before demoing — any query.
- **Uniqueness is unenforced**, so `createUser` checks then inserts. Closes the
  ordinary case, not a true race. Documented in `sql/schema.sql`.

Auth against this workspace also has no PAT available (`databricks tokens create`
→ *"User does not have permission to use tokens"*), so `src/lib/databricks.ts`
resolves credentials three ways: `DATABRICKS_TOKEN` → `DATABRICKS_CLIENT_ID/_SECRET`
(injected by Databricks Apps in production) → the CLI's own OAuth token (local dev
only).

---

## Epic 2 — Intake (resume upload **or skip**, LinkedIn upload **or skip**)

Every step is skippable by design. Whatever is skipped becomes a gap that the
voice agent asks about in Epic 4 — that is the product, not a fallback.

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F2.1 | Resume PDF upload → Unity Catalog Volume, returns an artifact id | **P0** | Nidhi | 45 m |
| F2.2 | Skip path on every intake step, with the gap recorded in `profile_memory` | **P0** | Nidhi | 20 m |
| F2.3 | Transcript PDF upload → coursework (this is the word Deloitte's brief uses; it is scored) | **P0** | Nidhi | 30 m |
| F2.4 | LinkedIn export upload (`Connections.csv` + profile PDF) — lift `career-ops/linkedin-join.mjs` | P1 | Nidhi | 45 m |
| F2.5 | Source fingerprinting so re-uploading the same file does not duplicate facts — lift `career-ops/intake.mjs` | P1 | Nidhi | 30 m |

---

## Epic 3 — Profile agent + the growing profile memory

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F3.1 | Gemini multimodal: resume PDF in directly → profile JSON under a published JSON schema (handles two-column layouts and tables; visibly impressive) | **P0** | Nidhi | 1.5 h |
| F3.2 | Transcript → courses → implied skills (`courses` table) | **P0** | Tarang | 45 m |
| F3.3 | **Profile memory**: append-only `profile_memory` + `profile_current` view. Every fact carries `source`, `confidence`, `observed_at`. Resume, voice answers, match outcomes, and rejections all append. This is the memory that grows over time. | **P0** | Tarang (DDL) / Nidhi (writes) | 1 h |
| F3.4 | Completeness scorer → ordered list of missing fields; this list is the input to F4.3 | **P0** | Nidhi | 30 m |
| F3.5 | Skill canonicalization against one vocabulary — lift `career-ops/skill-extract.mjs` | P1 | Tarang | 30 m |
| F3.6 | Provenance UI: hover any profile fact to see which document or utterance produced it | P2 | Nidhi | 45 m |

---

## Epic 4 — Voice agent (ElevenLabs) + action-driven voice actions

Voice is the **interface**, not narration. The whole app is operable eyes-free.

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F4.1 | Voice in/out loop with barge-in / interruption handling | **P0** | Nidhi | 1.5 h |
| F4.2 | Persona 1 — calm assistant | **P0** | Nidhi | 20 m |
| F4.3 | **Adaptive questioning**: if the profile has gaps → ask the basic questions; if it is complete → ask the decision questions (target role, visa/sponsorship need, locations, comp floor, start date, accommodations needed) | **P0** | Nidhi | 1 h |
| F4.4 | Goals capture → `goals` table, echoed back for confirmation | **P0** | Nidhi | 30 m |
| F4.5 | **Tool router** (Gemini function-calling): `search_jobs`, `match`, `explain_match`, `tailor`, `verify_employer`, `apply`, `status`, `open_dashboard`. Every voice utterance becomes an action, never a canned reply. | **P0** | Nidhi | 1.5 h |
| F4.6 | **The spoken refusal** — "I stopped. That employer could not prove who it is; its identity certificate doesn't match its domain. I have not sent anything." Wins the ElevenLabs *and* ANS tracks. | **P0** | Nidhi + Vijay | 30 m |
| F4.7 | Persona 2 — interviewer, **video** mock interview, gated on the pipeline reaching `interviewing`. Questions from Gemini (deterministic JD/gap fallback), answers transcribed by ElevenLabs Scribe, steadiness via Presage, readout appended as the `interview_feedback` action. All four integrations degrade independently. **DONE — `/applicant/interview/[jobId]`** | P2 ✅ | Nidhi | 2 h |
| F4.8 | 30-second overnight audio briefing artifact | P2 | Nidhi | 45 m |

---

## Epic 5 — Job ingestion & parsing (write-once)

`career-ops/providers/` has 99 working ATS readers. Do not write a scraper.

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F5.1 | Ingest from Ashby, Greenhouse, Lever via `career-ops/providers/{ashby,greenhouse,lever}.mjs` | **P0** | Tarang | 1.5 h |
| F5.2 | Normalize to the existing `job_snapshots` columns (`company_name`, `job_title`, `location_text`, `description_text`, `source_url`, `raw_payload_json`) | **P0** | Tarang | 45 m |
| F5.3 | **Write-once guarantee**: `job_id` derived from the posting URL via `career-ops/url-key.mjs`; ingest is `MERGE INTO job_snapshots … WHEN NOT MATCHED THEN INSERT`. A parsed job is stored exactly once and `description_text` is never rewritten. | **P0** | Tarang | 45 m |
| F5.4 | JD → structured requirements as a **SQL column** via `ai_query('databricks-llama-4-maverick', …)`. No Python service, no external key, no rate limits. | **P0** | Tarang | 1 h |
| F5.5 | Seed ~500 real JDs early — real company names only, no lorem ipsum | **P0** | Tarang | 45 m |
| F5.6 | Raw JD document archived to MongoDB (`jd_raw`) | P1 | Vijay | 30 m |
| F5.7 | HTML fallback parse for postings with no ATS API — lift `career-ops/fetch-jd.mjs` (its HTML path, **not** Playwright) | P1 | Tarang | 45 m |

---

## Epic 6 — Match agent (job ⋈ profile)

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F6.1 | Embeddings via `ai_query('databricks-gte-large-en')` → 1024-dim, for the profile and every JD | **P0** | Tarang | 45 m |
| F6.2 | Cosine-similarity match in plain SQL — **this is the primary path**; instant over 500 rows and indistinguishable in a 4-minute demo | **P0** | Tarang | 45 m |
| F6.3 | Explainable fit: score + matched skills + missing skills + a one-sentence reason per job | **P0** | Tarang | 1 h |
| F6.4 | Match results append to `profile_memory` so the profile learns from what it matched | **P0** | Tarang | 20 m |
| F6.5 | Vector Search index on the live `vthacks-vs` endpoint — parallel path, keep SQL as fallback | P1 | Tarang | 45 m |
| F6.6 | **Coursework lever** query: "take CS 3214 next semester → unlocks 40% more postings." Hits Deloitte's brief verbatim. | P1 | Tarang | 1 h |
| F6.7 | Skill-gap query: skills demanded by roles that rejected you, absent from your resume — lift `career-ops/jd-skill-gap.mjs` | P1 | Tarang | 45 m |

---

## Epic 7 — Verified apply (ANS / agent-to-agent) — **the spine of the demo**

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F7.1 | Employer agent service on Vultr: agent card at `/.well-known/agent-card.json`, ANS-resolvable, declares the fields it requires | **P0** | Vijay | 1.5 h |
| F7.2 | Applicant agent: resolve employer by ANS name → version + endpoint | **P0** | Vijay | 1 h |
| F7.3 | Identity-certificate check (cert ⟷ domain) | **P0** | Vijay | 1 h |
| F7.4 | **Trust Index**: 5 dimensions — Integrity, Identity, Solvency, Behavior, Safety — each returning a *reason string*, not just a number | **P0** | Vijay | 1.5 h |
| F7.5 | Policy gate: does the student's policy permit releasing *these* fields to an entity with *this* trust profile? | **P0** | Vijay | 45 m |
| F7.6 | Success path: A2A POST, human-confirmed, PII released only after F7.3–F7.5 pass | **P0** | Vijay | 1 h |
| F7.7 | **Refusal path**: verification fails → refuse, state why out loud, zero bytes of PII sent. Demo both paths; the refusal is the better television. | **P0** | Vijay | 45 m |
| F7.8 | Immutable MongoDB audit log (`a2a_audit`): every message, every verdict, exactly which PII fields were released and to whom | **P0** | Vijay | 45 m |
| F7.9 | Bidirectional verification — the employer agent also verifies our applicant agent. This is the answer to "isn't this spam?" | P1 | Vijay | 45 m |
| F7.10 | Live attack console against `fraud.webmesh.ai` (13 attacks: forged signatures, replayed requests, swapped quotes) with a climbing blocked-counter | P1 | Vijay | 1 h |

---

## Epic 8 — Generators (lift from career-ops)

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F8.1 | Tailored resume generator → PDF — lift `build-cv-latex.mjs` / `build-cv-html.mjs` + `generate-pdf.mjs` | **P0** | Vijay | 1.5 h |
| F8.2 | Cover letter generator → PDF — lift `generate-cover-letter.mjs` | **P0** | Vijay | 45 m |
| F8.3 | Outreach / recruiter email generator | P1 | Vijay | 30 m |
| F8.4 | **Evidence grounding**: every claim in a generated document traces to a `profile_memory` fact. Nothing fabricated — lift `verify-cv-facts.mjs`. | P1 | Vijay | 45 m |
| F8.5 | Artifacts written to a UC Volume, referenced by id from `artifacts` | **P0** | Vijay | 20 m |

---

## Epic 9 — Analytics (TigerData + Databricks AI/BI)

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F9.1 | TigerData `application_events` hypertable mirroring the Delta table's shape: `(event_at, application_id, job_id, event_type, event_source, metadata_json)` where `event_type ∈ {viewed, tailored, verified, refused, submitted, callback, rejected}`. One helper writes both stores. | **P0** | Tarang | 45 m |
| F9.2 | **Seed 30 days of synthetic history immediately.** Empty dashboards kill demos. | **P0** | Tarang | 30 m |
| F9.3 | Continuous aggregate: rolling callback rate by company / role / skill | **P0** | Tarang | 45 m |
| F9.4 | **The money chart**: "your callback rate drops 60 % when you apply more than 5 days after a posting goes live — here are 9 to hit in the next 48 hours." Only makes sense on a time-series DB; that is the answer to "why not plain Postgres?" | **P0** | Tarang | 45 m |
| F9.5 | Second chart, nearly free: verification events over time / attacks blocked per hour | P1 | Tarang | 20 m |
| F9.6 | Databricks AI/BI dashboard on the lakehouse — judges click it | P1 | Tarang | 45 m |
| F9.7 | Gemini picks the chart type for whatever the student asks about (proven VTHacks winner move, ~40 lines) | P2 | Nidhi | 45 m |

---

## Epic 10 — Frontend & UX (competing for Best UI/UX)

One idea, executed consistently: **the agent is a colleague reporting back —
everything is a card the agent hands you.**

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F10.1 | **Agent-state visualizer** — idle · listening · thinking · speaking · **REFUSING**. REFUSING gets its own treatment: halt, desaturate, red. Each state announced to screen readers. No other team will have this. | **P0** | Nidhi | 1 h |
| F10.2 | **Trust Card** hero component: 5 dimensions, each with its reason, styled like a nutrition label. Make it the most beautiful thing on screen — it is what the GoDaddy judges came to see. | **P0** | Nidhi | 1 h |
| F10.3 | Job list with match reasons as agent-handed cards | **P0** | Nidhi | 45 m |
| F10.4 | Keyboard-only navigation, correct tab order, ARIA, visible focus rings, 4.5:1 body contrast | **P0** | Nidhi | 1 h |
| F10.5 | Inline human approval for PII release (pattern from `assistant-ui`; do not hand-roll) | **P0** | Nidhi | 45 m |
| F10.6 | Funnel + insight charts (Tremor) | P1 | Nidhi | 45 m |
| F10.7 | Command palette (`cmdk`) mirroring voice — "everything you can say, you can type." Power feature, accessibility feature for users who cannot speak, and proof voice isn't bolted onto a mouse app. | P1 | Nidhi | 45 m |
| F10.8 | Designed empty / loading / error / no-results states — judges click straight into these | P1 | Nidhi | 45 m |
| F10.9 | Dark mode + `prefers-reduced-motion` (ten lines each, visible in five seconds) | P1 | Nidhi | 30 m |

---

## Epic 11 — Submission (two of four rubric axes are non-code — budget the time)

| ID | Feature | Tier | Owner | Est |
|---|---|---|---|---|
| F11.1 | Demo video showing **both** the success path and the refusal path | **P0** | All | 1 h |
| F11.2 | Devpost writeup + select **every** eligible category | **P0** | Nidhi | 30 m |
| F11.3 | Deployment-roadmap slide (pilot with VT Career Services → campus → multi-campus) — Deloitte explicitly scores this | **P0** | Tarang | 20 m |
| F11.4 | Consulting-framing slide (who owns it, what it costs, what it saves) — also explicitly scored | **P0** | Tarang | 20 m |
| F11.5 | Threat-model slide: impostor employer harvesting student PII; tradeoff = refuse on unverified rather than warn-and-continue, accepting false negatives | **P0** | Vijay | 20 m |
| F11.6 | Evidence slide: Lighthouse accessibility score + axe scan with zero violations. "Accessible" is a claim; a 100 is proof. | P1 | Nidhi | 30 m |
| F11.7 | Rehearse the 4-minute pitch three times out loud, mouse down, keyboard + voice only | **P0** | All | 45 m |

---

## Data model

### Databricks — `workspace.vthacks_2026`

**This schema already exists** (built by the team; tables empty). Extend it — do
not create a parallel `hirewire` schema.

Already there, use as-is:

| Table | Key columns | Our use |
|---|---|---|
| `job_snapshots` | `job_snapshot_id`, **`job_id`**, `source`, `source_url`, `company_name`, `job_title`, `location_text`, `description_text`, `discovered_at`, `captured_at`, `raw_payload_json` | The jobs table. `job_id` = `url_key` from `career-ops/url-key.mjs`. **Insert-once via MERGE**; `description_text` never rewritten. |
| `match_evaluations` | `evaluation_id`, `job_id`, `candidate_profile_id`, `model_provider`, `model_name`, `overall_score`, `recommendation`, `explanation_text`, `requirement_scores_json`, `created_at` | Match output. `model_provider`/`model_name` already exist, so a **Gemini-vs-Databricks scoring comparison is nearly free** and demos well. |
| `application_events` | `event_id`, `application_id`, `job_id`, `event_type`, `event_source`, `event_at`, `metadata_json` | Lakehouse copy for the AI/BI dashboard. The TigerData hypertable is the primary for time-series charts; one helper writes both. |
| `voice_events` | `voice_event_id`, `application_id`, `session_id`, `event_type`, `outcome`, `event_at`, `metadata_json` | Voice session telemetry — free evidence that the voice layer is real. |
| `email_classifications` | `classification_id`, `application_id`, `gmail_message_id`, `classification`, `confidence`, `rationale_text`, `received_at`, `classified_at`, `requires_review` | Unused in the 15-hour cut (Gmail is out of scope). Leave it. |
| `latest_application_state` | view | `application_id`, `job_id`, `current_state`, `event_source`, `state_changed_at` |

We add (Tarang, F0.4):

| Table | Key columns | Notes |
|---|---|---|
| `users` | `user_id`, `email`, `created_at` | From Databricks Apps SSO identity |
| `profile_memory` | `fact_id`, `user_id`, `kind`, `key`, `value`, `confidence`, `source`, `source_ref`, `observed_at` | **Append-only.** Never UPDATE, never DELETE. |
| `profile_current` | view | Latest row per `(user_id, key)` by `observed_at` |
| `courses` | `user_id`, `course_code`, `title`, `term`, `grade`, `skills` | Feeds the coursework lever |
| `goals` | `user_id`, `target_roles`, `locations`, `sponsorship_required`, `comp_floor`, `start_date`, `accommodations` | Captured by voice |
| `job_embeddings` | `job_id`, `embedding` (1024-dim), `embedded_at` | Kept separate so `job_snapshots` stays insert-once |
| `artifacts` | `artifact_id`, `user_id`, `job_id`, `kind`, `volume_path` | `kind ∈ {resume, cover_letter, email}` |
| `agent_verifications` | `verification_id`, `application_id`, `agent_ans_name`, `agent_version`, `verdict`, `integrity`, `identity`, `solvency`, `behavior`, `safety`, `reasons_json`, `pii_fields_released`, `checked_at` | **The strategy doc names this as an explicit GAP.** Powers the Trust Card; sits alongside `application_events`. Vijay needs this table to exist — it is Tarang's first deliverable after the DDL. |

### TigerData
`application_events` hypertable + continuous aggregates (funnel, response-time
decay, rolling callback rate, verification events over time).

### MongoDB Atlas
`jd_raw` (raw JD documents) · `a2a_audit` (immutable handshake log). One store,
two sponsor tracks: the audit log *is* the trust story.

---

## The end-to-end flow we are demoing

```
Databricks SSO login
  └─ upload resume (or skip) · upload transcript (or skip) · upload LinkedIn (or skip)
       └─ profile agent: Gemini multimodal → profile JSON → profile_memory
            └─ completeness scorer finds the gaps
                 └─ ElevenLabs asks: basic gaps first, then role / sponsorship /
                    location / comp / start date / accommodations → goals
                      └─ ingest Ashby + Greenhouse + Lever → job_snapshots (stored once, by job_id)
                           └─ match agent: embeddings + cosine + reasons
                                └─ generators: resume · cover letter · email
                                     └─ verify_employer via ANS → Trust Card
                                          ├─ PASS → human approves → A2A apply → audit log
                                          └─ FAIL → REFUSE, said out loud, nothing sent
                                               └─ every step → application_events → charts
```

Profile memory is written at every arrow. That is what makes it a memory rather
than a form.

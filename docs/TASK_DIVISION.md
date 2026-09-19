# HIREWIRE — Task Division (3 people, 15 hours)

**T-0 = Sunday 2026-09-20, 08:00 ET.** Judging 10:30, New Classroom Building.
Written at ~T-15 (Saturday ~17:00 ET).

Feature IDs refer to [`FEATURE_LIST.md`](./FEATURE_LIST.md).

---

## 0. The budget, honestly

| | Hours |
|---|---|
| Wall clock remaining | 15 |
| Shared, non-lane work (integration, video, Devpost, slides, rehearsal) | 4 |
| **Lane work available per person** | **~11** |
| P0 lane work actually assigned per person | 10–11 |

There is **no slack**. Three consequences, all binding:

1. **Every lane builds against a fixture first** (§4). Nobody waits for another
   lane. This is the only reason three parallel lanes fit in eleven hours.
2. **The descope switches in each lane are pre-authorized.** If you hit a
   checkpoint red, flip the switch — do not call a meeting, do not debate it at
   4 AM. That decision is already made, here, now.
3. **Nothing is added to P0 after T-12.** Not by anyone, for any reason.

What broke the budget was keeping all three datastores (Databricks + TigerData +
MongoDB) with three people instead of four. That was a deliberate call for track
coverage. The price is paid in §3's P1 lists, which are genuinely optional.

**Two environment traps, both cheap and both demo-fatal if missed:**
- Build on the **TEAM** workspace, schema `workspace.vthacks_2026`, and put `-p TEAM`
  on every CLI call. The personal Free Edition workspace is a throwaway.
- `app/vthacks-career-app/databricks.yml` targets `dbc-0bfd7b56-c2eb` +
  warehouse `441b670a0ff475e0`. **Probably the team workspace — leave it alone
  until someone confirms.** That host/warehouse pair arrived together in
  `79a8fde` ("collaborative … baseline") and the warehouse ID matches the one
  the strategy doc lists under TEAM. Confirm by checking that
  `workspace.vthacks_2026` exists there with the team's tables, or ask Vijay.

---

## 1. Lane charters

### 🔴 VIJAY — Identity, Trust & Agent-to-Agent
**Owns:** the domain, both ANS agents, the employer agent on Vultr, the Trust
Index, the apply/refuse decision, the MongoDB audit log.
**Directories:** `agents/applicant/`, `agents/employer/`, `infra/vultr/`, `certs/` (gitignored)
**Why you:** you have macOS + Homebrew (`ans-cli` is a brew formula) and the
Databricks CLI already authed on profile `DEFAULT`.

> **⚠️ START F0.2 BEFORE YOU READ THE REST OF THIS DOCUMENT.**
> DNS TXT propagation plus ACME verification is the only item on the whole board
> that cannot be parallelized, rushed, or recovered. If it starts at T-8 the ANS
> track dies and with it the richest prize on the board (per-team-member Meta
> Ray-Bans / Beats / monitor) *and* the refusal beat the pitch is built around.
>
> The GoDaddy sponsor table (Sat 13:00–15:30) has **already closed**. Get the ANS
> API key from **#godaddy on Discord** right now. If the workshop office hours
> (16:30–17:15) are still live, that is your fastest path.

| # | Task | ID | Est | Done by |
|---|---|---|---|---|
| 1 | Register domain, GoDaddy Registry, code `MLH0918VTH` | F0.1 | 15 m | T-14.5 |
| 2 | `ans-cli generate-csr` ×2, `register` ×2, place DNS TXT, `verify-acme`, `status`, `get-identity-certs` | F0.2 | 2.5 h | **T-12** |
| 3 | Vultr box, HTTPS, employer agent reachable publicly (code `MAJORLEAGUEHACKING`) | F0.3 | 1 h | T-11 |
| 4 | Employer agent: `/.well-known/agent-card.json`, declares required fields | F7.1 | 1.5 h | T-10 |
| 5 | Applicant agent: ANS resolve → version + endpoint | F7.2 | 1 h | T-9 |
| 6 | Identity-certificate check (cert ⟷ domain) | F7.3 | 1 h | T-8 |
| 7 | Trust Index: 5 dimensions, **each with a reason string** → persist to `agent_verifications` *(Tarang creates that table by T-14; until then write to the fixture)* | F7.4 | 1.5 h | T-7 |
| 8 | Policy gate + success path: A2A POST, PII only after 6 & 7 pass | F7.5, F7.6 | 1.5 h | T-6 |
| 9 | **Refusal path** — same code, inverted: refuse, return `spoken_reason`, send zero PII | F7.7 | 30 m | T-5.5 |
| 10 | Threat-model slide *(during the freeze, not before)* | F11.5 | 20 m | T-2 |

**First things to pull if you are green at T-6**, in this order:
`F7.8` MongoDB audit log (0.75 h — a whole sponsor track) → `F7.10` live attack
console vs `fraud.webmesh.ai` with a blocked counter (1 h — the single best
television in the pitch) → `F7.9` bidirectional verification (0.75 h — the answer
to "isn't this spam?") → `F5.6` raw JD → MongoDB.

**Descope switches:**
- ACME verification not green by **T-11** → ship the Trust Index against
  `fraud.webmesh.ai`'s live agent card only, drop our own employer agent
  registration, and say so honestly on the threat-model slide.
- Vultr fighting you at T-10 → serve the employer agent from anywhere with public
  HTTPS (Fly, Render, a tunnel). ANS needs *a* reachable endpoint, not Vultr
  specifically. Losing the Vultr track beats losing the ANS track.

---

### 🟡 TARANG — Data Plane, Match & Analytics
**Owns:** `workspace.vthacks_2026` and every table in it, job ingestion, the match
agent, the generators, TigerData.
**Directories:** `data/`, `sql/`, `scripts/ingest/`, `notebooks/`
**Why you:** biggest surface, most liftable code. `career-ops/` next door has 99
working ATS readers — **do not write a scraper.**

| # | Task | ID | Est | Done by |
|---|---|---|---|---|
| 1 | Extend `workspace.vthacks_2026` with our new tables + `profile_current` view. **Create `agent_verifications` first — Vijay is blocked on it.** | F0.4, F3.3 | 45 m | T-14 |
| 2 | Ingest Ashby + Greenhouse + Lever via `career-ops/providers/*.mjs` | F5.1 | 1.5 h | T-12.5 |
| 3 | Normalize to the existing `job_snapshots` columns | F5.2 | 45 m | T-12 |
| 4 | **Write-once**: `job_id` from `career-ops/url-key.mjs`, ingest via `MERGE INTO job_snapshots … WHEN NOT MATCHED THEN INSERT`. A job is stored once; `description_text` is never rewritten. | F5.3 | 45 m | T-11 |
| 5 | Kick off the ~500-JD seed **in the background** and move on | F5.5 | 45 m | T-10 |
| 6 | Embeddings: `ai_query('databricks-gte-large-en')` → 1024-dim, profile + every JD | F6.1 | 45 m | T-9.5 |
| 7 | Cosine match in plain SQL — **the primary path**, not the fallback | F6.2 | 45 m | T-9 |
| 8 | Explainable fit: score + matched + missing + one-sentence reason | F6.3 | 1 h | T-8 |
| 9 | **Application packet generator** — ONE `ai_query` call returning `{resume_md, cover_letter_md, email_md}` as structured JSON. Not LaTeX. Nidhi renders it; a print stylesheet is the PDF story. | F8.1–F8.3 | 1 h | T-7 |
| 10 | TigerData `application_events` hypertable | F9.1 | 45 m | T-6.5 |
| 11 | **Seed 30 days of synthetic history.** Empty dashboards kill demos. | F9.2 | 30 m | T-6 |
| 12 | Continuous aggregate + **the money chart**: callback rate vs days-since-posting | F9.3, F9.4 | 1.25 h | T-5 |
| 13 | Deployment-roadmap + consulting-framing slides *(during the freeze)* | F11.3, F11.4 | 40 m | T-2 |

**First things to pull if you are green at T-5**, in this order:
`F6.6` **coursework lever** ("take CS 3214 → +40 % postings" — this hits Deloitte's
brief verbatim and is the highest-value P1 on the board) → `F6.7` skill-gap query
(lift `jd-skill-gap.mjs`) → `F9.6` AI/BI dashboard → `F5.4` JD→requirements via
`ai_query` → `F3.2` transcript→courses → `F6.5` Vector Search index.

**Descope switches:**
- Vector Search index slow or awkward → **don't**. Plain SQL cosine over 500 rows
  is instant and indistinguishable in a four-minute demo. F6.5 is P1 for exactly
  this reason.
- TigerData not connected by **T-6** → `application_events` becomes a Delta table
  and the money chart becomes a Databricks SQL query. You lose the Tiger track,
  not the chart. The chart is what the pitch needs.
- Ingestion under-delivering → 120 real JDs across three boards beats 500 across
  one. Real company names either way; no lorem ipsum, no "Acme Corp."

---

### 🟢 NIDHI — Voice, Agent Loop & Frontend
**Owns:** the Next.js app, login, intake, the profile agent, the ElevenLabs voice
layer, the tool router, and every pixel.
**Directories:** `app/vthacks-career-app/`
**Why you:** this lane is the demo surface. Everything the judges see is yours,
and two of the four rubric axes are presentation and completeness.

| # | Task | ID | Est | Done by |
|---|---|---|---|---|
| 1 | shadcn/ui init + `eslint-plugin-jsx-a11y` **in hour one** so it catches a11y violations as you type | F0.5 | 45 m | T-14 |
| 2 | **Dual-pathway auth** — Auth.js v5, email/password + Google, `role` on the account, guarded `/applicant/*` and `/employer/*` layouts, `/choose-role` for Google users, public two-pathway landing. *(Template is being built on `feat/auth-template`; your job is wiring it to the real user store and the profile flow.)* | F1.1–F1.6 | 3 h | T-12 |
| 3 | Resume upload → UC Volume, **and the skip path on every step** | F2.1, F2.2 | 1 h | T-12.5 |
| 4 | Gemini multimodal: resume PDF in directly → profile JSON under a published schema | F3.1 | 1.5 h | T-11 |
| 5 | Completeness scorer → ordered list of missing fields (this list is the input to #7) | F3.4 | 30 m | T-10.5 |
| 6 | ElevenLabs voice in/out + barge-in. Start from `elevenlabs-nextjs-starter`; do not hand-roll audio. | F4.1 | 1.25 h | T-9 |
| 7 | **Adaptive questioning**: gaps exist → basic questions; profile complete → role / sponsorship / location / comp floor / start date / accommodations | F4.3 | 1 h | T-8 |
| 8 | Goals capture → `goals`, echoed back for confirmation | F4.4 | 30 m | T-7.5 |
| 9 | **Tool router** (Gemini function-calling): `search_jobs`, `match`, `explain_match`, `tailor`, `verify_employer`, `apply`, `status`, `open_dashboard`. Every utterance becomes an action. | F4.5 | 1.5 h | T-6 |
| 10 | **`AgentCard`, one component, five variants** — job · match · trust · artifact · refusal. The visual metaphor *is* the architecture: the agent hands you cards. | F10.2, F10.3 | 1.25 h | T-5 |
| 11 | **Agent-state visualizer**: idle · listening · thinking · speaking · **REFUSING**. REFUSING halts, desaturates, goes red, and is announced to screen readers. No other team will have this. | F10.1 | 1 h | T-4 |
| 12 | Devpost writeup, **select every eligible category** *(during the freeze)* | F11.2 | 30 m | T-2 |

**Accessibility is not a task — it is how you type.** Radix gives you keyboard nav
and ARIA by default, `jsx-a11y` catches the rest live, and you do one 30-minute
audit pass at T-4.5 (tab order, focus rings, 4.5:1 body contrast). It is the
entire thesis of the product; it does not get a checkbox and it does not get cut.

**First things to pull if you are green at T-4**, in this order:
`F10.5` inline human approval for PII release → `F10.8` designed empty / loading /
error / no-results states (judges click straight into these; a designed empty
state reads as more finished than a fifth feature) → `F10.7` `cmdk` command
palette mirroring voice → `F10.9` dark mode + `prefers-reduced-motion` (ten lines
each) → `F11.6` Lighthouse + axe evidence slide → `F2.4` LinkedIn export.

**Descope switches:**
- **The employer pathway stays a stub.** Auth, the role split, and a static
  employer dashboard — that is the whole investment. The employer *story* is
  Vijay's agent, not a second product surface. Adding real employer features is
  the single easiest way to lose this lane, and dual-pathway auth already cost
  this lane ~2¼ h it did not have.
- Voice loop not working by **T-8** → ship the command palette (`F10.7`) as the
  primary interface and ElevenLabs as TTS-only for the refusal line. The spoken
  refusal is non-negotiable; full duplex conversation is.
- Gemini multimodal fighting the PDF at T-11 → `ai_query('databricks-llama-4-maverick')`
  on extracted text. Loses the multimodal wow; keeps the pipeline.
- Behind at T-5 → cut visualizer states to three (listening · thinking · **REFUSING**).
  Keep REFUSING. It is the state that ties the UI to the trust story.

---

## 2. Shared blocks — everyone, no exceptions

| Window | What | Rule |
|---|---|---|
| **T-4 → T-3** | **INTEGRATE.** All three on one machine, run the flow end to end, fix what breaks. | No new features. Only wiring and bugs. |
| **T-3** | ⛔ **CODE FREEZE** | Nobody types a feature after this line. |
| T-3 → T-2 | Record the demo video: **both** the success path and the refusal path | Refusal is the money shot |
| T-2 → T-1.5 | Devpost + the three slides (roadmap, consulting framing, threat model) | Two of four rubric axes are non-code |
| T-1.5 → T-0.5 | Rehearse the 4-minute pitch **three times out loud** | Mouse down. Voice and keyboard only. |
| T-0.5 | Fire a dummy SQL query to warm the warehouse (cold start is 20–30 s) | Do not skip this |
| **T-0** | **SUBMIT** | Judging 10:30, full team present |

---

## 3. Checkpoints — go / no-go, three minutes each

| Time | Question | If NO |
|---|---|---|
| **T-12** | Is ACME verification green on both ANS agents? | Vijay flips descope switch #1. Tell the team in one sentence. |
| **T-12** | Are there real rows in `workspace.vthacks_2026.job_snapshots`? | Tarang drops to one board, seeds 120 rows, moves on. |
| **T-8** | Does voice in → tool call → action work at all, even for one tool? | Nidhi flips to command-palette-primary. |
| **T-8** | Does `verify_employer` return a Trust Index with reasons? | Hardcode one passing and one failing verdict. **The refusal demo ships either way.** |
| **T-5** | Can we get from login → match → verify → refuse without a human editing a file? | Stop feature work early. Integrate now, not at T-4. |
| **T-3** | Freeze. | No exceptions. Not for a one-line fix. |

---

## 4. The contracts — agree on these now, build against fixtures immediately

Nidhi writes `app/vthacks-career-app/src/fixtures/*.json` in the first thirty
minutes with realistic values. Tarang and Vijay replace the handlers behind the
same shapes. **Nobody blocks on anybody.** If a shape needs to change, the change
lands in the fixture first.

```
POST /api/intake/resume   → { artifact_id, profile_patch, gaps: string[] }
GET  /api/profile         → { facts: [{ key, value, confidence, source }], completeness: 0..1 }
POST /api/goals           → { ok: true }
POST /api/match           → { matches: [{ job_id, company, title, score,
                                          matched_skills[], missing_skills[], reason }] }
POST /api/generate        → { resume_md, cover_letter_md, email_md }
POST /api/verify          → { verdict: "pass" | "refuse",
                              dimensions: [{ name, score, reason }],   // 5 of these
                              spoken_reason, checked_at }
POST /api/apply           → { status: "submitted" | "refused",
                              fields_released: string[], audit_id, spoken_reason }
POST /api/events          → 204
```

Hard rules on these:
- `dimensions` is always exactly five: Integrity, Identity, Solvency, Behavior,
  Safety. Each one always carries a `reason`. A score without a reason is a bug.
- `/api/apply` returning `refused` **must** return `fields_released: []`. If that
  array is ever non-empty on a refusal, stop everything and fix it — that is the
  one bug that would make the pitch a lie.
- The voice tool router calls these same endpoints. No parallel code path for
  voice. "Everything you can say, you can type" has to be true at the API layer
  or it is not true at all.

---

## 5. Who answers what in Q&A

| Question | Who | Answer lives in |
|---|---|---|
| "What does ANS do that TLS doesn't?" | Vijay | Strategy doc §8 |
| "Isn't this spamming employers?" | Vijay | Bidirectional verification + human confirm + audit log |
| "What did Databricks actually do?" | Tarang | Open the notebook: `ai_query` embeddings, fit scoring in SQL, coursework aggregation |
| "Why Tiger over plain Postgres?" | Tarang | Hypertable + continuous aggregates; the time-decay query *is* the product |
| "Does it work with Workday today?" | Anyone | **No.** A2A with verified employer agents today; legacy ATS bridging is roadmap. Overclaiming loses judges faster than a gap does. |
| "Is it actually accessible?" | Nidhi | Lighthouse score + axe scan, and the demo was run mouse-down |

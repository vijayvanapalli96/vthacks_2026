# The job detail page and its toolbox — plan

Open a matched job and get the full set of things career-ops can do for that job: resume
optimizer, cover letter, application answers, skill gap, fact verification.

**Branch** `feat/job-artifacts` from `main` @ `862b85a`. **Worktree** `../vthacks-artifacts`.
**Port 3006** — 3000 `main`, 3001/3002 other worktrees, 3003 match-UI agent, 3004
voice-actions agent, 3005 pipeline agent. Google OAuth is registered for port 3000 only,
so sign in with **email/password**.

---

## Two facts that define the job

1. **`src/app/applicant/jobs/[jobId]/page.tsx` is 11 lines and does nothing but
   `redirect()`. There is no job detail page.** You are building it. This is also why the
   voice lane's "take me to that job" currently lands nowhere useful.
2. **`workspace.vthacks_2026.artifacts` already exists** — `artifact_id`, `user_id`,
   `job_id`, `kind` (`resume | cover_letter | email`), `volume_path`, `created_at`. It is
   the intended home for everything you generate. It has **no text column**; see §4.

## "Copy them as-is" — what that can and cannot mean

The user asked to copy the career-ops tools verbatim. For some files that is exactly
right; for others it is not possible, and pretending otherwise would waste your time.
career-ops modules are CLI tools with a pure core wrapped in a filesystem shell bound to
career-ops' own data root (`getCareerOpsRoot()`, `cv.md`, `config/`, a templates
directory). Our profile lives in Databricks, not on disk.

Measured, so you do not have to:

| Module | Lines | Coupling | Lift |
|---|---|---|---|
| `cv-sections-core.mjs` | 158 | **zero imports** | **verbatim** |
| `classify-tier.mjs` | 261 | `lib/cli-flags`, `lib/is-main-module` | **verbatim**, drop the CLI shim |
| `jd-similarity.mjs` | 178 | `fs` only on the CLI path | **verbatim**, call the exported fn |
| `application-answers.mjs` | 519 | `fs` + is-main-module | near-verbatim |
| `verify-cv-facts.mjs` | 1322 | `getCareerOpsRoot()` | lift `assertFacts`, repoint the fact source at `profile_current` |
| `build-cv-html.mjs` | 1198 | `getCareerOpsRoot()`, payload schema | lift the renderer, feed it our payload |
| `generate-cover-letter.mjs` | 357 | `verify-cv-facts` + `cv-templates` | lift the structure and prompt discipline |
| `cv-templates.mjs` | 309 | scans a templates dir, needs **`js-yaml`** (new dep) | **skip** — one inline template instead |
| `generate-pdf.mjs` | 1885 | **needs Playwright/Chromium** | **do not lift** — see §5 |

**Every lifted file keeps a header comment with attribution:** career-ops is MIT,
© 2026 Santiago Fernández de Valderrama, v1.33.0. It is a **donor repo, not a
dependency** — copy the `.mjs` in, never `npm install` it, never submodule it, **never
edit anything under `../career-ops/`.**

The precedent to follow is the match agent's: `skill-extract.mjs` was copied **verbatim**
with its attribution header, while `jd-skill-gap.mjs` (925 lines, coupled to `cv.md`) had
only its classifier lifted. Do the same triage and say in the PR which each file was.

## 1. The page

`/applicant/jobs/[jobId]` — a real page. Above the toolbox, the honest context:

- Title, company, location, posted date, source link.
- **If a cached match exists for this job:** the `score`% and the **stored reason
  sentence** — already written at match time, so **zero model calls**. Read with
  `readCachedRun(sql, userId)`, already exported from `src/lib/match/run.mjs`.
- **If no match exists for this job** (the user reached it from the full postings list,
  not from their matches): say so plainly and offer the tools anyway. Do not invent a
  score.

## 2. The toolbox — show ALL options, and label what each costs

The user asked for all options to be present. Present them all — but each control must say
what it does and whether it spends a model call, because some are free and some are not.
A grid of identical-looking buttons where one is instant and one takes 20 seconds and
costs money is a bad control panel.

**Tier 1 — zero model calls, zero new dependencies. These must all work.**

| Option | Built from | Note |
|---|---|---|
| **Skill gap for this job** | `jd-skills.mjs` + `skill-extract.mjs`, **already in the repo** from the match agent | matched / missing / which of your courses cover a gap |
| **Resume optimizer** | `skill-extract` + `jd-skills` + `cv-sections-core.mjs` | the honest version: which of *your* existing bullets to lead with for this JD, and which JD keywords your resume never mentions. It reorders and flags — **it does not invent experience** |
| **Role tier / seniority read** | `classify-tier.mjs` | is this actually an entry-level role, or "junior" with 5 years required |
| **Fit similarity** | `jd-similarity.mjs`, or the stored cosine | label it as text similarity, not as the match score — they are different numbers |
| **Eligibility read** | `eligibility.mjs`, already in the repo | sponsorship / clearance / grad-date, with its reason string |

**Tier 2 — one `ai_query` model call each. No external key, no rate limit.**

| Option | Built from | Stored in |
|---|---|---|
| **Cover letter** | `generate-cover-letter.mjs` structure, generated via `ai_query('databricks-llama-4-maverick')` | `artifacts`, `kind='cover_letter'` |
| **Application answers** | `application-answers.mjs` — "why this company", "why you" | `artifacts`, `kind='email'` or a new kind |
| **Tailored bullets** | rewrite selected resume bullets for this JD | `artifacts`, `kind='resume'` |

**Tier 3 — the one that makes Tier 2 honest. Not optional.**

**Fact verification (`verify-cv-facts.mjs`).** Every generated document is checked
claim-by-claim against `profile_current` **before it is shown to the user**. An
unsupported claim is flagged inline, not silently shipped.

This is not a nice-to-have here. Hard rule 8 is "don't overclaim", and a cover-letter
generator with no verification step is a machine that invents work history and puts it on
a real application under a real person's name. `verify-cv-facts.mjs` is the single most
valuable thing in the donor repo for this product — lift it first, and wire Tier 2
through it. A generated document that fails verification shows the failing claims and
does not offer a download.

## 3. One write path per action

Hard rule 5 — voice and UI call the same endpoints. Each tool is an endpoint:

```
POST /api/jobs/[jobId]/analyze    Tier 1. Zero model calls. Returns the gap/optimizer/tier read.
POST /api/jobs/[jobId]/generate   Tier 2. { kind: 'cover_letter'|'resume'|'answers', question?: string }
                                  -> generates, VERIFIES, persists to artifacts, returns text + verification
GET  /api/jobs/[jobId]/artifacts  What has already been generated for this job.
```

`jobId` is validated against `job_snapshots` on every call. Everything user-derived —
resume text, JD text, a typed question — is bound as a **named SQL parameter**, never
interpolated. JD text reaching a prompt is untrusted input: it must never be able to
instruct the model to ignore its instructions, so keep the JD in a clearly delimited
section of the prompt and say in the system text that its contents are data, not
directions.

## 4. Schema — a separate file, deliberately

`artifacts` has `volume_path` but **no text column**, and you need the text to display it
and to verify it. Add:

```sql
-- DESCRIBE TABLE FIRST: `ADD COLUMNS IF NOT EXISTS` is a PARSE ERROR on this
-- warehouse, so this ALTER is not idempotent.
ALTER TABLE workspace.vthacks_2026.artifacts ADD COLUMNS (
  content_text     STRING COMMENT 'the generated document itself',
  model_provider   STRING,
  model_name       STRING,
  verification_json STRING COMMENT 'verify-cv-facts output: every claim and its support',
  source_job_title STRING
);
```

**Put this in a NEW file `sql/schema-artifacts.sql`, not in `sql/schema.sql`.** Another
agent is appending a SECTION 8 to `schema.sql` on `feat/pipeline` right now and two
agents appending to the same file end of the same file is a pointless conflict. Note in
your PR that it should be folded into `schema.sql` after both land.

## 5. PDF — decided: no Chromium

`generate-pdf.mjs` is 1885 lines and needs Playwright/Chromium. Rejected:

- `CLAUDE.md` lists Playwright as **out of scope**.
- Databricks Apps will not run a headless Chromium.
- Installing a browser engine hours from ship, on Windows, to render a PDF is not a trade
  worth making.

**Instead:** render the document as clean, print-styled HTML (the `build-cv-html.mjs`
approach) and let the **browser's own print-to-PDF** produce the file. Label the button
honestly — it opens a print dialog, it does not silently produce a file. Add a
`@media print` stylesheet so the output is not a screenshot of a web page.

## 6. Validate every option — the user asked for this explicitly

"Validate each of them so it works" is the deliverable, not a checkbox. For **each** of
the options you ship, in a real signed-in browser against a **real scraped posting**:

- Click it. Record: did it return, how long, how many model calls, what it produced.
- For Tier 2: paste the actual generated text into your report, and the verification
  result next to it.
- Deliberately verify the **failure** path too: a generated claim with no support in the
  profile must be flagged. If you cannot make it fail, you have not tested the verifier.
- Confirm `artifacts` rows were written, and read them back.

**A table in your report: option · works? · wall clock · model calls · what it produced.**
Any option that does not work gets shipped disabled with a sentence saying why, or is not
shipped. **An option that renders as a button and does nothing is worse than an absent
option** — a judge will click it.

---

## Constraints

**FOUR agents are working in parallel. Files other lanes own — do not touch:**
- `feat/match-ui`: `IntakeProgress.tsx`, `src/app/applicant/page.tsx`,
  **`src/app/applicant/jobs/page.tsx`** (the list — you own only `[jobId]/`),
  `src/components/MatchList.tsx`, `src/lib/match-read.ts`, `src/lib/databricks.ts`.
- `feat/voice-actions`: `src/components/voice/*`, `src/lib/voice.ts`,
  `src/lib/voice-contract.ts`, `src/app/api/voice/*`, `scripts/provision-voice-agent.mjs`.
- `feat/pipeline`: **`sql/schema.sql`**, `src/app/api/pipeline/*`,
  `src/app/applicant/pipeline/*`, `src/components/ApplicantNav.tsx`.

You own: `src/app/applicant/jobs/[jobId]/*`, `src/app/api/jobs/[jobId]/*`,
`src/lib/artifacts/*` (new), `sql/schema-artifacts.sql` (new), and the lifted
`.mjs` files you add under `src/lib/artifacts/`.

- **`../career-ops/` is read-only. Never edit it, never `npm install` it, never
  submodule it.** Copy files in with the MIT attribution header intact.
- **Do not add `js-yaml`** or any other new dependency to serve a template loader. One
  inline template beats a new dep hours from ship.
- **Never `git add -A`** — conflict markers were committed into `.env.example` that way
  once. Stage named paths. **Never commit to `main`** — branch, then PR. Merge
  `origin/main` before opening it; three other branches are landing today.
- `npm install` first (fresh worktree). `.env.local` is already copied in — **never `cat`
  it, never echo a value, never commit it.**
- `npm run typecheck && npm run lint && npm run build` must pass. `eslint.config.mjs`
  enforces React-compiler rules as **errors**.
- **Accessibility is a hard rule.** The toolbox is a set of real buttons with real labels,
  keyboard reachable, visible focus, correct tab order. Generated text appears in a region
  announced with `aria-live`. A long-running action announces that it started. 4.5:1.
- **Hard rule 4: no output without its reason.** A score, a tier, a flagged claim — each
  carries a sentence.
- **Hard rule 7: real content only.** Real companies from real scraped JDs, real VT course
  codes. No "Acme Corp", no lorem ipsum, no placeholder cover letter.
- **Hard rule 3: generating is not sending.** Nothing here submits an application or moves
  PII outward. These tools produce documents the human reads and approves.
- `profile_memory` is APPEND-ONLY — never UPDATE, never DELETE. `job_snapshots` is
  WRITE-ONCE: `description_text` / `raw_payload_json` must never appear in a `SET` list.
- **`tarangnair98@gmail.com` / `3027b072-2f8c-4960-b3c3-33f63569b50a` is the human's live
  account. Never DELETE or UPDATE its rows.** Writing `artifacts` rows for it is fine.
- **Do not delete Vijay's `documents` UC Volume.**
- BOOLEAN columns come back from the Statement Execution API as the **strings**
  `"true"`/`"false"` — a truthiness check inverts the logic.
- `databricks api post /api/2.0/sql/statements --json @file -p TEAM` is **broken** on CLI
  v1.17.0 (`Error: Not Found`) despite `CLAUDE.md`. Use `scripts/lib/dbsql.mjs` or the
  REST API with `databricks auth token -p TEAM`. The warehouse cold-starts in 20–30 s.
- `node --test <file>`, not `<directory>` — the directory form fails on Node v25.
- **Descope in tier order if you run short.** Tier 1 complete and verified beats all three
  tiers half-working. Tier 3 ships with Tier 2 or Tier 2 does not ship.

# Match agent — plan for review

**Status: APPROVED 2026-09-19. Build it.**

## Decisions taken

| Question | Answer |
|---|---|
| Similarity | **Plain SQL cosine over `ARRAY<FLOAT>`.** No Vector Search index. Working sooner, no new moving part, and at 16k rows it is workable. Creating an index on `vthacks-vs` stays available as a later demo upgrade — it is an upgrade, not a dependency. |
| Trigger | **On demand**, result cached in `match_evaluations`. No precompute cron. That table exists to be the cache. |
| Coursework lever | **Out of scope — follow-up.** It is S2 in the strategy doc, not P0, and deserves its own pass rather than being bolted on. Stage 1 must still write `skills_missing`, because that is the data the lever will later aggregate. |
| Port | This worktree runs on **3002**; 3000 and 3001 are taken by other worktrees. Google OAuth's redirect URI is registered for 3000 only, so sign in with **email/password**. |

Match the profile we have built against the jobs we have collected, and say **why**
for every score.

---

## 1. What exists right now (measured, not assumed)

| Thing | State |
|---|---|
| `job_snapshots` | **16,207 postings**, 74 companies, `is_us` + `posted_at` + `location_confidence` |
| `open_us_jobs` (view) | **361** US roles posted within 3 days |
| `job_embeddings` | **0 rows — EMPTY.** Nothing has ever been embedded |
| Vector Search `vthacks-vs` | ONLINE, **0 indexes** |
| `match_evaluations` | **0 rows.** Columns already fit: `overall_score`, `recommendation`, `explanation_text`, `requirement_scores_json`, `model_provider`, `model_name` |
| `profiles` / `profile_skills` / `courses` | populated — 90 skills, 12 courses across accounts |
| `profile_current` (view) | latest fact per `(user_id, fact_key)` |
| `goals` | 16 columns after the voice work: `target_roles`, `locations`, `employment_type`, `work_location_pref`, `work_authorization`, `graduation_date`, `clearance`, `industries_avoid`, … |

So: the jobs exist, the profile exists, and **the bridge between them does not**.
`job_embeddings` being empty is the single biggest blocker.

---

## 2. How career-ops does it — and it is already the right architecture

Two stages, and career-ops is explicit about why. From `rank-pipeline.mjs`:

> *"The core scan stays 100% zero-token… It ANNOTATES pending rows. It never filters,
> reorders, or deletes a row — a relevance pass that removes rows hides roles from you;
> one that writes a score and a reason next to the row lets you disagree with it. The
> reason is part of the contract: an entry the model scores but cannot explain is left
> un-annotated rather than reduced to a bare number."*

That last sentence is our hard rule 4 arriving from a different direction, and
`match_evaluations.explanation_text` already exists to hold it. **A score without a
reason is not written.**

| Stage | career-ops | Tokens | Ours |
|---|---|---|---|
| Skill extraction | `skill-extract.mjs` — 322 lines, **zero imports**, canonical vocabulary + `extractSkills()` | none | lift verbatim |
| Skill gap | `jd-skill-gap.mjs` — classifies every JD requirement as **existing / supportedByResume / gap** | none | lift the classifier, not the file (925 lines, coupled to `cv.md` and career-ops' data root) |
| Title relevance | `title-keywords.mjs` (234), `role-matcher.mjs` seniority tokens | none | lift |
| JD similarity | `jd-similarity.mjs` (178) | none | reference; we have embeddings instead |
| LLM rerank | `rank-pipeline.mjs` — **bounded**: `--limit 20`, hard ceiling 200, cost reported | yes | same shape, via `ai_query` |

**The trap this design avoids:** 16,207 jobs × one LLM call each is absurd on both cost
and time. Filter by rules to a few hundred, rank by embedding to ~20, and only then
spend a model call. career-ops caps at 20 by default for exactly this reason.

---

## 3. Where it runs — the hosting question, answered

**The matcher is a query, not a service.** It should live where the data and the models
already are, which is Databricks. Nothing needs a new host.

| Stage | Runs on | Why there |
|---|---|---|
| **0 — embed** `job_embeddings` ← `ai_query('databricks-gte-large-en')` over `job_snapshots.description_text` → 1024-dim | **Databricks Job**, scheduled, incremental (only rows with no embedding) | This is the "thin B" from `JOB_PIPELINE_PLAN.md` §4 that was never built. It is also the one genuinely scheduled Databricks job in the architecture. |
| **1 — retrieve** hard filters (US, fresh, `employment_type`, `work_authorization`, location) + skill overlap + vector similarity → top ~200 → top ~20 | **Databricks SQL** on the warehouse | The data is here. Moving 16k rows out to score them elsewhere is strictly worse. Zero tokens. |
| **2 — rerank** `ai_query('databricks-llama-4-maverick')` over **only the top ~20** → score + reason + per-requirement scores | **Databricks SQL** | No external key, no rate limit — the reason `CLAUDE.md` chose `ai_query` for bulk scoring. |
| **invoke** `GET/POST /api/match` | **Next.js on Databricks Apps** | `/api/match` is already a named fixture contract in `TASK_DIVISION.md` §4. Voice calls the same endpoint — hard rule 5. |

**Vector Search:** `vthacks-vs` is ONLINE with **0 indexes**. One Delta Sync index over
`job_embeddings` is cheap to create and is a judge-visible artifact for the Databricks
track. **Fallback if index creation stalls:** plain SQL cosine similarity over
`ARRAY<FLOAT>` — at 16k rows that is slower but perfectly workable, so the index is an
upgrade and not a dependency.

**Explicitly NOT:**
- **Not Vultr.** Vultr exists for one reason — ANS needs a public unauthenticated HTTPS
  endpoint for the employer agent. The matcher needs the data and the models, both of
  which are in Databricks.
- **Not Gemini for scoring, for now.** The key is provisioned but the project's Gemini
  prepaid credits are depleted (HTTP 402). `match_evaluations` already carries
  `model_provider` / `model_name`, so a Databricks-vs-Gemini A/B costs almost nothing
  *once credits exist* — keep the column, do not block on it.
- **Not MongoDB or TigerData.** Mongo holds raw JDs, TigerData holds the
  `application_events` time-series. Neither is a match store.

Sponsor framing that falls out of this for free: **Delta + AI Functions + Vector Search,
one platform, no external key.** It is also the cheapest option, which is the honest
reason to pick it.

---

## 4. The scoring shape

Stage 1 produces, per job, with **no model call**:

```
skills_matched   [...]   profile skills the JD explicitly asks for
skills_missing   [...]   JD requirements with no trace in the profile
courses_matched  [...]   coursework that covers a JD requirement
eligibility      pass | fail | unknown   (work_authorization, clearance, grad date)
similarity       0..1    cosine, description vs profile summary
```

Stage 2 turns the top ~20 into a `match_evaluations` row: `overall_score`,
`recommendation`, `explanation_text`, `requirement_scores_json`.

**Eligibility is a hard gate, not a score penalty.** A role requiring a clearance the
user does not hold, or refusing sponsorship they need, is not a 40% match — it is
**not a match**, and showing it as a weak one wastes their time and ours. It gets
filtered with a stated reason, never silently dropped.

### The coursework lever

`courses` exists and is barely used. Aggregating `skills_missing` across the user's
matched jobs answers *"take CS 3214 → +40% of postings open up"* — which is S2 in the
strategy doc's SHOULD list and a thing Deloitte's brief explicitly asks for. It is a
`GROUP BY` over data we already have, once stage 1 exists. **Cheap, and nothing else in
the build does it.**

---

## 5. Schema

`match_evaluations` needs no change. Additions:

```sql
-- One row per match run. Same role as scan_runs: observability, and the "is it
-- working?" answer. Without it a bad run is invisible.
CREATE TABLE workspace.vthacks_2026.match_runs (
  run_id           STRING NOT NULL,
  user_id          STRING NOT NULL,
  started_at       TIMESTAMP NOT NULL,
  finished_at      TIMESTAMP,
  candidates_total INT COMMENT 'Jobs considered before filtering',
  after_filters    INT,
  after_similarity INT,
  reranked         INT COMMENT 'How many model calls were actually spent',
  written          INT,
  dropped_ineligible INT,
  model_provider   STRING,
  model_name       STRING,
  error_message    STRING,
  CONSTRAINT match_runs_pk PRIMARY KEY (run_id)
) USING DELTA;

-- The zero-token stage-1 output, kept so a score can be explained without a model.
ALTER TABLE workspace.vthacks_2026.match_evaluations ADD COLUMNS (
  run_id          STRING,
  user_id         STRING COMMENT 'candidate_profile_id predates users; this is users.user_id',
  retrieval_rank  INT,
  similarity      DOUBLE,
  skills_matched  ARRAY<STRING>,
  skills_missing  ARRAY<STRING>,
  courses_matched ARRAY<STRING>,
  eligibility     STRING COMMENT 'pass | fail | unknown',
  eligibility_reason STRING
);
```

**`ADD COLUMNS IF NOT EXISTS` is a parse error on this warehouse** (found building the
job pipeline). `DESCRIBE TABLE` first — that ALTER is not idempotent.

---

## 6. Cost

- **Embedding 16,207 descriptions is the one real cost**, and it is one-time plus
  incremental. A single `ai_query` SQL statement over the table; warehouse time is the
  charge (~$2.80/hour awake). Expect single-digit minutes. Batch it, do not loop
  per-row.
- **Rerank is ~20 model calls per user.** Negligible.
- **Do not LLM 16k rows.** That is the whole reason for stage 1.
- The embeddings job on a schedule keeps the warehouse awake; the job-pipeline decision
  (hourly, not every 5 minutes) applies here for the same reason.

---

## 7. Limits to state, not hide

1. **`description_text` quality varies by ATS.** Some boards return full text, some a
   stub. A short description embeds poorly, so similarity is weaker for those — it is a
   property of the source, not a bug, and it should be visible rather than averaged away.
2. **Skill extraction is a vocabulary, not understanding.** `skill-extract.mjs` matches a
   canonical token list; a skill phrased unusually is missed. That is the trade for zero
   tokens and determinism, and it is why stage 2 exists.
3. **"Match" is a recommendation, never an action.** Hard rule 3 — nothing leaves and no
   PII moves without verification and human approval. The matcher writes rows; it does
   not apply.
4. **361 fresh US roles today, from 74 boards.** That is the honest denominator. It is
   not "all US jobs" and the pitch must not say so.
5. **No Gemini A/B yet** — 402. The column exists so the comparison is nearly free later.

---

## 8. Open questions for you

1. **Vector Search index, or plain SQL cosine first?** I would do cosine first (working
   in an hour, no new moving part) and add the index as the demo upgrade, since
   `vthacks-vs` sitting at 0 indexes is a visible sponsor gap.
2. **Match on demand, or precompute per user?** On demand is simpler and always current;
   precompute makes the dashboard instant. I lean on-demand with the result cached in
   `match_evaluations`, which is what that table is for.
3. **Is the coursework lever in scope for this agent, or a follow-up?** It is a `GROUP BY`
   once stage 1 lands, but it is a distinct deliverable and S2 rather than P0.

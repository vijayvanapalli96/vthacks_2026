# `scripts/scan` — the US job discovery pipeline

Every 5 minutes: find job postings on real employers' own boards and store each
posting **exactly once** in `workspace.vthacks_2026.job_snapshots`.

**Zero tokens.** No LLM, no Playwright, no scraping, no headless browser — just
each ATS's public JSON API, read through provider modules lifted from
`career-ops`. That property is what makes a 5-minute cadence affordable; please
do not break it.

Plan and rationale: [`docs/JOB_PIPELINE_PLAN.md`](../../docs/JOB_PIPELINE_PLAN.md).
Schema: [`sql/schema.sql`](../../sql/schema.sql) section 4.

---

## Run it

```bash
cd scripts/scan

npm run scan:us          # one tick against the live workspace (this is the cron command)
npm run scan:us:dry      # fetch + classify, write NOTHING
npm run boards:verify    # dry-run EVERY board in boards.json — how the seed list is checked
npm run boards:seed      # upsert boards.json into job_boards (safe to re-run)
npm test                 # unit tests: US filter + job_id. No network, no Databricks.
```

There are **no dependencies**. `package.json` exists only to hold those scripts
and to keep this scanner out of `app/vthacks-career-app` — the Next app must
never depend on it, and it never imports from the app.

Useful flags:

| Flag | Why |
|---|---|
| `--slice 20` | Override boards-per-tick for one run. |
| `--boards greenhouse:stripe,ashby:openai` | Pin an explicit set, bypassing the rotation. This is how you re-scan the *same* boards to prove idempotency. |
| `--all` | Every board in `boards.json` (pair with `--dry-run`). |
| `--json` | Machine-readable summary on stdout. |
| `--seed-boards` | Upsert `boards.json`; never resets rotation or health state. |
| `--reclassify` | Recompute `is_us` / `location_confidence` for rows already stored, after the location heuristic changes. Fetches nothing. Updates **only** those two derived columns — never `description_text` or `raw_payload_json`. |

Environment (all optional — the team workspace defaults are baked in):

```
DATABRICKS_HOST=https://dbc-0bfd7b56-c2eb.cloud.databricks.com
DATABRICKS_WAREHOUSE_ID=441b670a0ff475e0
DATABRICKS_CONFIG_PROFILE=TEAM          # used by the CLI-token auth path
DATABRICKS_CLI_PATH=...                 # only if `databricks` is not on PATH
DATABRICKS_CLIENT_ID= / DATABRICKS_CLIENT_SECRET=   # OAuth M2M — use these on a server
```

Auth resolution is `DATABRICKS_TOKEN` → OAuth M2M → `databricks auth token -p TEAM`,
the same order as `app/vthacks-career-app/src/lib/databricks.ts`. **PATs are
disabled on this workspace**, so locally it is always the CLI token, which means
`databricks auth login --host <host> --profile TEAM` must have been run once.

Two debug switches, both off by default:

- `HIREWIRE_SCAN_SKIP_FILE_LOCK=1` — skip the local lock layer so the Databricks
  lock is the thing being exercised.
- `HIREWIRE_SCAN_FORCE_MERGE=1` — skip the "which ids do we already hold?"
  pre-filter and send every posting to the MERGE. Proves the MERGE, not the
  pre-filter, is what makes a re-scan a no-op.

---

## What one tick does

```
take the tick lock ......................... or EXIT (never wait, never run anyway)
pick the slice ............................. 10 least-recently-scanned enabled boards,
                                             skipping any board in backoff
per board, in parallel (cap 6, Ashby 2)
  provider.fetch(entry, ctx) ............... one JSON request per board, zero tokens
  job_id = provider.dedupKey(job) ?? urlKey(job.url)
  classifyLocation() ....................... → is_us, location_confidence
  keep EVERYTHING ......................... nothing is discarded for being non-US or stale
de-duplicate by job_id IN MEMORY ........... a MERGE with a duplicate source key errors out
MERGE INTO job_snapshots WHEN NOT MATCHED THEN INSERT
UPDATE job_boards ......................... last_scanned_at, failures, backoff
SELECT count(*), count(DISTINCT job_id) .... the assertion
INSERT scan_runs .......................... counts, duration, error_message
release the lock
```

## The five things that make "stored exactly once" true

Unity Catalog `PRIMARY KEY` is **informational** and Delta enforces **nothing**.
There is no constraint that will reject a duplicate row, so uniqueness is
*produced* by this writer and then *verified*:

1. **A deterministic key.** `job_id = provider.dedupKey(job) ?? urlKey(job.url)`.
   The provider key wins where it exists — a Workday requisition id collapses one
   posting served under several sites of a tenant into one key, which a URL alone
   cannot do. `lib/url-key.mjs` **under**-normalises on purpose: two spellings of
   one posting is a visible duplicate you can fix, while merging two different
   postings is silent data loss.
2. **In-memory de-duplication before the write.** A MERGE whose source carries
   one key twice fails outright.
3. **`MERGE … WHEN NOT MATCHED THEN INSERT`, never a bare INSERT.**
   `description_text` and `raw_payload_json` are never rewritten once captured
   (CLAUDE.md hard rule 2). There is deliberately no `WHEN MATCHED` clause for
   `job_snapshots` anywhere in `lib/sink-databricks.mjs`.
4. **Exactly one writer** (`lib/lock.mjs`). Two concurrent MERGEs can each
   evaluate "not matched" for the same key and each insert — Delta's optimistic
   concurrency does not serialise them. A tick that cannot take the lock exits.
   Locks expire (10 min) so a crashed tick cannot wedge the pipeline.
5. **The assertion, every run.** `count(*)` vs `count(DISTINCT job_id)` goes into
   `scan_runs` on every tick; a divergence logs loudly and lands in
   `error_message`. An assertion that can fire is worth more than a constraint
   that is decorative.

## Store everything, filter at read time

US-ness and freshness are **columns**, not a discard:

| Column | Meaning |
|---|---|
| `is_us` | Verdict of `lib/location-us.mjs`. |
| `posted_at` | Publication time, `NULL` when the source exposes none. |
| `location_confidence` | `display` (the posting named a place we recognise) · `url_hint` (it said "5 Locations" and the Workday URL path supplied the place) · `unknown` (no geography was read — a bare "Remote", or an empty location; **audit these first**). |

"US roles open right now" is then a view:

```sql
SELECT * FROM workspace.vthacks_2026.open_us_jobs;   -- is_us AND posted_at >= now() - 3 days
```

A dropped row cannot be re-examined when the filter turns out to have been wrong,
and the US filter being subtly wrong is the most likely silent failure in this
lane. `scan_runs.postings_us / postings_fresh / postings_undated` are how you
tell "the filter is working" from "the filter is eating everything".

**This paid for itself within the hour.** The first full sweep stored 834
postings whose location was the bare string `"San Francisco"` and marked every one
of them **not US** — the lifted USPS table matches state names and abbreviations,
and a city with no state attached matches nothing in it. Nothing threw; the only
symptom was a suspiciously low `postings_us`. Because the rows were stored rather
than discarded, fixing the filter and running `--reclassify` corrected 1,559
verdicts in place. Had they been dropped at scan time, they would simply have
been gone. Query it yourself after changing the filter:

```sql
SELECT is_us, location_confidence, count(*) FROM workspace.vthacks_2026.job_snapshots GROUP BY 1, 2;
```

## Deploying the cron

`*/5 * * * *` on the Vultr box. **Untested — there is no VM provisioned yet**, so
treat this as the recipe, not a verified deployment:

```cron
*/5 * * * * cd /opt/hirewire/scripts/scan && /usr/bin/node scan-us-jobs.mjs >> /var/log/hirewire-scan.log 2>&1
```

On a server, set `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET` (OAuth M2M):
the CLI-token path needs an interactive `databricks auth login` and will not
survive unattended. Node 18+ is required (global `fetch`).

Overlap is safe by construction — a second tick exits on the lock — but if ticks
routinely overrun 5 minutes, lower `SLICE_SIZE` rather than lengthening the cron.

## Measured timings (2026-09-19, from real runs)

| | |
|---|---|
| All 74 boards, fetch only (`--dry-run --all`) | **30s**, 16,206 postings, 0 board failures |
| A 10-board tick, first capture (writes every row) | **51-144s**, dominated by MERGE round trips |
| A 10-board tick, steady state (nothing new) | **15-18s** |
| Warehouse cold start | adds 20-30s |

`SLICE_SIZE = 10` therefore fits a 5-minute cadence comfortably in steady state;
the long ticks happen only while a big board is being captured for the first time.

## Files

| File | |
|---|---|
| `scan-us-jobs.mjs` | The tick. Config constants at the top. |
| `boards.json` | 74 verified employer boards. Every one was fetched and confirmed to return postings before it was committed. |
| `lib/location-us.mjs` | US location filter, lifted from `career-ops/scan.mjs` and preconfigured for the United States. |
| `lib/url-key.mjs` | Lifted **verbatim** from `career-ops/url-key.mjs`. |
| `lib/providers/` | Lifted **verbatim** from `career-ops/providers/`: `ashby`, `greenhouse`, `lever`, `workday`, `icims` plus the `_`-prefixed helpers they import. |
| `lib/user-agent.mjs` | Lifted verbatim. Lives here because `providers/_http.mjs` imports `../user-agent.mjs`. |
| `lib/sink-databricks.mjs` | Every write, over the SQL Statement Execution API. |
| `lib/lock.mjs` | The single-writer tick lock. |
| `test/pipeline.test.mjs` | Unit tests for the US filter and `job_id`. |

### Lifted code

`lib/providers/**`, `lib/url-key.mjs` and `lib/user-agent.mjs` are copied from
**career-ops v1.33.0 — MIT, © 2026 Santiago Fernández de Valderrama**. Licence
text: `lib/LICENSE.career-ops`. Each file keeps its original header plus an
attribution block; the **only** change made to any of them was adding that
block. Do not edit them in place — re-copy from the donor repo. `career-ops` is a
sibling donor repo, never a dependency: do not `npm install` it, do not submodule
it, do not edit it.

`lib/location-us.mjs` is a partial lift (the filter engine and its comments, then
a HIREWIRE section holding the US preset and `classifyLocation`), because
importing `career-ops/scan.mjs` would drag in `portals.yml`, `js-yaml`, the
tracker and its lock files for ~200 lines of string matching.

## Known limits — say these out loud

1. **"Open right now" is a claim about the source, not a fact.** A role filled ten
   minutes ago still appears in the ATS API. What is true: *posted within 3 days
   and still listed on the employer's own board.* The stronger claim needs
   `career-ops/check-liveness.mjs`, which needs Playwright — out of scope.
2. **The US filter is a heuristic** over a display string and one URL path
   segment, plus a hand-written list of ~150 US cities. It gets "Dublin, OH"
   right and "Ontario, CA" (Canada) wrong, and a US city that is not on the list
   and carries no state falls through to `is_us = false`. Rows are never
   discarded, so a wrong verdict is re-examinable with `--reclassify` — that is
   the point of storing everything.
3. **A bare "Remote" is admitted** as US with `location_confidence = 'unknown'`.
   These are US employers' own boards, but no geography was actually read. 194 of
   16,206 rows currently sit in that pile ("Remote", "Remote, Global",
   "Remote, AMER"), and they are the first thing to audit if the numbers look
   wrong.
4. **`boards.json` is a curated list of 74 employers**, not "all US jobs". The
   pitch must not say otherwise.
5. **`raw_payload_json` is the provider-*normalised* posting minus its body**, not
   the ATS's original bytes — the body has its own column, and storing it twice
   doubles every write. Bodies are capped at 60,000 characters, which no posting
   seen so far comes close to.

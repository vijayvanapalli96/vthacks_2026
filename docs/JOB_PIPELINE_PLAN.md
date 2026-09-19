# Job discovery pipeline — plan for review

**Status: PROPOSED. Nothing built. Awaiting Tarang's review before an agent starts.**

Goal: every 5 minutes, find job postings that are **open now** and **in the US**, and
store each posting exactly once in `workspace.vthacks_2026.job_snapshots`.

## Decisions taken (2026-09-19)

| Question | Answer |
|---|---|
| Where it runs | **Vultr cron** for the Node scanner + a separate **Databricks Job** for embeddings. Plus `npm run scan:us` locally so the demo never depends on the VM. |
| Cadence | **Rotating slice** — tick every 5 min, scan the ~10 least-recently-scanned boards. |
| Filter scope | **US + fresh only** — no title narrowing. |
| Freshness | **3 days** (career-ops default). Postings with no date are still excluded from "fresh". |
| Storage | **Store every posting fetched.** US and freshness are *columns*, not a discard. |
| Uniqueness | **Construct + verify in Delta**, not a second store. `dedupKey() ?? urlKey(url)`, MERGE-only writes, a tick lock so there is exactly one writer, and a `count(*)` vs `count(DISTINCT job_id)` assertion recorded every run. See §3.1. |

### Store everything, filter at read time

Earlier drafts dropped non-US and undated postings and only counted them. That is
worse: a dropped row cannot be re-examined when the filter turns out to be wrong, and
the US filter being subtly wrong is the most likely silent failure here (§6.3).

So every fetched posting is stored, carrying `is_us`, `posted_at` and
`location_confidence`. "US roles open right now" becomes a `WHERE` clause and a view.
The `dropped_*` counters in `scan_runs` are replaced by `postings_us` /
`postings_fresh` / `postings_undated`, which describe what we *have* rather than what
we threw away.

Modelled on how `career-ops` already does this. Read that first — it has solved most
of these problems already and the solutions are not obvious.

---

## 1. How career-ops does it (what we are copying)

Two scanners, same provider modules:

| | `scan.mjs` | `scan-ats-full.mjs` |
|---|---|---|
| Direction | boards you curated in `portals.yml` | walks public per-ATS company directories |
| Company list | hand-maintained | a public aggregator dataset, cached 24 h |
| Freshness | no date filter | `--since N` days, **skips postings with no date** |

Both are **zero-LLM**: pure HTTP + JSON against each ATS's public API. No scraping, no
headless browser, no tokens. That is the property to preserve — it is what makes a
5-minute cadence affordable at all.

The pieces worth lifting, and why each one is not something to re-derive:

| Lift | From | Why |
|---|---|---|
| Provider modules | `providers/{ashby,greenhouse,lever,workday,icims}.mjs` + `_http.mjs`, `_dns-cache.mjs`, `_ip-guard.mjs`, `_safe-url.mjs`, `_html-to-text.mjs` | 99 ATS readers, already normalising to one `Job` shape. Plain Node ESM — **runs unmodified**, no port cost. |
| US location filter | `buildLocationFilter` / `locationHintFromUrl` in `scan.mjs` | 50 states + USPS abbreviations, a 4-tier allow/block/block_hard ladder, and a URL-path fallback for boards that display "5 Locations" instead of a city. Naively filtering on `"United States"` drops "Dublin, OH". |
| Stable job identity | `url-key.mjs` | Deliberately **under**-normalises: collapsing two different postings is a silent merge, leaving two spellings of one posting is a visible duplicate. Keeps `gh_jid` because on some boards it *is* the posting id. |
| Board health backoff | `dead-boards.mjs` | Boards break. Without this we re-hit dead boards every 5 minutes forever. |

Provider contract (`providers/_types.js`) — the unit of currency:

```
Job = { title, url, company, location, description?, postedAt?, salary?, ... }
```

`postedAt` is optional, and **`scan-ats-full.mjs` drops postings that lack it**. We
want the same rule: without a date we cannot claim "open right now".

---

## 2. Two things about "every 5 minutes" I want to flag before building

**a) Hitting every board every 5 minutes will get us rate-limited.**
80 boards × 12 ticks/hour ≈ 960 requests/hour to a handful of hosts. career-ops has a
comment block about Ashby specifically: a ~10 s server-side latency floor and
rate-limiting on repeated unauthenticated hits, which is why it gets a 30 s timeout
and a backoff+jitter retry. Ashby alone would make a full 80-board sweep exceed the
5-minute budget.

**Proposal:** the *tick* is every 5 minutes; each tick scans a **rotating slice** of
boards (ordered by least-recently-scanned), sized to finish inside ~90 s. With 80
boards and a slice of 10, every board is revisited about every 40 minutes, and the
pipeline shows fresh rows every 5 minutes. Slice size is one config value, so if the
demo wants faster we turn it up knowing what it costs.

If you want literally-every-board-every-5-minutes, say so and I will build that — but
it should be a decision, not a surprise on stage.

**b) Databricks Jobs cannot run Node.**
Task types are notebook / Python / SQL / JAR / dbt. The lifted providers are `.mjs`.
So either we port providers to Python (expensive, and throws away the main lift) or we
run the scanner as Node somewhere else. See §4.

---

## 3. What gets built

```
scripts/scan/
  scan-us-jobs.mjs        entrypoint: one tick
  boards.json             the seed list (slug + provider + company)
  lib/location-us.mjs     LIFTED filter, US preset, attribution header
  lib/url-key.mjs         LIFTED verbatim
  lib/providers/          LIFTED verbatim
  lib/sink-databricks.mjs MERGE into job_snapshots via the SQL Statement Execution API
sql/schema.sql            + scan_runs, + job_boards   (Section 5)
```

One tick:

```
pick slice (least-recently-scanned, skip backed-off boards)
  └ per board, in parallel with a concurrency cap
      fetch via provider          zero tokens
      classify, never discard:    is_us + location_confidence, posted_at
      job_id = dedupKey(job) ?? urlKey(url)
      de-duplicate by job_id IN MEMORY (a MERGE with duplicate source keys errors)
  └ MERGE INTO job_snapshots ... WHEN NOT MATCHED THEN INSERT
  └ UPDATE job_boards health/backoff
  └ INSERT scan_runs row (counts, duration, failures, the uniqueness assertion)
```

**Write-once is enforced by the MERGE, per hard rule 2.** `description_text` and
`raw_payload_json` are never rewritten once captured. A re-scan of an unchanged
posting is a no-op, which is exactly what makes a 5-minute cadence safe.

### 3.1 "Truly unique" — what is actually achievable

**Unity Catalog `PRIMARY KEY` and `UNIQUE` are informational. Delta does not enforce
them.** There is no constraint we can put on `job_snapshots` that will reject a
duplicate row. So uniqueness has to be *produced* by the writer, and then *verified*,
rather than delegated to the database. Four parts, all needed:

**1. A deterministic key from the URL.** `job_id = dedupKey(job) ?? urlKey(job.url)`.

`url-key.mjs` lowercases the host, forces https, strips a denylist of tracking params
(`utm_*`, `gh_src`, `fbclid`, …), drops non-identity fragments and a trailing slash,
and sorts the remaining query. It deliberately **keeps** functional params like
`gh_jid`, because on some corporate-hosted Greenhouse boards that *is* the posting id.
It under-normalises on purpose: over-normalising collapses two different postings into
one key, which is silent data loss, while under-normalising leaves two spellings of one
posting as two rows, which is a duplicate you can see and fix.

Prefer the provider's own `dedupKey()` where it exists — Workday exposes a requisition
id, so the same posting served under several sites of one tenant collapses to one key.
URL alone cannot do that. This is strictly better than "the URL is the id".

**2. `MERGE INTO … WHEN NOT MATCHED THEN INSERT`, never a bare `INSERT`.** Within a
single statement Delta will not insert a key that already matches.

**3. A single writer.** This is the part that is easy to miss. Two concurrent MERGEs
against the same table can both evaluate "not matched" for the same key and both
insert — Delta's optimistic concurrency does not serialise them. With a 5-minute cron
and ticks that can run ~90 s, an overrun means two ticks overlap. So:
- the source rows are de-duplicated by key *in memory* before the MERGE, so one
  statement never carries the same key twice (a MERGE with duplicate source keys
  errors out anyway);
- a lock row guards the tick, and a tick that cannot take the lock exits rather than
  running alongside another (career-ops has `pipeline-lock.mjs` for exactly this).

**4. Verify it, every run.** Each tick ends with:

```sql
SELECT count(*) AS rows, count(DISTINCT job_id) AS keys
FROM workspace.vthacks_2026.job_snapshots
```

and writes both into `scan_runs`. If they ever diverge we know on the next tick
instead of finding out from a judge looking at a duplicated job list. An assertion
that can fire is worth more than a constraint that is decorative.

**If you want the database itself to reject duplicates, that means Postgres.**
TigerData is already in the stack; a `jobs(job_id TEXT PRIMARY KEY, url TEXT UNIQUE)`
table there would give real enforcement, with Delta holding the analytics copy. It is
more moving parts on the hot path, and the four measures above get us to "one row per
posting, and we can prove it" without them — but the honest framing is *enforced by
our writer and verified every run*, not *enforced by the database*.

### New tables

```sql
-- job_boards — the seed list AND its health. Scheduling state lives with the
-- thing being scheduled, so a restart does not lose the rotation.
CREATE TABLE workspace.vthacks_2026.job_boards (
  board_id STRING NOT NULL, provider STRING NOT NULL, company_name STRING,
  board_slug STRING, api_url STRING, careers_url STRING,
  country_hint STRING, enabled BOOLEAN,
  last_scanned_at TIMESTAMP, last_ok_at TIMESTAMP,
  consecutive_failures INT, backoff_until TIMESTAMP,
  CONSTRAINT job_boards_pk PRIMARY KEY (board_id)
) USING DELTA;

-- scan_runs — one row per tick. This is the observability story, the
-- "is the pipeline alive?" answer on the dashboard, AND the uniqueness assertion.
CREATE TABLE workspace.vthacks_2026.scan_runs (
  run_id STRING NOT NULL, started_at TIMESTAMP NOT NULL, finished_at TIMESTAMP,
  boards_attempted INT, boards_ok INT, boards_failed INT,
  postings_seen INT, postings_new INT,
  postings_us INT, postings_fresh INT, postings_undated INT,
  -- The assertion from §3.1. These two must be equal on every run.
  total_rows BIGINT, distinct_job_ids BIGINT,
  error_message STRING,
  CONSTRAINT scan_runs_pk PRIMARY KEY (run_id)
) USING DELTA;
```

`postings_us` / `postings_fresh` / `postings_undated` matter more than they look: they
are how we tell "the US filter is working" from "the US filter is eating everything",
which is the single most likely silent failure here. Because we now store every
posting, these describe what we *have* and stay queryable after the fact — a counter of
discarded rows could only ever be taken on trust.

`job_snapshots` gains three columns so the filter is a query rather than a discard:
`is_us BOOLEAN`, `location_confidence STRING` ('display' | 'url_hint' | 'unknown'),
and the existing `discovered_at` / a new `posted_at TIMESTAMP`. The US + fresh view:

```sql
CREATE OR REPLACE VIEW workspace.vthacks_2026.open_us_jobs AS
SELECT * FROM workspace.vthacks_2026.job_snapshots
WHERE is_us AND posted_at >= current_timestamp() - INTERVAL 3 DAYS;
```

---

## 4. Where it runs — needs your call

| | Option A — Vultr cron **(recommended)** | Option B — Databricks Job | Option C — local only |
|---|---|---|---|
| How | `*/5 * * * *` → `node scan-us-jobs.mjs` | Python task on a 5-min schedule | `npm run scan:us` by hand |
| Node providers | run unmodified | **must be ported to Python** | run unmodified |
| Sponsor story | weak for Vultr (it is just a VM) | strong ("Lakeflow schedule") | none |
| Cost to build | low | high | ~zero |
| Risk | VM must stay up | port bugs, hours gone | nothing runs during judging |

**Recommendation: A, plus a thin B.** Vultr is already in the stack for ANS and the
box is already there. Run the Node scanner there on cron. Then add a *separate*
Databricks Job on its own 5-minute schedule that does the part Databricks is actually
better at: `ai_query('databricks-gte-large-en')` over `job_snapshots` rows that have
no row in `job_embeddings` yet. That gets a real scheduled Databricks job in the
architecture without porting a single provider, and the embeddings are what the match
agent needs anyway.

Also build the `npm run scan:us` path regardless, so the demo never depends on the VM
being reachable.

---

## 5. Scope — deliberately out

- No LLM anywhere in the scan. Zero tokens. Scoring and matching are a separate lane.
- No Playwright, no scraping. Public JSON APIs only — consistent with the existing
  out-of-scope list, and the reason this is defensible rather than fragile.
- No Workday-style per-job detail fetches on the 5-minute path; the list payload is
  what we get for free.
- We do NOT touch `portals.yml`, the tracker, or `pipeline.md`. career-ops is a donor
  repo: we copy files with their attribution headers and never edit it in place.

## 6. Honest limits to state out loud

1. **"Open right now" is a claim about the source, not a fact.** A posting that was
   filled ten minutes ago still appears in the ATS API. We can say "posted within N
   days and still listed on the employer's own board", which is true. career-ops has a
   whole `check-liveness.mjs` for the stronger claim, and it needs Playwright — out of
   scope.
2. **Postings with no date are dropped**, so some genuinely-open US roles are missed.
   That is the right trade for a freshness claim, and the count goes in `scan_runs`.
3. **The US filter is heuristic.** It reads a display string and a URL path segment.
   "Remote" with no country attached is ambiguous; career-ops resolves it last and
   never lets a remote title rescue a blocked location. We inherit both behaviours.
4. **The seed board list is curated by us**, ~40-80 known US employers. It is not "all
   US jobs" and the pitch should not say it is.

---

## 7. Still open

1. **The seed board list.** ~40-80 known US employers on Greenhouse / Ashby / Lever.
   Any companies you specifically want in it? Absent an answer I would pick employers
   that actually hire VT new grads, so the demo matches the applicant persona without
   needing a title filter to fake it.
2. **Who owns the Vultr box and is it up?** The scanner is useless on a VM nobody has
   provisioned. `npm run scan:us` is the fallback and does not depend on it, but the
   "runs every 5 minutes" claim does.
3. **Tick budget.** Slice of 10 boards is a guess at ~90 s. The first real run tells us
   the true number and the slice size should be set from that, not from this document.

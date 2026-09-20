# Application pipeline — plan

A page that tracks every job through **saved → applied → interviewing → offer /
rejected**, where the user marks the status themselves.

**Branch** `feat/pipeline` from `main` @ `862b85a`. **Worktree** `../vthacks-pipeline`.
**Port 3005** — 3000 is `main`'s dev server, 3001/3002 other worktrees, 3003 the match-UI
agent, 3004 the voice-actions agent. Google OAuth is registered for port 3000 only, so
sign in with **email/password**.

---

## What already exists — measured, not assumed

| Thing | State |
|---|---|
| `application_events` | **EXISTS and is completely empty. Nothing in the codebase writes to it.** Columns: `event_id`, `application_id`, `job_id`, `event_type`, `event_source`, `event_at`, `metadata_json`. |
| documented `event_type` vocabulary | `viewed \| tailored \| verified \| refused \| submitted \| callback \| rejected` |
| `applications` table | **does not exist** |
| `latest_application_state` view | **DOES NOT EXIST.** `CLAUDE.md` claims the schema "already exists with … the `latest_application_state` view". That is wrong. Only `profile_current` and `open_us_jobs` views exist. **Correct `CLAUDE.md` in your PR.** |
| `/applicant/activity` | Already taken, and it is **not** this. It is the ANS decision audit trail, read from MongoDB via `src/lib/audit.ts`. Leave it alone. |
| TigerData | In `CLAUDE.md`'s stack list, **not wired to anything**. Do not start it. Databricks only; say so as a stated gap. |
| `saved_jobs` | Does not exist and **must not be created** — see §1. |

So: the table this feature needs already exists, has no rows, and has no writers. You are
its first producer. Nothing to migrate.

---

## 1. The design: event-sourced, not a status column

`application_events` is an **append-only event log**, and current state is a **view** over
it. This is not a stylistic choice — it is the same shape as `profile_memory` +
`profile_current`, which is the house pattern, and `CLAUDE.md` already promises a view
called `latest_application_state`. You are making a documented-but-missing object real.

**Changing a status APPENDS an event. Never UPDATE, never DELETE.** Consequences, all good:

- Undo is just another event.
- "Applied 6 days ago, still no answer" is free — it is `event_at` arithmetic.
- The history *is* the audit trail, which is this product's entire thesis.

**This is also why there is no `saved_jobs` table.** "Saved" is the first stage of the
pipeline, not a separate concept. A second store for the same fact is worse than a
missing feature. The voice-actions agent has been told to call your endpoint rather than
build one.

## 2. Status vocabulary — reconciled, not replaced

The user asked for *saved, applied, interviewing, rejected, success*. The schema already
documents a machine vocabulary. Keep both; do not throw away the existing words.

| Stage (user-facing) | `event_type` | Note |
|---|---|---|
| Saved | `saved` | **new** |
| Applied | `applied` | **new** as a user action. The existing `submitted` is what the A2A apply path emits; treat `submitted` as implying Applied. |
| Interviewing | `interviewing` | **new**. The existing `callback` implies it. |
| Offer | `offer` | **new** |
| Accepted | `accepted` | **new** |
| Rejected | `rejected` | exists |
| Withdrawn | `withdrawn` | **new** |

**"Success" is two stages, not one.** An offer you declined is not a success, and
collapsing them would overstate the outcome — an offer is the employer's decision,
acceptance is the user's. Show both.

`viewed` / `tailored` / `verified` / `refused` stay valid and are **not** pipeline stages —
they are activity on a job. Do not render them as columns; they can appear in a job's
history timeline.

`event_type` is a `STRING` column, so widening the vocabulary needs **no DDL**. It does
need a **validated whitelist in code** — an exhaustive `switch`/const array, so an
unknown status is a 400 and not a silently-written junk row. Mirror the `FIELDS`
whitelist idiom in `src/lib/voice.ts`.

## 3. Schema changes

Exactly two, both additive.

```sql
-- application_events has no user_id, and the pipeline is per-user. DESCRIBE TABLE
-- FIRST: `ADD COLUMNS IF NOT EXISTS` is a PARSE ERROR on this warehouse, so this
-- ALTER is not idempotent and will fail on a second run.
ALTER TABLE workspace.vthacks_2026.application_events ADD COLUMNS (
  user_id STRING COMMENT 'users.user_id — the pipeline is per-user',
  note    STRING COMMENT 'the user'"'"'s own words about this stage'
);

-- The view CLAUDE.md already names. Latest event per (user_id, job_id).
CREATE OR REPLACE VIEW workspace.vthacks_2026.latest_application_state AS ...
```

The view must resolve **one current stage per (user_id, job_id)**, ranked by `event_at`
then `event_id` as a deterministic tiebreak — two events in the same second are likely
(a click and a voice tool firing together) and a non-deterministic view would make the
board flicker between renders.

Append to `sql/schema.sql` as a **new SECTION 8**. Do not modify sections 1–7: the match
agent's PR was reviewable precisely because its schema diff had **zero removed lines**.
Match that standard.

Unity Catalog `PRIMARY KEY` / `UNIQUE` are **informational only — Delta does not enforce
uniqueness.** Never rely on a constraint for dedupe.

## 4. The endpoint — contract shared with the voice agent

Write this exactly; another agent is building against it.

```
POST /api/pipeline/status
  { job_id: string, status: PipelineStatus, note?: string, source: 'voice' | 'ui' }
  -> { ok: true, job_id, status, previous_status: string | null, at: ISO8601 }
  -> 400 on an unknown status, with the valid list in the message
  -> 404 if job_id is not a real job_snapshots row

GET /api/pipeline
  -> { stages: { saved: Card[], applied: Card[], interviewing: Card[],
                 offer: Card[], accepted: Card[], rejected: Card[], withdrawn: Card[] },
       counts: Record<PipelineStatus, number> }
```

- `job_id` is validated against `job_snapshots` — **never trust a client-supplied id**,
  and the voice agent's model can hallucinate one.
- `previous_status` in the response is what lets a caller say "moved from applied to
  interviewing" in one sentence instead of guessing.
- Every value bound as a **named SQL parameter**. `note` is free text from a human or a
  transcript and must never be interpolated.
- Hard rule 5: this is the one write path. The page's buttons and the voice tool both
  call it. No parallel implementation.

## 5. The page

`/applicant/pipeline`, plus a nav entry in `src/components/ApplicantNav.tsx` (you own that
file — the other two agents were told not to touch it).

A board with a column per stage. Each card: title · company · **match % and the reason
sentence when one exists** · how long it has been in this stage · the status control.

Read the match score via `readCachedRun(sql, userId)` — **already exported** from
`src/lib/match/run.mjs`. Do not write a second reader and do not wait on the match-UI
agent's files.

**Accessibility decides the interaction model here, so decide it up front.** Hard rule 6
and the product's whole thesis.

- The status control is a **real `<select>` or a labelled button group** — keyboard
  reachable, correct tab order, visible focus, announced on change via `aria-live`.
- **Drag-and-drop is optional and must never be the only way.** If you build it, it is an
  enhancement layered on a control that already works without a pointer. If time is
  short, **skip the drag** — a keyboard-only board is a complete feature; a
  mouse-only board is a rule-6 violation.
- Do not convey a stage by colour alone.
- Empty state says what to do, not "no data".

Free and worth having, because event-sourcing gives it for nothing: a **"7 days in
Applied, no response"** line, and a small funnel of the counts. That is the Deloitte-brief
kind of insight and it is a `GROUP BY`.

## 6. Verify with numbers

- A real signed-in browser. Mark a job through every stage and read the rows back out of
  `application_events`, confirming you **appended** and never updated.
- Prove the view: after three status changes on one job there are **3 events and 1 view
  row**.
- Confirm the keyboard path end to end with no mouse: tab to a card, change its status,
  hear/see it announced.
- Report the counts and the wall clock for `GET /api/pipeline`.

---

## Constraints

**Files other agents own right now — do not touch.**
- `feat/match-ui`: `IntakeProgress.tsx`, `src/app/applicant/page.tsx`,
  `src/app/applicant/jobs/page.tsx`, `src/components/MatchList.tsx`,
  `src/lib/match-read.ts`, `src/lib/databricks.ts`.
- `feat/voice-actions`: `src/components/voice/*`, `src/lib/voice.ts`,
  `src/lib/voice-contract.ts`, `src/app/api/voice/*`,
  `scripts/provision-voice-agent.mjs`.

You own: `sql/schema.sql`, `src/app/api/pipeline/*`,
`src/app/applicant/pipeline/*`, `src/components/ApplicantNav.tsx`, and any new
`src/lib/pipeline.ts`.

- **Never `git add -A`** — conflict markers were committed into `.env.example` that way
  once. Stage named paths.
- **Never commit to `main`.** Branch → PR. Merge `origin/main` before opening it; two
  other branches are landing today.
- `npm install` first — a fresh worktree has no `node_modules`.
  `.env.local` is already copied in. **Never `cat` it or echo a value from it.**
- `npm run typecheck && npm run lint && npm run build` must pass before the PR.
  `eslint.config.mjs` enforces React-compiler rules as **errors**.
- **`tarangnair98@gmail.com` / `3027b072-2f8c-4960-b3c3-33f63569b50a` is the human's live
  account. Never DELETE or UPDATE its rows.** Appending pipeline events for it is fine and
  is the realistic demo; clean up any events you create under a *test* account, and assert
  the live user id is absent from any delete set before any `DELETE`.
- `profile_memory` append-only. `job_snapshots` write-once — `description_text` and
  `raw_payload_json` must never appear in a `SET` list.
- BOOLEAN columns come back from the Statement Execution API as the **strings**
  `"true"`/`"false"`. A truthiness check inverts the logic.
- A correlated scalar subquery cannot sit alongside a `GROUP BY`
  (`SCALAR_SUBQUERY_IS_IN_GROUP_BY_OR_AGGREGATE_FUNCTION`) — split the statement.
- `databricks api post /api/2.0/sql/statements --json @file -p TEAM` is **broken** on CLI
  v1.17.0 (`Error: Not Found`) despite `CLAUDE.md`. Use `scripts/lib/dbsql.mjs` or the
  REST API with `databricks auth token -p TEAM`.
- The warehouse cold-starts in 20–30 s.
- Hard rule 7, real content only: real companies from real scraped JDs. No "Acme Corp".
- Hard rule 8: a named gap beats a caught exaggeration. TigerData is unwired — say so.

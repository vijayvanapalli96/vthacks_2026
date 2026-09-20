# Match in the product — plan

Wire the match agent into the app: run it when intake finishes, show the percentage,
and re-filter it when the voice agent learns something that changes who is eligible.

**Branch** `feat/match-ui` from `main` @ `862b85a`. **Worktree** `../vthacks-matchui`.
**Port 3003** — 3000 is the dev server on `main`, 3001/3002 are other worktrees.

---

## DESCOPE — step 4 moved to the voice lane (2026-09-20)

**Step 4 ("re-filter after the voice agent learns something") is no longer in this
plan.** A second agent owns the entire voice surface, including the re-match trigger,
and two branches both rewriting `VoiceAgent.tsx` — the most stateful client component
in the app — is a merge conflict this project cannot afford hours from ship.

Delivered here: **steps 1, 2, 3 and 5.** Not touched by this branch:
`src/components/voice/*`, `src/lib/voice.ts`, `src/lib/voice-contract.ts`,
`src/app/api/voice/*`, `scripts/provision-voice-agent.mjs`.

The seam the voice lane needs is `readMatches(userId)` in `src/lib/match-read.ts`: one
exported function, cached-run only, zero model calls, deliberately NOT inlined into a
page component so the voice lane can import it to answer "why am I a good match for
this role".

Two consequences for step 3, stated because they are visible in the UI:

* `'job_matched'` is still an unreached `VOICE_ACTION_KINDS` member. This branch does
  not reach it; the voice lane does.
* `filtered_ineligible` comes back only on a FRESH run — `readCachedRun()` returns it
  empty, because the eligibility rejects are not persisted. So the dashboard's
  "N roles removed — why" disclosure shows the stored COUNT
  (`match_runs.dropped_ineligible`) plus what the gate does, and `MatchList` takes an
  optional `removed` prop so whoever holds a fresh response can pass the per-role
  sentences in. Claiming the reasons were on hand when they were not would be the
  exact dishonesty the disclosure exists to prevent.

---

## What already exists — do not rebuild any of this

| Thing | Where | Note |
|---|---|---|
| `GET`/`POST /api/match` | `src/app/api/match/route.ts` | Returns `{ matches, run, filtered_ineligible }`. `maxDuration = 300`. |
| `score` is **already 0–100** | `rerank.mjs:169` clamps it | **Do not multiply by 100.** It is the percentage, directly. |
| `similarity` is 0–1 cosine | `retrieve.mjs` | A *different number*. Never render it as the match percentage. |
| 45-minute result cache | `run.mjs` `CACHE_TTL_MINUTES = 45`, `readCachedRun()` | A server component can render the last run for **zero model calls**. |
| Sponsorship gate | `eligibility.mjs` `needsSponsorship()` | Reads `goals.sponsorship_required` **and** `work_authorization` text. |
| The removed-roles list | `filtered_ineligible[]` → `{ job_id, company, title, reason }` | Already carries the reason. This is the honest version of "only sponsoring jobs". |
| `'job_matched'` action kind | `voice-contract.ts` `VOICE_ACTION_KINDS` | Declared, deliberately unreached. **This feature is what reaches it.** |
| Intake completion event | `intake.ts:1552` yields `{ type:'complete', factsAppended, openGaps, next:'/applicant' }` | `IntakeProgress.tsx:129` already handles it. |

`goals.sponsorship_required` comes back from the Statement Execution API as the
**string** `"true"`, not a boolean. `needsSponsorship()` already handles both. Do not
"fix" it into a truthiness check — that inverts the logic.

---

## Step 1 — Prove the HTTP call survives, BEFORE touching any UI

`/api/match` has never once been called over HTTP. This is the real risk and it is
first for that reason.

`src/lib/databricks.ts` has `POLL_LIMIT_MS = 90_000` **per statement**, not per run. A
run is ~36 s warm, plus a 20–30 s cold start on the first statement, plus 21 model
calls. Whether that fits is unmeasured.

Do this:

1. Sign in as a real applicant in a browser, copy the session cookie.
2. Cold warehouse (don't pre-warm — the first call of the day is the case that breaks).
3. `curl` `POST /api/match` with that cookie. **Record the wall clock and the status.**
4. Warm second call. Record again.

If it 502s, fix it **here**, in the API lane, not by adding retries in the UI:

- Warm the warehouse first — `/api/voice/session` already does exactly this in a
  `Promise.all`; copy the pattern.
- Only if still needed, raise `POLL_LIMIT_MS`. Say so explicitly in the PR, because it
  is a shared file every lane uses.

**Report the actual numbers.** "It works" is not the deliverable; the timings are.

## Step 2 — Run the match when intake finishes

Server: no change. Client, in `IntakeProgress.tsx`, on the `complete` event:

- `POST /api/match` with an **empty body** — no `refresh`, so the 45-minute cache makes
  a double-fire cost zero model calls.
- Give it **its own line in the existing live log** ("Matching you against ~358 fresh US
  roles…" → settles to "14 matches, top score 78%"). The intake page is already a
  narrated log; a silent 40-second spinner after it says it's done is worse than a line.
- Do **not** block the existing "See my profile" / refresh buttons on it.
- On failure: one honest sentence in the log, rest of the page still works. **Never
  render "no matches" when the truth is "the run failed."**

`complete.next` is `/applicant`, so by the time the user lands there the run is cached
and the dashboard renders instantly.

## Step 3 — Show the percentage

New: `src/lib/match-read.ts` (thin `readCachedRun(sql, user.id)` wrapper, server-only)
and `src/components/MatchList.tsx`.

- `/applicant` "MATCH QUEUE" panel: render matches when a cached run exists; fall back to
  the current `listJobs(3)` posting list when it doesn't (a brand-new user, pre-first-run).
  **Keep `DEMO_JOB` and keep it labelled as the demo** — it is the ANS verification path.
- `/applicant/jobs`: the full ranked list, same component.
- Each row: title · company · **`score`% match** · the `reason` sentence · `matched_skills`
  / `missing_skills` chips · `recommendation` · location · posted date · source link.
- **The number never appears without the sentence.** Hard rule 4: a score without a
  reason is a bug, and `reason` is already guaranteed non-empty by `validateEvaluation()`.
- A11y: percentage not conveyed by colour alone. Labelled bar with
  `aria-valuenow/valuemin/valuemax` (or `role="meter"`) and the digits in text. 4.5:1.
- Small print from `run`: `wall_clock_seconds`, `reranked` (= model calls actually spent),
  `candidates_total`. Free observability, and the judges came for exactly this.
- Denominator honesty: it is ~358 fresh US roles from 74 boards, **not "all US jobs"**
  (hard rule 8). Say which.

## Step 4 — Re-filter after the voice agent learns something

In `VoiceAgent.tsx`, after a successful `record_answer` whose `fieldKey` is one of the
**match-gating** set — `sponsorship`, `work_authorization`, `target_role`,
`work_location_pref`, `employment_type`, `comp_floor`:

- `POST /api/match { refresh: true }`. **`refresh` is mandatory here** — the 45-minute
  cache would otherwise serve pre-sponsorship results, which looks identical to the
  filter silently not working.
- Push a `job_matched` transcript action with the real counts: *"Re-matched: 14 roles.
  6 removed because those employers say they don't sponsor."*
- Then `router.refresh()` so the panel re-renders from the new cached run.
- **Debounce to one in flight.** A user answering three questions in twenty seconds must
  not spend 63 model calls.
- The removed roles go in a collapsed "6 roles removed — why" disclosure reading from
  `filtered_ineligible`. A filter that hides is a disappearance; a filter that says why
  is a filter.

## Step 5 — Verify with numbers, not a typecheck

- Real signed-in browser. Cold and warm timings for both the post-intake run and the
  voice-triggered re-run.
- Before/after counts for the sponsorship narrowing, and how many `filtered_ineligible`
  rows came back with a sponsorship reason specifically.
- `tarangnair98@gmail.com` (`3027b072-2f8c-4960-b3c3-33f63569b50a`) is the human's live
  account. A match run only INSERTs into `match_runs` / `match_evaluations`, which is
  fine. **Its `goals` row is the only one in the table — do not UPDATE or DELETE it.**
  For the sponsorship before/after use a second account or the `goalsOverride` CLI path,
  and state in the PR which one you used.

---

## Decided, not open

**`/applicant` does not auto-run a match on every visit.** With no cached run it shows
the posting list and a "run a match" button. Auto-running would mean a 40-second page
load and 21 model calls for anyone who merely opens the dashboard. The automatic run is
the post-intake one, once.

## Constraints that have already cost this project time

- **Never `git add -A`.** Conflict markers got committed into `.env.example` that way.
  Stage named paths.
- `.env.local` is gitignored and per-worktree. It is already copied here. **Never `cat`
  it, never echo a value, never commit it.**
- Do not rename the seven contract keys of `/api/match` (`job_id`, `company`, `title`,
  `score`, `matched_skills`, `missing_skills`, `reason`).
- `profile_memory` is append-only. `job_snapshots` is write-once.
- `npm run typecheck && npm run lint && npm run build` before the PR. Branch → PR, never
  a direct commit to `main`.
- `node --test tests/match/match.test.mjs` (the **file**, not the directory — the
  directory form fails on Node v25).
- **Do not claim the voice path works end to end.** No real microphone conversation has
  ever happened. Step 4 can be verified through the typed fallback, which posts to the
  same endpoint; say that it was the typed path.

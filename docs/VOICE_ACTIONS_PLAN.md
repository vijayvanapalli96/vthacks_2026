# The voice agent takes actions — plan

Today the agent is a **question-asker**: one tool, `record_answer`, and a transcript of
things *said*. This turns it into an **actor**: it knows what page you are on, it does
things for you through the same endpoints your buttons use, and the transcript becomes a
log of things *done*.

**Branch** `feat/voice-actions` from `main` @ `862b85a`. **Worktree** `../vthacks-voice`.
**Port 3004** — 3000 is `main`'s dev server, 3001/3002 other worktrees, 3003 the match-UI
agent. Google OAuth is registered for port 3000 only, so sign in with **email/password**.

---

## The governing rule

**Hard rule 5: voice and UI call the same endpoints. No parallel code path for voice.**

Every action below is an HTTP endpoint that a *button* also calls. If an action has no
button, build the button. A voice-only capability is a rule-5 violation and it is also
bad product: "everything you can say, you can type" has to be true at the API layer.

## Verified available before planning — not assumptions

| Capability | Where | Status |
|---|---|---|
| `sendContextualUpdate(text)` mid-conversation | `@elevenlabs/client@1.15.2` `BaseConversation.d.ts`, re-exported through `useConversation` | **present** |
| `dynamicVariables` at `startSession` | `BaseConnection.d.ts` | **present** |
| `readCachedRun(sql, userId)` — the last match run, zero model calls | `src/lib/match/run.mjs`, already exported | **present** |
| `'job_matched'`, `'refused'`, `'interview_feedback'` action kinds | `voice-contract.ts` `VOICE_ACTION_KINDS` | declared, **unreached** |
| `voice_events` with `user_id` / `conversation_id` | `sql/schema.sql:75` | widened by PR #17, **nothing writes to it** |
| Agent prompt + tools as versioned code | `scripts/provision-voice-agent.mjs` | `npm run voice:agent` |

Two of those are the point of this feature: the unreached action kinds become real, and
`voice_events` finally gets its producer.

---

## 1. Page awareness

The agent should know where you are without you describing it.

- Client: `usePathname()`. Pass `dynamicVariables: { page_name, page_context }` at
  `startSession`, and `sendContextualUpdate(...)` on every subsequent navigation so a
  long conversation stays oriented.
- The *meaning* of a page comes from the server, not from parsing the URL in the browser:
  new **`GET /api/voice/context?path=…`** returns a short factual brief. On
  `/applicant/jobs/<jobId>` that brief includes the job's title and company and — if the
  user has a cached match for it — **the score and the reason sentence already stored in
  `match_evaluations`**. That is how "why am I a good fit for this role" gets answered
  with **zero model calls**: the reason was written at match time.

**DATA EGRESS BOUNDARY — the most important constraint in this document.** A contextual
update is sent to ElevenLabs. Job titles, company names, scores, skill names: fine.
**Email, phone, address, resume text, transcript PDFs, anything from `contact.*`: never.**
Implement this as an explicit allow-list built server-side in the context route, in the
same idiom as the existing `FIELDS` whitelist in `src/lib/voice.ts` — never by
stringifying a profile object and hoping. Write a test that asserts a profile containing
an email produces a brief that does not contain it.

## 2. The action router

New client tools, each one backed by an endpoint. Model them on the existing `FIELDS`
whitelist: an exhaustive `switch`, so adding a tool is a compile error until it is
handled, not a silent no-op.

| Tool | What the user says | Mechanism | Cost |
|---|---|---|---|
| `record_answer` | *(exists, unchanged)* | `POST /api/voice/answer` | — |
| `refresh_matches` | "reload my matches" | `POST /api/match { refresh: true }` | **21 model calls — debounce** |
| `list_matches` | "what are my best ones" | `readCachedRun()` | zero |
| `explain_match` | "why am I good for this one" | `readCachedRun()` → the stored reason + `requirement_scores_json` | zero |
| `open_page` | "take me to it" | `router.push()`, client-only | zero |
| `set_job_status` | "save that one", "mark it applied" | `POST /api/pipeline/status` — **another agent's route**, §5 | zero |

### `apply` is deliberately NOT a tool

Hard rule 3: ANS resolve → certificate check → Trust Index → policy gate → **human
confirm** → *then* fields. The agent may **navigate you to** `/applicant/apply?job=…`.
It may not apply. Enforce this two ways: the tool does not exist, *and* the prompt says
plainly that it cannot apply and must hand off to the page.

This is also the better demo. "It walked me to the page and then refused to take the
last step without me" is the pitch. An agent that says "applying now" while PII leaves on
a spoken word is the single bug that makes the whole pitch a lie.

### `open_page` must not trust the model

The model will sometimes produce a `job_id` that does not exist — invented, or misheard
from "the second one". So `open_page` **resolves the id against the user's own cached run
server-side** and, when it does not resolve, **refuses with a spoken reason** rather than
navigating somewhere plausible. That refusal is an `actionKind: 'refused'` transcript
entry — another declared-but-unreached case that becomes real here.

Accept ordinals too ("the second one", "the Stripe one") by resolving against the list
the agent was just given, not by free-text search over 16k postings.

## 3. Proactivity

After a match run completes:

- **If a conversation is already open:** `sendContextualUpdate` with the top matches
  (title, company, score), and the prompt instructs the agent to volunteer — *"Those are
  in. The strongest three are X at 81%, Y at 78%, Z at 74%. Want me to open one?"*
- **If no conversation is open:** the transcript panel shows the **same words as text**
  with a button. **The app must NEVER auto-open the microphone.** ElevenLabs bills per
  conversation-minute on a free-tier account, and grabbing a microphone unasked is a
  consent problem, not a delight.

**Speak three, show ten.** A voice reading ten job titles aloud is unusable. The spoken
summary names three; the panel lists ten with scores. This is a real constraint, not a
shortcut.

## 4. The flow the user asked for, end to end

```
intake finishes → matches land (the other agent's lane)
  → agent volunteers: "top three are …, want to apply to any?"
  → user: "the Stripe one"
  → open_page resolves the id, router.push('/applicant/jobs/<id>')
  → context update fires for the new page
  → agent: "Here's why you're a fit: <the reason stored at match time>.
            You're missing Kubernetes, which they list twice."
  → user: "save it"
  → save_job → POST /api/saved-jobs → transcript logs 'job_saved'
  → user: "apply"
  → agent: "I can take you to the approval page, but I can't send anything
            myself — you approve what leaves." → navigates, stops.
```

Every arrow in that diagram is an endpoint a button also calls.

## 5. Saving a job — YOU DO NOT OWN THIS. Call it, do not build it.

**Do not create a `saved_jobs` table.** A third agent is building the application
pipeline on `feat/pipeline`, and "saved" is the first stage of that pipeline, not a
separate concept. It is event-sourced onto the existing (empty) `application_events`
table. One concept, one table.

Your `save_job` tool calls **their** endpoint. The agreed contract, which both plans
state identically:

```
POST /api/pipeline/status
  { job_id: string, status: 'saved', note?: string, source: 'voice' }
  -> { ok: true, job_id, status, previous_status: string|null, at: ISO8601 }
```

If that route does not exist yet when you test, **report `save_job` as blocked on the
pipeline lane** — do not build a parallel table or a stub that writes somewhere else.
A second store for the same fact is worse than a missing feature.

The same contract gives you more than saving, for free: `status: 'applied'` /
`'interviewing'` / `'rejected'` means "mark that one as applied" is the same tool with a
different argument. Expose it as one `set_job_status` tool with a validated status
enum rather than six near-identical tools — but **never** accept `applied` as a claim
that the agent itself applied. It records what the *user says happened*. The agent still
cannot apply (see above).

## 6. `voice_events` gets its producer

Every action taken writes a row: `user_id`, `conversation_id`, kind, `job_id`, outcome,
spoken reason. This is the answer to "what did the agent do on my behalf", it is the
judge-facing audit story, and the table already exists and is empty. Nearly free.

---

## Testing — read this before spending a single ElevenLabs minute

**No real microphone conversation has ever happened on this project. Zero
conversation-minutes have ever been spent.** Therefore:

1. Build **every** action reachable through a **typed** path, the way
   `/api/voice/answer` already has a typed fallback. Every action must be fully
   exercisable with **zero** ElevenLabs minutes. Do this first and verify everything this
   way.
2. **Provision a NEW agent — do not mutate the existing one.** `npm run voice:agent`
   creates one and prints the id; put that id in your worktree's `.env.local` only. The
   `ELEVENLABS_AGENT_ID` currently in the env is the **team's shared agent**; pushing new
   tools to it with `--update` changes behaviour for Nidhi mid-hackathon. Leave it alone.
3. Then **one** real microphone conversation, at the end, deliberately. Report how many
   minutes it cost and exactly which tools actually fired.
4. Report separately: what was verified typed, what was verified spoken, what neither.

---

## Constraints

**Files another agent owns right now — do not touch:** `IntakeProgress.tsx`,
`src/app/applicant/page.tsx`, `src/app/applicant/jobs/page.tsx`,
`src/components/MatchList.tsx`, `src/lib/match-read.ts`, `src/lib/databricks.ts`.
A second agent is wiring match results into those pages on `feat/match-ui`. You own
`src/components/voice/*`, `src/lib/voice.ts`, `src/lib/voice-contract.ts`,
`src/app/api/voice/*`, and `scripts/provision-voice-agent.mjs`.

**A third agent owns `feat/pipeline`:** `sql/schema.sql`, `src/app/api/pipeline/*`,
`src/app/applicant/pipeline/page.tsx`, and `ApplicantNav.tsx`. Do not edit those, and do
not add a nav link yourself — you would conflict with them on the same array literal.

**Read the match result through `readCachedRun(sql, userId)` from
`src/lib/match/run.mjs`** — it is already exported. Do not write a second reader, and do
not wait on the other agent's `match-read.ts`.

- `ELEVENLABS_API_KEY` is **server-side only**. Never rename it to anything beginning
  `NEXT_PUBLIC_` — Next inlines those into the client bundle and would publish the key to
  every visitor silently. `src/lib/elevenlabs.ts` is the only file that reads it.
- **Never `git add -A`** — conflict markers were committed into `.env.example` that way
  once. Stage named paths.
- **Never commit to `main`.** Branch → PR.
- `npm run typecheck && npm run lint && npm run build` must pass before the PR.
  `eslint.config.mjs` enforces React-compiler rules (`react-hooks/refs`,
  `react-hooks/set-state-in-effect`) as **errors**.
- `profile_memory` is **append-only** — never UPDATE, never DELETE. `job_snapshots` is
  write-once.
- **`tarangnair98@gmail.com` / `3027b072-2f8c-4960-b3c3-33f63569b50a` is the human's live
  account. Never DELETE or UPDATE its rows**, and do not UPDATE its `goals` row — it is
  the only row in that table.
- All user-derived text — spoken, transcribed, or typed — is bound as **named SQL
  parameters**. Never interpolated.
- `ADD COLUMNS IF NOT EXISTS` is a **parse error** on this warehouse; `DESCRIBE TABLE`
  first. `CREATE TABLE IF NOT EXISTS` is fine.
- BOOLEAN columns come back from the Statement Execution API as the **strings**
  `"true"`/`"false"`. A truthiness check inverts the logic.
- `databricks api post /api/2.0/sql/statements --json @file -p TEAM` is **broken** on CLI
  v1.17.0 (`Error: Not Found`) despite what `CLAUDE.md` says. Use `scripts/lib/dbsql.mjs`
  or the REST API with `databricks auth token -p TEAM`.
- **Accessibility is a hard rule.** Every spoken action needs a visible equivalent and a
  keyboard path. An action log that only a screen-reader-less mouse user can follow fails
  the thesis of the product.
- Hard rule 4: an action never renders without its reason string.
- Hard rule 8: the denominator is ~358 fresh US roles from 74 boards. Not "all US jobs".

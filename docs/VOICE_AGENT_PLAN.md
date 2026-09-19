# Voice agent — plan for review

**Status: APPROVED 2026-09-19. Build it.**

## Decisions taken

| Question | Answer |
|---|---|
| Question set | **All 8 P0** — the existing 5 plus `employment_type`, `work_location_pref`, `work_authorization`, `graduation_date`. `pii_release_policy` stays P1: capturing consent nothing enforces yet would be a promise we cannot keep on stage. |
| Personas | **One agent — the calm assistant — built so the second is a config change.** Agent id from env, `/api/voice/session` parameterised by persona, typed actions in the renderer. The interviewer is S4 under SHOULD in the strategy doc ("cut from the bottom up"), needs a data model that does not exist, and never touches `profile_gaps`. |
| ElevenLabs key | **Provided.** Lives in `.env.local` (gitignored) as `ELEVENLABS_API_KEY`, server-side only. `ELEVENLABS_AGENT_ID` still has to be created in the dashboard. |
| Port | This worktree runs on **3001** so it cannot fight the server on 3000. Note Google OAuth's redirect URI is registered for `localhost:3000` only, so sign in with **email/password** here. |

Turn the `profile_gaps` queue into a spoken conversation, capture the answers, and
grow the profile every time the user talks to it.

The voice agent is a **medium, not a brain**. It asks what `profile_gaps` says is
open and writes answers through the same endpoint a typed form would use — hard rule
5, "everything you can say, you can type", has to be true at the API layer.

---

## 1. What exists already (do not rebuild)

| Piece | State |
|---|---|
| `profile_gaps` | LIVE. `(user_id, field_key)`, `status` open/asked/answered/skipped, `priority`, `question` — the phrasing to say out loud — `answer_value`, `answer_source` ('voice'\|'form'), `asked_at`, `answered_at`. **This is already the question queue.** |
| `profile_memory` | LIVE, append-only. `fact_id, user_id, kind, fact_key, fact_value, confidence, source, source_ref, observed_at`. Read current state via the `profile_current` view. |
| `goals` | LIVE, empty. `target_roles ARRAY`, `locations ARRAY`, `sponsorship_required BOOLEAN`, `comp_floor DOUBLE`, `start_date DATE`, `accommodations`. |
| `voice_events` | LIVE, empty. `voice_event_id, application_id, session_id, event_type, outcome, event_at, metadata_json`. |
| Gap generation | LIVE. After a resume, exactly 5 decision gaps stay open: `target_role`, `sponsorship`, `comp_floor`, `start_date`, `accommodations`. `GAP_FIELDS` in `src/lib/intake.ts` is the list. |
| ElevenLabs SDK | **Not installed.** No `@elevenlabs/*` in `package.json`. |

Two schema problems found by reading it rather than assuming:

1. **`voice_events` has no `user_id`.** It is keyed on `application_id`, which does not
   exist during onboarding — there is no application yet. It cannot store an
   onboarding transcript as written.
2. **`goals.sponsorship_required` is a `BOOLEAN`.** "I'm on F-1 OPT and I'll need H-1B
   in about two years" is not a boolean. Forcing it into one throws away the only part
   an employer actually cares about.

---

## 2. Integration shape

**Use `@elevenlabs/react`'s `useConversation`, NOT the drop-in `<elevenlabs-convai>`
widget.** The widget is faster to embed and wrong for this: we need our own transcript
panel, our own floating control, and to render the actions taken. `useConversation`
gives us per-message callbacks, client tools, and full UI control.

**Client tools, not server webhooks.** ElevenLabs server tools call an HTTPS endpoint
directly, which needs a public URL — `localhost:3000` has none, and tunnelling it is a
demo dependency waiting to break. A *client* tool runs in the browser, so its handler
can `fetch('/api/voice/answer')` with the session cookie already attached. It also
happens to be the thing that satisfies rule 5: voice hits the same endpoint the UI does.

**`ELEVENLABS_API_KEY` never reaches the browser.** `/api/voice/session` mints a signed
conversation URL server-side and returns it along with the gap queue.

```
GET  /api/voice/session
       server: profile_gaps WHERE status='open' ORDER BY priority
               → question queue + a first message naming what is already known
               → signed URL from ElevenLabs (API key stays server-side)
       → { signedUrl, gaps[], firstMessage }

browser useConversation(signedUrl, { dynamicVariables: { gapQueue, knownName, … } })
       agent asks, listens, and calls the client tool:

         record_answer({ field_key, value, confidence })

POST /api/voice/answer          ← THE SAME ENDPOINT A TYPED FORM POSTS TO
       append fact  → profile_memory (source='voice', source_ref=conversation_id)
       update       → goals (decisions) or profiles (basics)
       close gap    → status='answered', answer_source='voice', answered_at
       log turn     → voice_turns
       → { ok, action: "Updated your profile — sponsorship: F-1 OPT, H-1B in ~2 years",
           gapsRemaining: 4 }

browser appends an ACTION line to the transcript with that string.
```

### The latency problem, stated up front

Each answer is several Databricks statements, and the warehouse cold-starts 20-30 s.
Blocking the agent's next question on that write makes the conversation feel broken.

**Proposal:** the client tool returns immediately with an optimistic action line, the
write proceeds in the background, and the transcript line settles to confirmed or
failed when it lands. Warm the warehouse in `/api/voice/session` so the first write is
not the cold one.

---

## 3. The UI

Three parts, all on the applicant side.

**Left collapsible tab — the transcript.** Every turn in order: user speech, agent
speech, and `ACTION` entries. Collapsed state persists. This is the "voice agent is
just a medium" idea made visible: you can always read exactly what was said and what
it did to your data.

**Floating draggable widget — the voice control.** Connect / disconnect, mute, live
status, speaking indicator. Draggable, overlaps other widgets (high z-index), position
persisted to `localStorage`.

**Action entries.** For now the only action is `profile_updated`. The renderer takes a
list of typed actions so adding `job_matched`, `resume_tailored`, `application_sent`
later is a new case, not a rewrite.

### Accessibility — rule 6 is the product thesis, and this UI is where it is easiest to break

Non-negotiable, and the reviewer should reject the PR without them:

- **The draggable widget must be keyboard-movable.** Focus it, move it with arrow keys.
  A mouse-only drag is exactly the kind of thing rule 6 exists to prevent.
- **The transcript is an `aria-live="polite"` region** so a screen-reader user hears
  turns as they arrive.
- **Never auto-connect the microphone.** It requires an explicit user gesture, always.
- **A typed input in the transcript panel**, posting to the same `/api/voice/answer`.
  Rule 5 is not satisfied by a voice-only path, and this is also the fallback when the
  mic is denied, the room is loud, or the demo laptop misbehaves on stage.
- `prefers-reduced-motion` respected by any waveform or pulse.
- Focus must not be trapped inside the floating widget.
- Visible focus ring on every control, 4.5:1 contrast on transcript text.

---

## 4. Questions to ask

Five exist. I am proposing seven more; the reasoning per row matters more than the list.

### P0 — the first conversation (~8 questions, 3-4 minutes)

| `field_key` | Question | Why it earns a slot |
|---|---|---|
| `target_role` | What kind of role are you looking for? | exists |
| `employment_type` | **NEW** Full-time, internship, or co-op? | Changes the entire query. A new-grad search and an internship search share almost no postings. Nothing else disambiguates it. |
| `work_location_pref` | **NEW** Onsite, hybrid, or remote — and which cities? | `goals.locations` exists but **no gap row ever fills it**. The pipeline stores `is_us` on 16k postings; location preference is what turns that into a match instead of a list. |
| `sponsorship` | Will you need visa sponsorship, now or later? | exists — but see the BOOLEAN problem below |
| `work_authorization` | **NEW** Citizen, permanent resident, F-1/OPT, something else? | Distinct from sponsorship and it is what employers actually gate on. "Needs sponsorship eventually" and "cannot start without a transfer" are different answers. |
| `graduation_date` | **NEW** When do you graduate? | Drives new-grad eligibility windows, which are hard date filters on real postings. A resume's education end date is often absent or ambiguous. |
| `comp_floor` | Is there a salary below which you would rather not be contacted? | exists |
| `start_date` | When could you start? | exists |

### P1 — later sessions

| `field_key` | Question | Why |
|---|---|---|
| `accommodations` | Any accommodations I should request for you? | exists, and it is the accessibility thesis applied to the user rather than the UI |
| `pii_release_policy` | **NEW** Which of your details may I release to an employer once I have verified them? | The strongest addition. Hard rule 3 forbids PII moving before verification, and `agent_verifications.pii_fields_released` already exists — but **nobody has ever asked the user what they consent to**. Asking out loud, then honouring it in the A2A handshake, is the pitch. |
| `industries_avoid` | Anything you would rather not work on? | Cheap to capture, an *exclusion* signal the match agent can act on, and it makes the system look like it is on the user's side. |
| `clearance` | Do you hold a security clearance? | Not hypothetical: the 74-board seed list includes defence employers whose postings hard-require it. |

### P2 — only if there is time

`company_size` (startup vs large), `currently_employed` / notice period.

**14 questions is too many for one session, and that is the point.** The agent asks P0,
thanks the user, and stops. P1 comes up the next time they talk to it. That *is* "the
memory grows gradually as the user keeps interacting" — it is not a limitation to
apologise for, it is the behaviour asked for.

### Fix the BOOLEAN

`goals.sponsorship_required BOOLEAN` cannot hold a real answer. Keep the column as a
derived convenience for the match query, and store the actual answer as a
`profile_memory` fact (`fact_key='authorization.sponsorship'`) with the user's own
words. **The memory keeps what they said; the column keeps what we can filter on.**

---

## 5. Schema changes

```sql
-- voice_turns — the transcript, because voice_events cannot hold it (no user_id,
-- and it is keyed to an application that does not exist during onboarding).
-- Separate table rather than widening voice_events: turns are a different shape and
-- a much higher volume than telemetry events.
CREATE TABLE workspace.vthacks_2026.voice_turns (
  turn_id         STRING NOT NULL,
  user_id         STRING NOT NULL,
  conversation_id STRING NOT NULL COMMENT 'ElevenLabs conversation id',
  turn_index      INT    NOT NULL COMMENT 'Order within the conversation',
  role            STRING NOT NULL COMMENT 'user | agent | action',
  text            STRING,
  action_kind     STRING COMMENT 'profile_updated | … NULL unless role=action',
  action_detail   STRING,
  field_key       STRING COMMENT 'The gap this turn answered, when it answered one',
  spoken_at       TIMESTAMP NOT NULL,
  CONSTRAINT voice_turns_pk PRIMARY KEY (turn_id)
) USING DELTA;

ALTER TABLE workspace.vthacks_2026.voice_events ADD COLUMNS (
  user_id         STRING,
  conversation_id STRING
);

ALTER TABLE workspace.vthacks_2026.goals ADD COLUMNS (
  employment_type    STRING,
  work_location_pref STRING,
  work_authorization STRING,
  graduation_date    STRING COMMENT 'Free text: "May 2027" is a real answer',
  clearance          STRING,
  industries_avoid   ARRAY<STRING>,
  pii_release_policy ARRAY<STRING> COMMENT 'Field names the user consents to release',
  company_size       STRING
);
```

`profile_gaps` needs **no** change — `field_key` is already a free-form `STRING`.

**`ADD COLUMNS IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` are both parse errors on
this warehouse** (found while building the job pipeline). Those two ALTERs are the only
non-idempotent statements; `DESCRIBE TABLE` first.

---

## 6. Cost, because it is not free

- **ElevenLabs Agents bills per conversation-minute** and the free tier is small. Every
  rehearsal burns minutes. Budget them; do not leave a session connected while
  debugging.
- **Every answer writes to Databricks.** A voice session keeps the warehouse warm, which
  is fine for a demo (~$2.80/hour awake) but is a real cost if a session is left open.
- Disconnect on unmount and on tab-hide. An idle open mic is both a privacy problem and
  a billing one.

---

## 7. Known limits to state, not hide

1. **The agent can mishear.** An answer captured by voice is written with
   `confidence < 1` and `source='voice'`, and the transcript shows what it recorded so
   the user can see it was wrong. A silent wrong value is far worse than a visible one.
2. **No barge-in guarantees.** Interrupting mid-question is ElevenLabs' behaviour, not
   ours; it will not be perfect and we should not claim it is.
3. **The mic will fail on some machine at some point.** The typed fallback is the
   mitigation and it is why it is P0, not polish.
4. **Nothing consumes `pii_release_policy` yet.** Capturing consent is not enforcing it;
   the A2A gate in Vijay's lane has to read it before that claim can be made on stage.

---

## 8. Open questions for you

1. **Do I add the 7 new questions, or ship the existing 5 first?** I recommend P0's 8 —
   `employment_type` and `work_location_pref` in particular, because without them the
   16,207 scanned postings cannot be filtered into anything personal.
2. **One ElevenLabs agent or two?** `CLAUDE.md` mentions two personas (calm assistant /
   interviewer). Onboarding only needs the calm one; the interviewer is a separate
   feature.
3. **Whose ElevenLabs account, and is there an API key available?** Without one this
   builds against a mock and the voice path stays unverified — the same trap the
   extraction layer was in for hours.

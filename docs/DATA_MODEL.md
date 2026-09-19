# HIREWIRE — What is stored where

**Plan, not yet built.** Review this before we run any DDL.

Everything lives in the Databricks TEAM workspace, catalog `workspace`, schema
`vthacks_2026`. `sql/schema.sql` already sketches six of these tables but they
were never applied — the workspace today holds only `users`, `job_snapshots`,
`match_evaluations`, `application_events`, `voice_events`,
`email_classifications`, `latest_application_state`.

---

## 1. The three layers

```
FILES          Unity Catalog Volume            the actual PDF bytes
                 /Volumes/workspace/vthacks_2026/uploads/...

SOURCES        documents                       one row per resume / LinkedIn URL /
                                               transcript, with the storage path

CURRENT TRUTH  profiles                        what we believe right now, one row
               profile_experience               per user (+ child rows). This is
               profile_education                what the profile page renders.
               profile_skills
               profile_projects
               profile_certifications
               courses
               goals

MEMORY         profile_memory (append-only)    every fact we ever learned, with
                                               where it came from and how sure we
                                               are. Never updated, never deleted.

NEXT QUESTION  profile_gaps                    what is still unknown -> this is
                                               the ElevenLabs agent's queue
```

**Why two representations of the same data?** The structured tables are for
*rendering* — one fast query, the profile page draws. `profile_memory` is for
*remembering* — it keeps contradictions, provenance, and history, which is what
makes this a memory that grows rather than a form that gets overwritten. Every
write goes to both: append the fact, then update the current view.

---

## 2. Where the files go

```sql
CREATE VOLUME IF NOT EXISTS workspace.vthacks_2026.uploads
  COMMENT 'Applicant-supplied documents. Governed, durable, re-readable.';
```

Layout, keyed by content hash so the same file uploaded twice is the same object:

```
/Volumes/workspace/vthacks_2026/uploads/<user_id>/resume/<sha256>.pdf
/Volumes/workspace/vthacks_2026/uploads/<user_id>/transcript/<sha256>.pdf
```

Why a Volume and not the container's disk: the Databricks Apps filesystem is
ephemeral, so anything written locally dies on redeploy — the same trap `users`
just escaped. A Volume is also governed by Unity Catalog and, critically, it lets
us **re-extract later**: when the prompt or the schema improves, re-run over the
stored PDFs. Today the bytes are discarded the moment extraction finishes, so
that is impossible.

---

## 3. Tables

### 3.1 `documents` — every source, and where its bytes live

One row per thing the applicant gave us, including the ones they skipped.

```sql
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.documents (
  document_id      STRING   NOT NULL COMMENT 'uuid',
  user_id          STRING   NOT NULL COMMENT 'users.user_id',
  kind             STRING   NOT NULL COMMENT 'resume_pdf | linkedin_url | transcript_pdf',
  status           STRING   NOT NULL COMMENT 'received | parsed | failed | skipped',

  storage_path     STRING   COMMENT 'UC Volume path. NULL for link-only sources.',
  external_url     STRING   COMMENT 'The LinkedIn profile URL. NULL for files.',

  file_name        STRING,
  mime_type        STRING,
  byte_size        BIGINT,
  content_hash     STRING   COMMENT 'sha256 of the bytes. THE IDEMPOTENCY KEY.',

  extract_provider STRING   COMMENT 'databricks | gemini | none',
  extract_model    STRING,
  warnings         ARRAY<STRING>,

  uploaded_at      TIMESTAMP NOT NULL,
  parsed_at        TIMESTAMP,
  CONSTRAINT documents_pk PRIMARY KEY (document_id)
) USING DELTA
COMMENT 'Sources of profile data. storage_path is the link to the bytes in the Volume.';
```

`content_hash` is what fixes the duplicate-facts bug: before spending a model
call, look for an existing `parsed` row with the same `(user_id, content_hash)`.
If it exists, reuse it and append nothing.

`status = 'skipped'` is a real row on purpose. Skipping is a first-class outcome —
it is what tells the voice agent that everything is still open.

### 3.2 `profiles` — the header of the profile page

```sql
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profiles (
  user_id          STRING NOT NULL,
  full_name        STRING,
  email            STRING,
  phone            STRING,
  location         STRING,
  headline         STRING COMMENT 'e.g. "CS senior at Virginia Tech"',
  summary          STRING,
  linkedin_url     STRING COMMENT 'saved even when we cannot parse it',
  github_url       STRING,
  portfolio_url    STRING,
  years_experience DOUBLE,
  updated_at       TIMESTAMP NOT NULL,
  CONSTRAINT profiles_pk PRIMARY KEY (user_id)
) USING DELTA;
```

### 3.3 The child tables

All carry `source_document_id` so every line on the profile page can say where it
came from — that is the evidence-not-claims principle, and it is also what makes
the generated resume defensible ("every claim traces to a source").

```sql
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_experience (
  experience_id      STRING NOT NULL, user_id STRING NOT NULL,
  company            STRING, title STRING, location STRING,
  start_date         STRING COMMENT 'free text; resumes say "Jun 2024"',
  end_date           STRING, is_current BOOLEAN,
  description        STRING, bullets ARRAY<STRING>,
  ordinal            INT    COMMENT 'display order, newest first',
  source_document_id STRING, created_at TIMESTAMP NOT NULL,
  CONSTRAINT profile_experience_pk PRIMARY KEY (experience_id)
) USING DELTA;

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_education (
  education_id       STRING NOT NULL, user_id STRING NOT NULL,
  school             STRING, degree STRING, field STRING,
  start_date         STRING, end_date STRING, gpa STRING,
  source_document_id STRING, created_at TIMESTAMP NOT NULL,
  CONSTRAINT profile_education_pk PRIMARY KEY (education_id)
) USING DELTA;

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_skills (
  user_id            STRING NOT NULL,
  skill              STRING NOT NULL COMMENT 'canonical form, from career-ops/skill-extract.mjs',
  raw_skill          STRING COMMENT 'exactly as written on the resume',
  category           STRING COMMENT 'language | framework | tool | cloud | soft',
  source_document_id STRING, created_at TIMESTAMP NOT NULL,
  CONSTRAINT profile_skills_pk PRIMARY KEY (user_id, skill)
) USING DELTA;

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_projects (
  project_id         STRING NOT NULL, user_id STRING NOT NULL,
  name               STRING, description STRING,
  tech               ARRAY<STRING>, url STRING,
  source_document_id STRING, created_at TIMESTAMP NOT NULL,
  CONSTRAINT profile_projects_pk PRIMARY KEY (project_id)
) USING DELTA;

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_certifications (
  certification_id   STRING NOT NULL, user_id STRING NOT NULL,
  name               STRING, issuer STRING, issued_date STRING,
  source_document_id STRING, created_at TIMESTAMP NOT NULL,
  CONSTRAINT profile_certifications_pk PRIMARY KEY (certification_id)
) USING DELTA;
```

`courses` and `goals` are already written in `sql/schema.sql`; they gain a
`source_document_id` column so transcript-derived courses are traceable.
`courses` is what powers the Deloitte coursework lever.

### 3.4 `profile_memory` — the growing memory

Already sketched in `sql/schema.sql`. Confirming its role here: **append-only**,
one row per fact, never updated, never deleted.

```
fact_id · user_id · kind · key · value · confidence
        · source ('resume' | 'linkedin' | 'transcript' | 'voice' | 'match' | 'user_edit')
        · source_document_id · observed_at
```

Reading current state goes through `profile_current` (latest row per
`(user_id, key)` by `observed_at`). The structured tables in §3.2–3.3 are a
materialised, page-shaped copy of the same truth.

### 3.5 `profile_gaps` — the voice agent's queue

This is the table that connects intake to ElevenLabs.

```sql
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_gaps (
  user_id       STRING NOT NULL,
  field_key     STRING NOT NULL COMMENT 'phone | location | target_role | sponsorship | comp_floor | start_date | accommodations | …',
  status        STRING NOT NULL COMMENT 'open | asked | answered | skipped',
  priority      INT    NOT NULL COMMENT 'ask order: basics first, then decisions',
  question      STRING          COMMENT 'the phrasing the agent should use',
  answer_value  STRING,
  answer_source STRING          COMMENT 'voice | form',
  asked_at      TIMESTAMP, answered_at TIMESTAMP, updated_at TIMESTAMP NOT NULL,
  CONSTRAINT profile_gaps_pk PRIMARY KEY (user_id, field_key)
) USING DELTA;
```

Extraction writes `open` rows for everything it could not find. The voice agent
reads `status='open' ORDER BY priority`, asks, and writes the answer back — which
appends to `profile_memory` and updates the structured tables, exactly like a
resume upload does. Same pipeline, different source.

---

## 4. The two pages

Both applicant-only, both skippable, each writing a `documents` row either way.

| Page | Input | Writes |
|---|---|---|
| `/applicant/intake/resume` | PDF upload, or **Skip** | PDF → Volume · `documents(kind='resume_pdf', storage_path=…)` · extraction → `profiles` + children + `profile_memory` · leftovers → `profile_gaps` |
| `/applicant/intake/linkedin` | LinkedIn **URL**, or **Skip** | `documents(kind='linkedin_url', external_url=…)` · `profiles.linkedin_url` · `profile_memory` fact |
| `/applicant/profile` | — | Renders `profiles` + children, each with its source |

### An honest limit on the LinkedIn URL

Saving the URL is easy and it is worth doing — it goes on the profile and into
the employer-facing packet. But **a URL on its own yields almost no profile
data.** LinkedIn has no public API for profiles and blocks scraping, so we cannot
turn `linkedin.com/in/someone` into their experience list. Anyone claiming
otherwise at a hackathon is either scraping (fragile, against ToS) or guessing.

So the page should offer both, with the URL required and the export optional:

1. **LinkedIn URL** — saved, displayed, shared. No parsing.
2. **Optional: "Upload your LinkedIn data export"** — the `Connections.csv` or
   profile PDF from *Settings → Get a copy of your data*. This is the path that
   actually produces skills and experience, and `career-ops/linkedin-join.mjs`
   plus `career-ops/intake.mjs` already handle those files.

If we only take the URL, expect the profile to stay thin and the voice agent to
carry the load — which is a legitimate choice, just not an accident.

---

## 5. End to end

```
resume page ──upload──▶ hash the bytes
                        │
                        ├─ seen this hash before? ──yes──▶ reuse, append nothing
                        │
                        └─no─▶ PDF ──▶ /Volumes/.../uploads/<user>/resume/<sha>.pdf
                                 │
                                 ├─ documents row (storage_path, content_hash, provider)
                                 ├─ extract (Databricks ai_query, or Gemini)
                                 ├─ profile_memory  ← append every fact + provenance
                                 ├─ profiles + experience/education/skills/projects
                                 └─ profile_gaps    ← one open row per missing field

linkedin page ─URL or skip─▶ documents row + profiles.linkedin_url + memory fact

profile page ──▶ reads profiles + children, shows source per line

voice agent  ──▶ reads profile_gaps where status='open' order by priority
                 asks → writes answer → memory + structured tables + gap closed
```

---

## 6. Not in Databricks

| Store | What it holds | Why not Databricks |
|---|---|---|
| **TigerData** (Postgres) | `application_events` hypertable + continuous aggregates | Time-series native; the rolling-callback-rate query *is* the product |
| **MongoDB** | raw JD documents, immutable A2A audit log | Document store + the trust/audit story |
| **Vultr** | the ANS employer agent, and optionally the extraction worker | **Compute, not storage.** ANS needs a public unauthenticated HTTPS endpoint; Databricks Apps sits behind auth and cannot serve one |

Vultr is a plain cloud host — rented Linux VMs. It is not an AI platform and
nothing about it is AI-specific. It is in the stack for exactly one reason: ANS
has to be able to reach our employer agent at a public address. Vultr also sells
a managed Postgres, which is a real option, but we already have TigerData for
Postgres and Databricks for everything here — a third database would be
duplication, not architecture.

---

## 7. Open questions before we build

1. **LinkedIn: URL only, or URL + optional data export?** URL alone leaves the
   profile thin (see §4).
2. **Does `profiles` get edited by hand?** If yes we need `source='user_edit'`
   facts and a rule that a human edit beats an extracted value.
3. **Who runs the DDL?** `sql/` is Tarang's lane and `profile_memory`, `courses`,
   `goals`, `artifacts`, `agent_verifications`, `job_embeddings` are already
   written there but unapplied. This plan adds `documents`, `profiles`, the five
   child tables, `profile_gaps`, and the Volume.
4. **Cold start.** Every profile page load is now a warehouse query. Same 20–30 s
   idle penalty as sign-in. Warm it before demoing.

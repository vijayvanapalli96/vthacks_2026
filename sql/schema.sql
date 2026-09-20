-- ============================================================================
-- workspace.vthacks_2026 — full schema for HIREWIRE
--
-- Host:      https://dbc-0bfd7b56-c2eb.cloud.databricks.com  (workspace 7474648702108753)
-- Warehouse: 441b670a0ff475e0  ("Serverless Starter", 2X-Small, serverless)
-- Run with:  databricks api post /api/2.0/sql/statements --json @q.json -p TEAM
--            (one statement per request; the API does not take scripts)
--
-- Idempotent: every statement is CREATE ... IF NOT EXISTS, so re-running is safe.
--
-- READ THIS BEFORE ADDING A TABLE
--   * Unity Catalog PRIMARY KEY / UNIQUE constraints are INFORMATIONAL. Delta
--     does NOT enforce them. Anything needing real uniqueness has to check first
--     and accept the race, or live in Postgres (TigerData) instead.
--   * Delta is an analytics store. Point reads are fine but not fast, and the
--     warehouse cold-starts in 20-30s when idle. Do not put a latency-sensitive
--     hot path here without knowing that.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- SECTION 1 — built by the team before this file existed. Documented here as
-- the source of truth; do NOT re-create or alter these casually, other lanes
-- read them.
-- ---------------------------------------------------------------------------

-- job_snapshots — the jobs table. WRITE-ONCE.
--   job_id is derived deterministically from the posting URL (career-ops/url-key.mjs).
--   Ingest with MERGE INTO ... WHEN NOT MATCHED THEN INSERT.
--   description_text and raw_payload_json are never rewritten once captured.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.job_snapshots (
  job_snapshot_id  STRING,
  job_id           STRING,
  source           STRING,
  source_url       STRING,
  company_name     STRING,
  job_title        STRING,
  location_text    STRING,
  description_text STRING,
  discovered_at    TIMESTAMP,
  captured_at      TIMESTAMP,
  raw_payload_json STRING
) USING DELTA;

-- match_evaluations — match agent output.
--   model_provider/model_name already exist, which makes a Gemini-vs-Databricks
--   scoring comparison nearly free.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.match_evaluations (
  evaluation_id           STRING,
  job_id                  STRING,
  candidate_profile_id    STRING,
  model_provider          STRING,
  model_name              STRING,
  overall_score           DOUBLE,
  recommendation          STRING,
  explanation_text        STRING,
  requirement_scores_json STRING,
  created_at              TIMESTAMP
) USING DELTA;

-- application_events — lakehouse copy for the AI/BI dashboard. The TigerData
--   hypertable is primary for time-series charts; one helper writes both.
--   event_type ∈ viewed | tailored | verified | refused | submitted | callback | rejected
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.application_events (
  event_id       STRING,
  application_id STRING,
  job_id         STRING,
  event_type     STRING,
  event_source   STRING,
  event_at       TIMESTAMP,
  metadata_json  STRING
) USING DELTA;

-- voice_events — ElevenLabs session telemetry. Free evidence the voice layer is real.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.voice_events (
  voice_event_id STRING,
  application_id STRING,
  session_id     STRING,
  event_type     STRING,
  outcome        STRING,
  event_at       TIMESTAMP,
  metadata_json  STRING
) USING DELTA;

-- email_classifications — Gmail ingestion is OUT OF SCOPE for the 15-hour build.
--   The table exists; we are not filling it. Left here so nobody "discovers" it
--   and starts building.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.email_classifications (
  classification_id STRING,
  application_id    STRING,
  gmail_message_id  STRING,
  classification    STRING,
  confidence        DOUBLE,
  rationale_text    STRING,
  received_at       TIMESTAMP,
  classified_at     TIMESTAMP,
  requires_review   BOOLEAN
) USING DELTA;


-- ---------------------------------------------------------------------------
-- SECTION 2 — LIVE. Created and in use by the running app.
-- ---------------------------------------------------------------------------

-- users — accounts for BOTH sides of the handshake (applicant and employer).
--   Written by src/lib/users.ts via the SQL Statement Execution API.
--   Sessions are stateless JWTs, so there is deliberately no sessions table.
--   role is NULL only between a Google sign-in and the /continue hop that
--   persists the pathway chosen on the landing page.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.users (
  user_id       STRING    NOT NULL COMMENT 'UUID, also the JWT subject',
  email         STRING    NOT NULL COMMENT 'Lowercased, trimmed. Natural key.',
  name          STRING             COMMENT 'Display name, optional',
  password_hash STRING             COMMENT 'bcrypt, 10 rounds. NULL for Google accounts.',
  role          STRING             COMMENT 'applicant | employer',
  provider      STRING    NOT NULL COMMENT 'credentials | google',
  created_at    TIMESTAMP NOT NULL,
  CONSTRAINT users_pk PRIMARY KEY (user_id)
) USING DELTA
COMMENT 'User accounts for HireWire sign-in (email/password + Google).';


-- ---------------------------------------------------------------------------
-- SECTION 3 — LIVE as of 2026-09-19. Created, empty, waiting on their lanes.
-- See docs/FEATURE_LIST.md "Data model" and docs/DATA_MODEL.md.
-- ---------------------------------------------------------------------------

-- profile_memory — APPEND-ONLY. The profile that grows over time.
--   Never UPDATE, never DELETE. Resume parses, voice answers, match outcomes and
--   rejections all append a fact with provenance. Read current state through
--   profile_current below.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_memory (
  fact_id     STRING    NOT NULL,
  user_id     STRING    NOT NULL,
  kind        STRING             COMMENT 'skill | experience | education | preference | gap',
  fact_key    STRING    NOT NULL,
  fact_value  STRING,
  confidence  DOUBLE             COMMENT '0..1',
  source      STRING             COMMENT 'resume | transcript | linkedin | voice | match | rejection',
  source_ref  STRING             COMMENT 'artifact id or utterance id that produced this',
  observed_at TIMESTAMP NOT NULL
) USING DELTA
COMMENT 'Append-only profile facts. One row per observation, never mutated.';

-- profile_current — latest value per (user_id, fact_key).
CREATE OR REPLACE VIEW workspace.vthacks_2026.profile_current AS
SELECT user_id, fact_key, fact_value, confidence, source, source_ref, observed_at
FROM (
  SELECT *, ROW_NUMBER() OVER (
           PARTITION BY user_id, fact_key ORDER BY observed_at DESC
         ) AS rn
  FROM workspace.vthacks_2026.profile_memory
)
WHERE rn = 1;

-- courses — feeds the "coursework lever" query that Deloitte's brief asks for.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.courses (
  user_id     STRING NOT NULL,
  course_code STRING NOT NULL COMMENT 'Real VT codes, e.g. CS 3214',
  title       STRING,
  term        STRING,
  grade       STRING,
  skills      ARRAY<STRING>     COMMENT 'Skills this course implies'
) USING DELTA;

-- goals — captured by the voice agent, echoed back for confirmation.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.goals (
  user_id              STRING NOT NULL,
  target_roles         ARRAY<STRING>,
  locations            ARRAY<STRING>,
  sponsorship_required BOOLEAN,
  comp_floor           DOUBLE,
  start_date           DATE,
  accommodations       STRING,
  updated_at           TIMESTAMP
) USING DELTA;

-- job_embeddings — kept separate so job_snapshots stays write-once.
--   Populate with ai_query('databricks-gte-large-en', description_text) → 1024-dim.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.job_embeddings (
  job_id      STRING NOT NULL,
  embedding   ARRAY<FLOAT> COMMENT '1024-dim, databricks-gte-large-en',
  embedded_at TIMESTAMP
) USING DELTA;

-- artifacts — generated documents, stored in a UC Volume and referenced by id.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.artifacts (
  artifact_id STRING NOT NULL,
  user_id     STRING NOT NULL,
  job_id      STRING,
  kind        STRING COMMENT 'resume | cover_letter | email',
  volume_path STRING,
  created_at  TIMESTAMP
) USING DELTA;

-- job_agent_links — verified association between an immutable job snapshot and
--   the employer agent that can receive an application for it.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.job_agent_links (
  job_id             STRING    NOT NULL,
  employer_domain    STRING    NOT NULL,
  employer_agent_id  STRING    NOT NULL,
  employer_ans_name  STRING    NOT NULL,
  employer_endpoint  STRING    NOT NULL,
  discovery_status   STRING    NOT NULL COMMENT 'verified | unavailable | refused',
  discovered_at      TIMESTAMP NOT NULL
) USING DELTA
COMMENT 'Verified job-to-employer-agent associations discovered through ANS.';

-- candidate_discovery_profiles — opt-in, non-PII search surface for employers.
--   Contact details and resumes stay private until the applicant approves release.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.candidate_discovery_profiles (
  user_id          STRING        NOT NULL,
  applicant_ans_name STRING      NOT NULL,
  headline         STRING,
  skills           ARRAY<STRING>,
  target_roles     ARRAY<STRING>,
  locations        ARRAY<STRING>,
  opt_in           BOOLEAN       NOT NULL,
  updated_at       TIMESTAMP     NOT NULL
) USING DELTA
COMMENT 'Opt-in, non-PII student profiles used for verified employer discovery.';

-- agent_match_explanations — why an agent considered a candidate and a job a fit,
--   computed only from candidate-approved skills and employer-published requirements.
--   Append-only; every row carries its reasons.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.agent_match_explanations (
  match_id                STRING        NOT NULL,
  application_id          STRING,
  job_id                  STRING        NOT NULL,
  direction               STRING        NOT NULL COMMENT 'applicant_to_employer | employer_to_applicant',
  score                   DOUBLE        NOT NULL COMMENT '0..100',
  verdict                 STRING        NOT NULL COMMENT 'strong | potential | weak',
  matched_skills          ARRAY<STRING>,
  missing_required_skills ARRAY<STRING>,
  reasons_json            STRING        NOT NULL COMMENT 'JSON array of reason strings',
  evidence_basis          STRING        NOT NULL,
  created_at              TIMESTAMP     NOT NULL
) USING DELTA
COMMENT 'Deterministic, explainable skill-match verdicts exchanged between ANS agents.';

-- agent_verifications — the ANS / Trust Index record. The strategy doc flags the
--   absence of this table as an explicit GAP; the Trust Card UI reads it.
--   A refusal MUST have pii_fields_released empty. If it ever isn't, that is the
--   one bug that turns the whole pitch into a lie.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.agent_verifications (
  verification_id     STRING    NOT NULL,
  application_id      STRING,
  verifier_ans_name   STRING             COMMENT 'Agent performing the verification',
  agent_ans_name      STRING             COMMENT 'e.g. ans://v1.0.0.employer.<domain>',
  subject_role        STRING             COMMENT 'employer | applicant',
  purpose             STRING             COMMENT 'job_application | recruiting_invitation',
  agent_version       STRING,
  verdict             STRING             COMMENT 'allowed | refused',
  integrity           DOUBLE,
  identity            DOUBLE,
  solvency            DOUBLE,
  behavior            DOUBLE,
  safety              DOUBLE,
  reasons_json        STRING             COMMENT 'One reason string per dimension. A score without a reason is a bug.',
  pii_fields_released ARRAY<STRING>      COMMENT 'MUST be empty when verdict = refused',
  checked_at          TIMESTAMP NOT NULL
) USING DELTA
COMMENT 'Every agent-to-agent verification, including the refusals.';


-- ---------------------------------------------------------------------------
-- SECTION 4 — intake + the structured profile. See docs/DATA_MODEL.md.
--
-- Three layers, on purpose:
--   uploads (Volume)  the actual bytes
--   documents         one row per source, carrying the path to those bytes
--   profiles + kids   what we believe now; this is what the profile page renders
--   profile_memory    everything we ever learned (SECTION 3) — the growing memory
--   profile_gaps      what is still unknown; the ElevenLabs agent's queue
--
-- profiles/* is a page-shaped copy of the truth in profile_memory, not a rival
-- source. Every write appends a fact AND updates the structured row.
-- ---------------------------------------------------------------------------

-- Bytes live here. NOT on the app's local disk: the Databricks Apps filesystem is
-- ephemeral, so anything written there dies on redeploy. Keeping the original PDF
-- also means we can RE-EXTRACT later when the prompt or schema improves.
CREATE VOLUME IF NOT EXISTS workspace.vthacks_2026.uploads
  COMMENT 'Applicant-supplied documents. /Volumes/workspace/vthacks_2026/uploads/<user_id>/<kind>/<sha256>.<ext>';

-- intake_documents — every source the applicant gave us, INCLUDING the ones they skipped.
--   status='skipped' is a real row: it is what tells the voice agent the field is
--   still open. "Upload or skip" only works as a product if skipping records something.
--   content_hash is the idempotency key. Before spending a model call, look for an
--   existing 'parsed' row with the same (user_id, content_hash) and reuse it.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.intake_documents (
  document_id      STRING    NOT NULL COMMENT 'uuid',
  user_id          STRING    NOT NULL COMMENT 'users.user_id',
  kind             STRING    NOT NULL COMMENT 'resume_pdf | linkedin_url | linkedin_export_pdf | transcript_pdf',
  status           STRING    NOT NULL COMMENT 'received | parsed | failed | skipped',
  storage_path     STRING             COMMENT 'UC Volume path. NULL for link-only sources.',
  external_url     STRING             COMMENT 'The LinkedIn profile URL. NULL for files.',
  file_name        STRING,
  mime_type        STRING,
  byte_size        BIGINT,
  content_hash     STRING             COMMENT 'sha256 of the bytes. THE IDEMPOTENCY KEY.',
  extract_provider STRING             COMMENT 'databricks | gemini | none',
  extract_model    STRING,
  warnings         ARRAY<STRING>,
  error_message    STRING,
  uploaded_at      TIMESTAMP NOT NULL,
  parsed_at        TIMESTAMP,
  CONSTRAINT intake_documents_pk PRIMARY KEY (document_id)
) USING DELTA
COMMENT 'Sources of profile data. storage_path links a row to its bytes in the uploads Volume.';

-- profiles — one current row per user. The header of the profile page.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profiles (
  user_id          STRING NOT NULL,
  full_name        STRING,
  email            STRING,
  phone            STRING,
  location         STRING,
  headline         STRING COMMENT 'e.g. "CS senior at Virginia Tech"',
  summary          STRING,
  linkedin_url     STRING COMMENT 'Saved even though a URL alone cannot be parsed — no public API, scraping blocked.',
  github_url       STRING,
  portfolio_url    STRING,
  years_experience DOUBLE,
  updated_at       TIMESTAMP NOT NULL,
  CONSTRAINT profiles_pk PRIMARY KEY (user_id)
) USING DELTA;

-- Child tables. Every row carries source_document_id so each line on the profile
-- page can say where it came from — that is the evidence-not-claims principle, and
-- it is what makes a generated resume defensible.

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_experience (
  experience_id      STRING    NOT NULL,
  user_id            STRING    NOT NULL,
  company            STRING,
  title              STRING,
  location           STRING,
  start_date         STRING             COMMENT 'Free text on purpose because resumes say "Jun 2024"',
  end_date           STRING,
  is_current         BOOLEAN,
  description        STRING,
  bullets            ARRAY<STRING>,
  ordinal            INT                COMMENT 'Display order, newest first.',
  source_document_id STRING,
  created_at         TIMESTAMP NOT NULL,
  CONSTRAINT profile_experience_pk PRIMARY KEY (experience_id)
) USING DELTA;

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_education (
  education_id       STRING    NOT NULL,
  user_id            STRING    NOT NULL,
  school             STRING,
  degree             STRING,
  field              STRING,
  start_date         STRING,
  end_date           STRING,
  gpa                STRING,
  source_document_id STRING,
  created_at         TIMESTAMP NOT NULL,
  CONSTRAINT profile_education_pk PRIMARY KEY (education_id)
) USING DELTA;

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_skills (
  user_id            STRING    NOT NULL,
  skill              STRING    NOT NULL COMMENT 'Canonical form — career-ops/skill-extract.mjs',
  raw_skill          STRING             COMMENT 'Exactly as written on the resume',
  category           STRING             COMMENT 'language | framework | tool | cloud | soft',
  source_document_id STRING,
  created_at         TIMESTAMP NOT NULL,
  CONSTRAINT profile_skills_pk PRIMARY KEY (user_id, skill)
) USING DELTA;

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_projects (
  project_id         STRING    NOT NULL,
  user_id            STRING    NOT NULL,
  name               STRING,
  description        STRING,
  tech               ARRAY<STRING>,
  url                STRING,
  source_document_id STRING,
  created_at         TIMESTAMP NOT NULL,
  CONSTRAINT profile_projects_pk PRIMARY KEY (project_id)
) USING DELTA;

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_certifications (
  certification_id   STRING    NOT NULL,
  user_id            STRING    NOT NULL,
  name               STRING,
  issuer             STRING,
  issued_date        STRING,
  source_document_id STRING,
  created_at         TIMESTAMP NOT NULL,
  CONSTRAINT profile_certifications_pk PRIMARY KEY (certification_id)
) USING DELTA;

-- profile_gaps — the table that joins intake to the voice agent.
--   Extraction writes an 'open' row for every field it could not find. The agent
--   reads status='open' ORDER BY priority, asks, and writes the answer back, which
--   appends to profile_memory and updates the structured tables — the same
--   pipeline a resume upload uses, just a different source.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.profile_gaps (
  user_id       STRING    NOT NULL,
  field_key     STRING    NOT NULL COMMENT 'phone | location | target_role | sponsorship | comp_floor | start_date | accommodations | ...',
  status        STRING    NOT NULL COMMENT 'open | asked | answered | skipped',
  priority      INT       NOT NULL COMMENT 'Ask order: basics first, then decisions.',
  question      STRING             COMMENT 'The phrasing the agent should use out loud.',
  answer_value  STRING,
  answer_source STRING             COMMENT 'voice | form',
  asked_at      TIMESTAMP,
  answered_at   TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL,
  CONSTRAINT profile_gaps_pk PRIMARY KEY (user_id, field_key)
) USING DELTA
COMMENT 'What we still need to ask. Drives the ElevenLabs question queue.';


-- SECTION 5 — LIVE. The job discovery pipeline (scripts/scan/).
--   Applied to workspace.vthacks_2026 on 2026-09-19. Plan:
--   docs/JOB_PIPELINE_PLAN.md. Writer: scripts/scan/scan-us-jobs.mjs, every
--   5 minutes, one row per posting.
--
--   NOTE ON APPLYING THIS FILE: do NOT write a helper that splits it on ';'.
--   A semicolon inside a COMMENT string splits a statement in two and
--   half-applies the schema. (No COMMENT string in this file contains one, and
--   keeping it that way is cheaper than a correct parser.)
-- ---------------------------------------------------------------------------

-- job_snapshots gains three columns. The scanner stores EVERY posting it
-- fetches: US-ness and freshness are COLUMNS, not a discard. A dropped row
-- cannot be re-examined when the filter turns out to have been wrong, and the US
-- filter being subtly wrong is the most likely silent failure in this lane.
-- The table already exists and other lanes read it, so this is ALTER, never a
-- re-CREATE.
--
-- THE ONLY NON-IDEMPOTENT STATEMENT IN THIS FILE. `ADD COLUMNS IF NOT EXISTS`
-- and `ADD COLUMN IF NOT EXISTS` were both tried against this warehouse on
-- 2026-09-19 and BOTH are parse errors ([PARSE_SYNTAX_ERROR] at 'EXISTS') — the
-- clause the Delta docs suggest is not accepted here. Re-running this statement
-- therefore fails with FIELDS_ALREADY_EXIST. That is a loud, harmless failure;
-- check first with DESCRIBE TABLE workspace.vthacks_2026.job_snapshots and skip
-- it if is_us is already there.
ALTER TABLE workspace.vthacks_2026.job_snapshots ADD COLUMNS (
  is_us               BOOLEAN   COMMENT 'Verdict of scripts/scan/lib/location-us.mjs. Heuristic over a display string plus a Workday URL path segment, not a gazetteer.',
  posted_at           TIMESTAMP COMMENT 'When the employer published the posting. NULL when the source exposes no date, which is why freshness is a filter and not a claim.',
  location_confidence STRING    COMMENT 'display = the posting named a place we recognise. url_hint = the location string named none and the URL path did. unknown = no geography was read, so is_us rests on a weak signal such as a bare Remote.'
);

-- open_us_jobs — "US roles open right now" as a query rather than a discard.
-- 3 days matches the scanner constant FRESHNESS_DAYS. Postings with no
-- posted_at are excluded here on purpose: without a date we cannot claim a
-- posting is open, and the row still exists in job_snapshots for anyone who
-- wants to reason about it.
CREATE OR REPLACE VIEW workspace.vthacks_2026.open_us_jobs AS
SELECT * FROM workspace.vthacks_2026.job_snapshots
WHERE is_us AND posted_at >= current_timestamp() - INTERVAL 3 DAYS;

-- job_boards — the seed list AND its health. Scheduling state lives with the
--   thing being scheduled, so a restart does not lose the rotation. Seeded from
--   scripts/scan/boards.json via `npm run boards:seed`, which never resets the
--   rotation or health columns of a board it already knows.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.job_boards (
  board_id             STRING NOT NULL COMMENT 'provider:slug, e.g. greenhouse:stripe',
  provider             STRING NOT NULL COMMENT 'greenhouse | ashby | lever | workday | icims',
  company_name         STRING          COMMENT 'Real employer name. No placeholders.',
  board_slug           STRING,
  api_url              STRING          COMMENT 'Pinned public JSON endpoint. Pinned rather than detected so a marketing site redesign cannot break the scan.',
  careers_url          STRING          COMMENT 'Human-facing board, for the UI and for debugging',
  country_hint         STRING,
  enabled              BOOLEAN,
  last_scanned_at      TIMESTAMP       COMMENT 'Drives the rotating slice. NULLS FIRST, so a new board is scanned next.',
  last_ok_at           TIMESTAMP,
  consecutive_failures INT,
  backoff_until        TIMESTAMP       COMMENT 'Boards break. Without a backoff we re-hit a dead board every 5 minutes forever.',
  CONSTRAINT job_boards_pk PRIMARY KEY (board_id)
) USING DELTA
COMMENT 'Employer job boards to scan, with their rotation and health state.';

-- scan_runs — one row per tick. The observability story, the "is the pipeline
--   alive?" answer for the dashboard, AND the uniqueness assertion.
--   postings_us / postings_fresh / postings_undated matter more than they look:
--   they are how we tell "the US filter is working" from "the US filter is
--   eating everything".
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.scan_runs (
  run_id           STRING    NOT NULL,
  started_at       TIMESTAMP NOT NULL,
  finished_at      TIMESTAMP,
  boards_attempted INT,
  boards_ok        INT,
  boards_failed    INT,
  postings_seen    INT       COMMENT 'Everything the providers returned, before in-memory de-duplication',
  postings_new     INT       COMMENT 'Rows the MERGE actually inserted',
  postings_us      INT,
  postings_fresh   INT,
  postings_undated INT,
  total_rows       BIGINT    COMMENT 'count(*) over job_snapshots at the end of the tick',
  distinct_job_ids BIGINT    COMMENT 'count(DISTINCT job_id) over the same. MUST equal total_rows. UC PRIMARY KEY is informational and Delta enforces nothing, so uniqueness is produced by the writer and verified here, every run.',
  error_message    STRING    COMMENT 'Board failures, and a loud message if the assertion above ever fires',
  CONSTRAINT scan_runs_pk PRIMARY KEY (run_id)
) USING DELTA
COMMENT 'One row per 5-minute scan tick, including the uniqueness assertion.';

-- scan_locks — the single-writer lock. NOT in the original plan document, and
--   needed for its own section 3.1 point 3 to be true: two concurrent MERGEs
--   against job_snapshots can both evaluate "not matched" for one job_id and
--   both insert, because Delta's optimistic concurrency does not serialise
--   them. A 5-minute cron with ~90s ticks overlaps as soon as one tick runs
--   long, and a lock file on one machine cannot see a tick running on another.
--   A tick that cannot take the lock EXITS. Locks expire so a crashed tick
--   cannot wedge the pipeline (see scripts/scan/lib/lock.mjs).
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.scan_locks (
  lock_name   STRING    NOT NULL COMMENT 'us-scan',
  holder      STRING    NOT NULL COMMENT 'Per-tick UUID. Ownership is confirmed by reading this back after the acquire.',
  acquired_at TIMESTAMP NOT NULL,
  expires_at  TIMESTAMP NOT NULL COMMENT 'A later tick may steal an expired lock',
  CONSTRAINT scan_locks_pk PRIMARY KEY (lock_name)
) USING DELTA
COMMENT 'Single-writer lock for the job scan tick. One row per lock name.';


-- ---------------------------------------------------------------------------
-- SECTION 6 — the voice agent. Applied 2026-09-19. See docs/VOICE_AGENT_PLAN.md §5.
--
-- Two problems found by reading this file rather than assuming, and what was done
-- about each:
--
--   1. voice_events has no user_id and is keyed on application_id, which does not
--      exist during onboarding — there is no application yet. So it cannot hold an
--      onboarding transcript. Rather than bend it, the transcript gets its own
--      table (voice_turns): turns are a different shape and a much higher volume
--      than telemetry events. voice_events is widened only so a session can be
--      attributed to a user at all.
--
--   2. goals.sponsorship_required is a BOOLEAN. "I'm on F-1 OPT and I'll need
--      H-1B in about two years" is not a boolean, and the part an employer cares
--      about is exactly the part a boolean throws away. The column STAYS, as a
--      derived convenience for the match query; the user's own words are appended
--      to profile_memory as voice.sponsorship. The memory keeps what they said,
--      the column keeps what we can filter on.
--
-- NOTE FOR RE-RUNS: the two ALTERs below are the only NON-idempotent statements
-- in this file. `ADD COLUMNS IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` are
-- both PARSE ERRORS on this warehouse. DESCRIBE TABLE first and skip them if the
-- columns are already there.
-- ---------------------------------------------------------------------------

-- voice_turns — the transcript, in order, including what the system DID.
--   role='action' rows are why this is worth storing: they are the audit trail of
--   a voice turn changing the user's data, which is the claim the product makes.
--   turn_id is a client-minted uuid so a retry cannot double-log a turn.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.voice_turns (
  turn_id         STRING NOT NULL,
  user_id         STRING NOT NULL,
  conversation_id STRING NOT NULL COMMENT 'ElevenLabs conversation id, or typed:<uuid> for the typed fallback',
  turn_index      INT    NOT NULL COMMENT 'Order within the conversation',
  role            STRING NOT NULL COMMENT 'user | agent | action',
  text            STRING,
  action_kind     STRING COMMENT 'profile_updated | job_matched | refused | interview_feedback. NULL unless role=action',
  action_detail   STRING,
  field_key       STRING COMMENT 'The gap this turn answered, when it answered one',
  spoken_at       TIMESTAMP NOT NULL,
  CONSTRAINT voice_turns_pk PRIMARY KEY (turn_id)
) USING DELTA
COMMENT 'One row per conversation turn. role=action rows record what the turn changed.';

-- Attribution for voice telemetry. NOT the transcript — see voice_turns.
ALTER TABLE workspace.vthacks_2026.voice_events ADD COLUMNS (
  user_id         STRING COMMENT 'users.user_id. Onboarding has no application_id.',
  conversation_id STRING COMMENT 'ElevenLabs conversation id'
);

-- The structured side of the P0 question set. Free text, not enums: "May 2027"
-- and "hybrid, Blacksburg or Arlington" are real answers and normalising them
-- here would discard the part that makes them useful.
ALTER TABLE workspace.vthacks_2026.goals ADD COLUMNS (
  employment_type    STRING COMMENT 'full-time | internship | co-op, in the user''s words',
  work_location_pref STRING COMMENT 'Onsite/hybrid/remote plus cities, free text',
  work_authorization STRING COMMENT 'Citizen | permanent resident | F-1 OPT | ... free text',
  graduation_date    STRING COMMENT 'Free text: "May 2027" is a real answer',
  clearance          STRING,
  industries_avoid   ARRAY<STRING>,
  pii_release_policy ARRAY<STRING> COMMENT 'Field names the user consents to release. NOTHING READS THIS YET.',
  company_size       STRING
);

-- profile_gaps needs NO change: field_key is already a free-form STRING, so the
-- four new P0 questions are rows, not columns.


-- ---------------------------------------------------------------------------
-- SECTION 7 — the match agent. APPLIED LIVE 2026-09-19.
-- See docs/MATCH_AGENT_PLAN.md §5.
--
-- Numbered 7, not 5: the job pipeline took SECTION 5 and the voice agent took
-- SECTION 6 while this branch was open. Renumbered on merge rather than
-- renumbering theirs, because every other lane's notes already refer to their
-- sections by number.
--
-- Read this before re-running the ALTER below:
--   `ADD COLUMNS IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` are BOTH parse
--   errors on this warehouse. The ALTER is therefore NOT idempotent — the rest
--   of this file is. `DESCRIBE TABLE workspace.vthacks_2026.match_evaluations`
--   first and skip it if `run_id` is already there.
-- ---------------------------------------------------------------------------

-- match_runs — one row per match run. Same role as scan_runs: observability, and
--   the "is it working?" answer. Without it a bad run is invisible: you can see
--   that rows were written but not that 200 candidates collapsed to 3 because a
--   filter was inverted, or that the eligibility gate dropped 8 roles and why.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.match_runs (
  run_id             STRING    NOT NULL,
  user_id            STRING    NOT NULL,
  started_at         TIMESTAMP NOT NULL,
  finished_at        TIMESTAMP          COMMENT 'NULL means the run never completed. The cache reader requires NOT NULL.',
  candidates_total   INT                COMMENT 'Jobs considered before filtering',
  after_filters      INT                COMMENT 'Survived the hard filters, incl. the eligibility gate',
  after_similarity   INT                COMMENT 'Survived the cosine cut — the rerank candidate set',
  reranked           INT                COMMENT 'How many model calls were actually spent',
  written            INT                COMMENT 'match_evaluations rows written',
  dropped_ineligible INT                COMMENT 'Filtered by the eligibility gate, each with a stated reason',
  model_provider     STRING,
  model_name         STRING,
  error_message      STRING,
  CONSTRAINT match_runs_pk PRIMARY KEY (run_id)
) USING DELTA
COMMENT 'One row per match run. Observability for the match agent.';

-- The zero-token stage-1 output, kept on the evaluation row so a score can be
-- explained without a model — and so the coursework lever (a later follow-up)
-- has `skills_missing` to aggregate. NOT IDEMPOTENT; see the note above.
--
-- NOTE on the live table: `overall_score` is DECIMAL(5,2) in the workspace, not
-- the DOUBLE this file's SECTION 1 records. SECTION 1 documents a table that
-- predates this file; the live definition wins and the match writer binds a
-- DOUBLE parameter that Delta narrows on insert.
--
-- match_evaluations is the CACHE, not a ledger: a re-score DELETEs the user's
-- previous rows so there is at most one row per (user_id, job_id). The history
-- lives in match_runs. Unity Catalog PRIMARY KEYs are informational and Delta
-- does not enforce them (see the header of this file), so that uniqueness is
-- arranged by the writer, not declared here.
ALTER TABLE workspace.vthacks_2026.match_evaluations ADD COLUMNS (
  run_id             STRING,
  user_id            STRING        COMMENT 'candidate_profile_id predates users; this is users.user_id',
  retrieval_rank     INT           COMMENT 'Rank after the stage-1 cosine cut, 1-based',
  similarity         DOUBLE        COMMENT 'Cosine, job description embedding vs profile summary embedding',
  skills_matched     ARRAY<STRING> COMMENT 'Profile skills the JD explicitly asks for',
  skills_missing     ARRAY<STRING> COMMENT 'JD requirements with no trace in the profile',
  courses_matched    ARRAY<STRING> COMMENT 'Coursework that covers a JD requirement',
  eligibility        STRING        COMMENT 'pass | fail | unknown',
  eligibility_reason STRING        COMMENT 'Why. A fail with no reason is a bug — see hard rule 4.'
);

-- job_embeddings needs NO change. It already existed in SECTION 3 with exactly
-- the right shape; it was simply EMPTY. scripts/embed-jobs.mjs fills it:
-- 16,206 rows, 1024-dim, from 16,207 job_snapshots (one row has an empty
-- description_text and is skipped, not failed).

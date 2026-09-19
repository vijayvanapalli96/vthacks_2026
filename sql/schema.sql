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
-- SECTION 3 — PLANNED. Not created yet; these are the tables the rest of the
-- feature list needs. See docs/FEATURE_LIST.md "Data model".
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
-- SECTION 4 — LIVE. The job discovery pipeline (scripts/scan/).
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

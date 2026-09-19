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

-- agent_verifications — the ANS / Trust Index record. The strategy doc flags the
--   absence of this table as an explicit GAP; the Trust Card UI reads it.
--   A refusal MUST have pii_fields_released empty. If it ever isn't, that is the
--   one bug that turns the whole pitch into a lie.
CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.agent_verifications (
  verification_id     STRING    NOT NULL,
  application_id      STRING,
  agent_ans_name      STRING             COMMENT 'e.g. ans://v1.0.0.employer.<domain>',
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

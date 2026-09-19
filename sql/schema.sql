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

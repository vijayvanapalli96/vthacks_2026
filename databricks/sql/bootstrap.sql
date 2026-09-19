CREATE SCHEMA IF NOT EXISTS workspace.vthacks_2026
COMMENT 'VT Hacks 2026 governed analytics and AI workflow data';

CREATE VOLUME IF NOT EXISTS workspace.vthacks_2026.documents
COMMENT 'Resumes, job descriptions, and approved generated application documents';

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.job_snapshots (
  job_snapshot_id STRING NOT NULL COMMENT 'Unique snapshot identifier',
  job_id STRING NOT NULL COMMENT 'Stable application job identifier',
  source STRING NOT NULL COMMENT 'manual, greenhouse, lever, gmail, or another approved source',
  source_url STRING COMMENT 'Original job posting URL',
  company_name STRING,
  job_title STRING,
  location_text STRING,
  description_text STRING,
  discovered_at TIMESTAMP,
  captured_at TIMESTAMP NOT NULL,
  raw_payload_json STRING COMMENT 'Source payload retained as JSON for auditability'
)
USING DELTA
COMMENT 'Append-only snapshots of discovered or candidate-supplied job postings'
TBLPROPERTIES (
  'delta.enableChangeDataFeed' = 'true',
  'quality' = 'silver',
  'domain' = 'job-applications'
);

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.match_evaluations (
  evaluation_id STRING NOT NULL COMMENT 'Unique evaluation identifier',
  job_id STRING NOT NULL,
  candidate_profile_id STRING NOT NULL,
  model_provider STRING NOT NULL,
  model_name STRING NOT NULL,
  overall_score DECIMAL(5,2) COMMENT 'Explainable match score from 0 to 100',
  recommendation STRING COMMENT 'apply, review, or skip',
  explanation_text STRING,
  requirement_scores_json STRING COMMENT 'Per-requirement evidence, weight provenance, and score as JSON',
  created_at TIMESTAMP NOT NULL
)
USING DELTA
COMMENT 'Versioned, explainable resume-to-job match evaluations'
TBLPROPERTIES (
  'delta.enableChangeDataFeed' = 'true',
  'quality' = 'silver',
  'domain' = 'job-applications'
);

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.application_events (
  event_id STRING NOT NULL COMMENT 'Unique lifecycle event identifier',
  application_id STRING NOT NULL,
  job_id STRING NOT NULL,
  event_type STRING NOT NULL COMMENT 'drafted, approved, submitted, interview, offer, rejected, or another normalized state',
  event_source STRING NOT NULL COMMENT 'user, gmail, workflow, or integration',
  event_at TIMESTAMP NOT NULL,
  metadata_json STRING
)
USING DELTA
COMMENT 'Append-only analytical history for the application lifecycle'
TBLPROPERTIES (
  'delta.enableChangeDataFeed' = 'true',
  'quality' = 'silver',
  'domain' = 'job-applications'
);

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.email_classifications (
  classification_id STRING NOT NULL,
  application_id STRING,
  gmail_message_id STRING NOT NULL,
  classification STRING NOT NULL COMMENT 'interview, assessment, recruiter_follow_up, offer, rejection, neutral, or uncertain',
  confidence DECIMAL(5,4) COMMENT 'Classifier confidence from 0 to 1',
  rationale_text STRING,
  received_at TIMESTAMP,
  classified_at TIMESTAMP NOT NULL,
  requires_review BOOLEAN NOT NULL
)
USING DELTA
COMMENT 'Auditable classifications of Gmail responses connected to tracked applications'
TBLPROPERTIES (
  'delta.enableChangeDataFeed' = 'true',
  'quality' = 'silver',
  'domain' = 'job-applications'
);

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.voice_events (
  voice_event_id STRING NOT NULL,
  application_id STRING,
  session_id STRING,
  event_type STRING NOT NULL COMMENT 'notification_created, played, acknowledged, navigation_command, or failed',
  outcome STRING,
  event_at TIMESTAMP NOT NULL,
  metadata_json STRING
)
USING DELTA
COMMENT 'ElevenLabs accessibility and spoken-notification telemetry without audio content'
TBLPROPERTIES (
  'delta.enableChangeDataFeed' = 'true',
  'quality' = 'silver',
  'domain' = 'accessibility'
);

CREATE OR REPLACE VIEW workspace.vthacks_2026.latest_application_state
COMMENT 'Most recent known lifecycle state for each application'
AS
SELECT
  application_id,
  job_id,
  event_type AS current_state,
  event_source,
  event_at AS state_changed_at
FROM workspace.vthacks_2026.application_events
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY application_id
  ORDER BY event_at DESC, event_id DESC
) = 1;

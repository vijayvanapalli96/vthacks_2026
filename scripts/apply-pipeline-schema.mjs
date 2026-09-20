/**
 * apply-pipeline-schema.mjs — apply SECTION 8 (the application pipeline) to
 * workspace.vthacks_2026, idempotently.
 *
 * Why a script and not just `sql/schema.sql`: `ADD COLUMNS IF NOT EXISTS` and
 * `ADD COLUMN IF NOT EXISTS` are BOTH parse errors on this warehouse, so the
 * ALTER that adds user_id/note to application_events is NOT idempotent and will
 * fail on a second run. This script does the DESCRIBE first and skips the ALTER
 * if the columns are already there, which makes the whole of SECTION 8 safe to
 * re-run. The DDL text here and in sql/schema.sql §8 are the same text.
 *
 *   node scripts/apply-pipeline-schema.mjs           # apply, then read back
 *   node scripts/apply-pipeline-schema.mjs --check   # read back only, no DDL
 *   node scripts/apply-pipeline-schema.mjs --print   # print the DDL, no network
 */
import { FQ, objects, sql } from './lib/dbsql.mjs';

const CHECK_ONLY = process.argv.includes('--check');
const PRINT_ONLY = process.argv.includes('--print');

/** Columns SECTION 8 adds to application_events. */
export const NEW_COLUMNS = [
  { name: 'user_id', type: 'STRING', comment: 'users.user_id — the pipeline is per-user' },
  { name: 'note', type: 'STRING', comment: "the user's own words about this stage" },
];

/**
 * The seven pipeline stages, plus the two pre-existing machine event types that
 * IMPLY a stage. Must stay in lockstep with PIPELINE_STATUSES / IMPLIED_STAGE in
 * app/vthacks-career-app/src/lib/pipeline.ts — the view and the writer have to
 * agree on the vocabulary or a written row becomes invisible.
 */
export const STAGE_EVENT_TYPES = [
  'saved',
  'applied',
  'interviewing',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
  'submitted', // A2A apply path -> applied
  'callback', //  employer replied  -> interviewing
];

export function alterSql(missing) {
  const clauses = missing
    .map((c) => `  ${c.name} ${c.type} COMMENT '${c.comment.replace(/'/g, "''")}'`)
    .join(',\n');
  return `ALTER TABLE ${FQ}.application_events ADD COLUMNS (\n${clauses}\n)`;
}

/**
 * latest_application_state — REPLACED, not created. It already existed (built
 * 2026-09-19 by vijayvanapalli96@gmail.com) partitioned by `application_id`
 * alone, with no user_id, over a table that was empty and had no writers. That
 * shape cannot serve a per-user board.
 *
 * This definition is a SUPERSET of the old one: `application_id`, `job_id`,
 * `current_state`, `event_source` and `state_changed_at` all keep their old
 * names and types, so a consumer written against the shape in
 * docs/FEATURE_LIST.md still resolves. Three things change, all deliberate:
 *
 *  1. PARTITION BY (user_id, job_id) instead of application_id. For every row
 *     this feature writes the two are equivalent, because application_id is
 *     derived as sha256(user_id|job_id) — see applicationId() in src/lib/pipeline.ts.
 *  2. submitted -> applied and callback -> interviewing are NORMALISED, so a
 *     stage set by the A2A apply path shows up on the board instead of being a
 *     row nobody renders.
 *  3. Non-stage activity (viewed, tailored, verified, refused) is EXCLUDED, so
 *     viewing a job you already marked "interviewing" cannot demote it.
 *
 * The tiebreak is (event_at DESC, event_id DESC), not event_at alone: a UI click
 * and a voice tool firing together land in the same second, and a
 * non-deterministic ROW_NUMBER() would make the board flicker between renders.
 */
export const VIEW_SQL = `CREATE OR REPLACE VIEW ${FQ}.latest_application_state (
  user_id          COMMENT 'users.user_id. The pipeline is per-user.',
  job_id           COMMENT 'job_snapshots.job_id',
  application_id   COMMENT 'sha256(user_id|job_id) for rows this app writes',
  current_state    COMMENT 'Normalised pipeline stage: saved|applied|interviewing|offer|accepted|rejected|withdrawn',
  event_type       COMMENT 'The raw event_type as written, before normalisation',
  event_source     COMMENT 'ui | voice | (older vocabulary: user|gmail|workflow|integration)',
  state_changed_at COMMENT 'When the current stage was entered',
  note             COMMENT 'The user''s own words about this stage, if any',
  metadata_json    COMMENT 'Writer-supplied context, incl. previous_status',
  event_id         COMMENT 'The winning event. Also the deterministic tiebreak.',
  first_seen_at    COMMENT 'event_at of the FIRST pipeline event for this (user, job)',
  events_total     COMMENT 'How many pipeline events this (user, job) has. >1 proves the log appended.'
) AS
SELECT user_id,
       job_id,
       application_id,
       CASE event_type
         WHEN 'submitted' THEN 'applied'
         WHEN 'callback'  THEN 'interviewing'
         ELSE event_type
       END AS current_state,
       event_type,
       event_source,
       event_at AS state_changed_at,
       note,
       metadata_json,
       event_id,
       first_seen_at,
       events_total
  FROM (
    SELECT e.*,
           MIN(e.event_at) OVER (PARTITION BY e.user_id, e.job_id) AS first_seen_at,
           COUNT(1)        OVER (PARTITION BY e.user_id, e.job_id) AS events_total,
           ROW_NUMBER()    OVER (
             PARTITION BY e.user_id, e.job_id
             ORDER BY e.event_at DESC, e.event_id DESC
           ) AS rn
      FROM ${FQ}.application_events e
     WHERE e.user_id    IS NOT NULL
       AND e.job_id     IS NOT NULL
       AND e.event_type IN (${STAGE_EVENT_TYPES.map((t) => `'${t}'`).join(', ')})
  )
 WHERE rn = 1`;

async function describeColumns(table) {
  const result = await sql(`DESCRIBE TABLE ${FQ}.${table}`);
  return objects(result)
    .map((row) => row.col_name)
    .filter((name) => name && !name.startsWith('#'));
}

async function main() {
  if (PRINT_ONLY) {
    console.log(alterSql(NEW_COLUMNS));
    console.log(';\n');
    console.log(VIEW_SQL);
    return;
  }

  const before = await describeColumns('application_events');
  console.log('application_events columns BEFORE:', before.join(', '));

  const missing = NEW_COLUMNS.filter((column) => !before.includes(column.name));

  if (CHECK_ONLY) {
    console.log(
      missing.length ? `ALTER still needed: ${missing.map((c) => c.name).join(', ')}` : 'ALTER: already applied',
    );
  } else if (missing.length === 0) {
    console.log('ALTER: skipped, user_id and note already present (this is why we DESCRIBE first)');
  } else {
    await sql(alterSql(missing));
    console.log(`ALTER: added ${missing.map((c) => c.name).join(', ')}`);
  }

  if (!CHECK_ONLY) {
    await sql(VIEW_SQL);
    console.log('VIEW: latest_application_state replaced');
  }

  // Read-back proof, not an assumption that the DDL did what it said.
  console.log('application_events columns AFTER :', (await describeColumns('application_events')).join(', '));
  console.log('latest_application_state columns  :', (await describeColumns('latest_application_state')).join(', '));

  // Two scalar subqueries in a SELECT with no GROUP BY — safe. A scalar subquery
  // NEXT TO a GROUP BY is what raises SCALAR_SUBQUERY_IS_IN_GROUP_BY_OR_AGGREGATE_FUNCTION.
  const counts = await sql(
    `SELECT (SELECT COUNT(1) FROM ${FQ}.application_events)       AS events,
            (SELECT COUNT(1) FROM ${FQ}.latest_application_state) AS view_rows`,
  );
  console.log('row counts:', objects(counts)[0]);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

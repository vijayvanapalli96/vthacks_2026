/**
 * pipeline.ts — the application pipeline's data layer. SERVER ONLY.
 *
 * The vocabulary lives next door in pipeline-contract.ts, which has no runtime
 * imports so a client component can use it. This file is the half that touches
 * `node:crypto` and the warehouse.
 *
 * EVENT-SOURCED. Marking a status APPENDS a row to
 * `workspace.vthacks_2026.application_events`; the current stage is the
 * `latest_application_state` view over it. There is no status column, and nothing
 * in this file issues an UPDATE, a DELETE or a MERGE — scripts/verify-pipeline.mjs
 * greps for exactly that and fails if it ever changes.
 *
 * Same shape as profile_memory + profile_current (sql/schema.sql §3), which is the
 * house pattern. What it buys: undo is another event, "6 days in Applied with no
 * reply" is arithmetic rather than a cron job, and the history IS the audit trail.
 *
 * ONE WRITE PATH — CLAUDE.md hard rule 5. `markStatus` is reached by the board's
 * <select> and by the voice tool router through the same POST /api/pipeline/status,
 * differing only in `source`. There is deliberately no second writer.
 *
 * EVERY value is bound as a NAMED SQL PARAMETER. `note` is free text from a human
 * or from a speech transcript; interpolating it would be an injection.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { SqlParam, SqlResult } from '@/lib/databricks';
import {
  emptyBoard,
  toStage,
  type PipelineBoard,
  type PipelineSource,
  type PipelineStatus,
} from '@/lib/pipeline-contract';

const FQ = 'workspace.vthacks_2026';

/**
 * application_id, derived rather than invented.
 *
 * There is no `applications` table, but application_events has an
 * `application_id` column and the view that already existed partitioned on it.
 * Deriving it as sha256(user_id|job_id) makes "one application per user per job"
 * true by construction, and makes PARTITION BY application_id and
 * PARTITION BY (user_id, job_id) equivalent for every row this feature writes —
 * which is what makes replacing that view a widening rather than a change of
 * meaning. The uniqueness comes from the derivation, never from a Delta
 * constraint: those are informational and not enforced (sql/schema.sql header).
 */
export function applicationId(userId: string, jobId: string): string {
  return createHash('sha256').update(`${userId}|${jobId}`).digest('hex').slice(0, 32);
}

/** The `sql` function from @/lib/databricks, injected so this module is testable without a warehouse. */
export type SqlFn = (statement: string, parameters?: SqlParam[]) => Promise<SqlResult>;

/** Rows as objects keyed by column name. */
function objects(result: SqlResult): Record<string, string | null>[] {
  return result.rows.map((row) => {
    const out: Record<string, string | null> = {};
    result.columns.forEach((name, index) => {
      out[name] = row[index] ?? null;
    });
    return out;
  });
}

export type MarkResult = {
  ok: true;
  job_id: string;
  status: PipelineStatus;
  /** The stage this job was in before. null the first time it is marked. */
  previous_status: PipelineStatus | null;
  /** ISO 8601 — the event_at that was written. */
  at: string;
};

/** `job_id` did not resolve against job_snapshots. The voice agent's model can hallucinate one. */
export class UnknownJobError extends Error {
  constructor(public readonly jobId: string) {
    super(`job_id ${jobId} is not in job_snapshots`);
    this.name = 'UnknownJobError';
  }
}

/**
 * Append one status event. THE one write path.
 *
 * Two statements, deliberately in this order:
 *
 *  1. Validate job_id against job_snapshots AND read the current stage, in one
 *     round trip. Both are scalar subqueries in a SELECT with no FROM and no
 *     GROUP BY — a scalar subquery sitting NEXT TO a GROUP BY is what raises
 *     SCALAR_SUBQUERY_IS_IN_GROUP_BY_OR_AGGREGATE_FUNCTION, which is also why the
 *     board's counts are a reduce in TypeScript instead of a GROUP BY.
 *  2. INSERT. Never MERGE, never UPDATE: the row is a fact that happened.
 *
 * `previous_status` is read rather than inferred because it is what lets a caller
 * say "moved from applied to interviewing" in one sentence instead of guessing.
 * Read-then-append is not transactional, so two writes racing can both report the
 * same previous stage. That is acceptable and cannot corrupt anything: both events
 * are still appended, and the view's (event_at DESC, event_id DESC) ordering still
 * picks one deterministic winner. What degrades is a label on a response, not data.
 */
export async function markStatus(
  sql: SqlFn,
  input: {
    userId: string;
    jobId: string;
    status: PipelineStatus;
    note?: string | null;
    source: PipelineSource;
  },
): Promise<MarkResult> {
  const { userId, jobId, status, source } = input;
  // Trimmed to null: an empty note and no note are the same fact, and a row of
  // whitespace renders as a blank line on the card.
  const note = input.note?.trim() ? input.note.trim() : null;

  const probe = await sql(
    `SELECT (SELECT COUNT(1) FROM ${FQ}.job_snapshots WHERE job_id = :job_id) AS job_count,
            (SELECT current_state
               FROM ${FQ}.latest_application_state
              WHERE user_id = :user_id AND job_id = :job_id) AS previous_status`,
    [
      { name: 'job_id', value: jobId },
      { name: 'user_id', value: userId },
    ],
  );
  const probed = objects(probe)[0] ?? {};
  // COUNT(1) arrives as a STRING — every cell from the Statement Execution API
  // does, including BOOLEANs, which come back as "true"/"false" and would pass a
  // truthiness check either way. So: compare a number explicitly.
  if (Number(probed.job_count ?? '0') === 0) throw new UnknownJobError(jobId);
  const previous = toStage(probed.previous_status);

  const at = new Date().toISOString();

  await sql(
    `INSERT INTO ${FQ}.application_events
       (event_id, application_id, user_id, job_id, event_type, event_source, event_at, note, metadata_json)
     VALUES (:event_id, :application_id, :user_id, :job_id, :event_type, :event_source,
             CAST(:event_at AS TIMESTAMP), :note, :metadata_json)`,
    [
      { name: 'event_id', value: randomUUID() },
      { name: 'application_id', value: applicationId(userId, jobId) },
      { name: 'user_id', value: userId },
      { name: 'job_id', value: jobId },
      { name: 'event_type', value: status },
      { name: 'event_source', value: source },
      { name: 'event_at', value: at },
      // Free text from a human or a transcript. Bound, never interpolated.
      { name: 'note', value: note },
      { name: 'metadata_json', value: JSON.stringify({ previous_status: previous, feature: 'pipeline' }) },
    ],
  );

  return { ok: true, job_id: jobId, status, previous_status: previous, at };
}

function wholeDaysSince(value: string | null): number | null {
  if (!value) return null;
  // Databricks renders a TIMESTAMP as "2026-09-19 14:03:11.2" with a space and no
  // zone. Date.parse handles the ISO form; normalise to that and treat the naive
  // stamp as UTC, which is what the warehouse stores.
  const normalised = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const then = Date.parse(normalised);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

/**
 * Read the whole board for one user. ONE statement.
 *
 * `days_in_stage` is computed here, not in SQL, so the number cannot drift between
 * a server render and a client refetch of the same view row. The counts are a
 * reduce in TypeScript for the reason named in markStatus.
 *
 * `matches` is an optional job_id -> {score, reason} map from
 * readCachedRun(sql, userId) in @/lib/match/run.mjs. Injected rather than read
 * here so the board still renders when the match cache is cold or empty — the
 * common case for a new account, and not an error.
 */
export async function readBoard(
  sql: SqlFn,
  userId: string,
  matches?: Map<string, { score: number | null; reason: string | null }>,
): Promise<PipelineBoard> {
  const result = await sql(
    `SELECT s.job_id,
            s.current_state,
            s.note,
            s.events_total,
            CAST(s.state_changed_at AS STRING) AS state_changed_at,
            CAST(s.first_seen_at    AS STRING) AS first_seen_at,
            j.job_title,
            j.company_name,
            j.location_text,
            j.source_url
       FROM ${FQ}.latest_application_state s
       LEFT JOIN ${FQ}.job_snapshots j ON j.job_id = s.job_id
      WHERE s.user_id = :user_id
      ORDER BY s.state_changed_at DESC, s.event_id DESC`,
    [{ name: 'user_id', value: userId }],
  );

  const board = emptyBoard();
  for (const row of objects(result)) {
    const status = toStage(row.current_state);
    // A row whose stage is not in the whitelist is SKIPPED, not guessed at. The
    // view already filters these out; this is the belt to that braces, and it
    // means widening the view can never render an unlabelled column.
    if (!status || !row.job_id) continue;
    const match = matches?.get(row.job_id);
    board.stages[status].push({
      job_id: row.job_id,
      status,
      title: row.job_title,
      company: row.company_name,
      location: row.location_text,
      source_url: row.source_url,
      status_changed_at: row.state_changed_at,
      days_in_stage: wholeDaysSince(row.state_changed_at),
      days_tracked: wholeDaysSince(row.first_seen_at),
      events_total: Number(row.events_total ?? '1'),
      note: row.note,
      match_score: match?.score ?? null,
      match_reason: match?.reason ?? null,
    });
    board.counts[status] += 1;
    board.total += 1;
  }
  return board;
}

/**
 * The full event history for one job, newest first.
 *
 * Read-only, and it deliberately INCLUDES the non-stage activity the view filters
 * out — a timeline is exactly where "you viewed this, then tailored it, then
 * applied" belongs, even though none of those are columns on the board.
 */
export type PipelineEvent = {
  event_id: string;
  event_type: string;
  event_source: string | null;
  at: string;
  note: string | null;
};

export async function readHistory(sql: SqlFn, userId: string, jobId: string): Promise<PipelineEvent[]> {
  const result = await sql(
    `SELECT event_id, event_type, event_source, note, CAST(event_at AS STRING) AS at
       FROM ${FQ}.application_events
      WHERE user_id = :user_id AND job_id = :job_id
      ORDER BY event_at DESC, event_id DESC`,
    [
      { name: 'user_id', value: userId },
      { name: 'job_id', value: jobId },
    ],
  );
  return objects(result).map((row) => ({
    event_id: row.event_id ?? '',
    event_type: row.event_type ?? '',
    event_source: row.event_source,
    at: row.at ?? '',
    note: row.note,
  }));
}

/**
 * Match score and reason per job_id, from the match agent's cache.
 *
 * Uses the already-exported readCachedRun rather than a second reader, so the
 * board and /api/match can never disagree about a score. A cold cache returns
 * null and the board renders without scores, which is correct — a pipeline card
 * is useful with or without a match number.
 *
 * Never throws. A broken match cache must not take down the pipeline board.
 */
export async function readMatchMap(
  sql: SqlFn,
  userId: string,
): Promise<Map<string, { score: number | null; reason: string | null }>> {
  const map = new Map<string, { score: number | null; reason: string | null }>();
  try {
    const { readCachedRun } = (await import('@/lib/match/run.mjs')) as {
      readCachedRun: (
        sql: SqlFn,
        userId: string,
      ) => Promise<{ matches?: { job_id?: string; score?: number; reason?: string }[] } | null>;
    };
    const cached = await readCachedRun(sql, userId);
    for (const match of cached?.matches ?? []) {
      if (!match.job_id) continue;
      map.set(match.job_id, {
        score: typeof match.score === 'number' ? match.score : null,
        reason: typeof match.reason === 'string' && match.reason.trim() ? match.reason : null,
      });
    }
  } catch {
    // Cold cache, no run yet, or a match-lane change. Scores are additive on this
    // page; swallowing here is what keeps the board independent of that lane.
  }
  return map;
}

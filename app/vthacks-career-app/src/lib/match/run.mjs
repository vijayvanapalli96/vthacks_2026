/**
 * run.mjs — the match agent, end to end. Stage 1, the gate, stage 2, the writes.
 *
 * ONE code path. The Next route (`/api/match`) and the CLI
 * (`scripts/match-run.mjs`) both call `runMatch()` and differ only in which `sql`
 * client they inject. That is hard rule 5 applied one level down: voice and UI
 * already share the endpoint, and the endpoint and the operator tooling share
 * this function, so "everything you can say, you can type" cannot quietly stop
 * being true because an operator script grew its own copy of the pipeline.
 *
 * RE-RUN BEHAVIOUR — the decision, stated. **A re-run REUSES THE CACHE by
 * default and writes nothing.** `match_evaluations` exists to be that cache
 * (MATCH_AGENT_PLAN.md decisions table: "On demand, result cached in
 * `match_evaluations`. No precompute cron. That table exists to be the cache").
 * So:
 *
 *   * within CACHE_TTL_MINUTES, a second call returns the stored rows, spends
 *     ZERO model calls, and inserts ZERO rows. Row count before == after.
 *   * `refresh: true` re-scores. It DELETES this user's previous
 *     `match_evaluations` rows inside the same run before inserting the new
 *     ones, so the cache holds at most one row per (user_id, job_id) and a
 *     re-score can never accumulate near-duplicate rows that differ only by
 *     run_id.
 *
 * The audit trail is NOT lost by that delete: `match_runs` keeps one row per run
 * forever, with the counts. The cache holds current answers; the run log holds
 * history. Conflating the two is what makes a cache impossible to reason about.
 *
 * `profile_memory` is APPEND-ONLY and is never written here at all — not even
 * appended to. Recording a match outcome as a memory fact is a real idea and a
 * separate deliverable; doing it as a side effect of a read-shaped endpoint is
 * how an append-only table becomes untrustworthy.
 *
 * `job_snapshots` is WRITE-ONCE and is only ever SELECTed. `description_text`
 * and `raw_payload_json` appear in no UPDATE anywhere in this module, because
 * there is no UPDATE anywhere in this module.
 */
import { randomUUID } from 'node:crypto';
import { buildEmbedText, loadProfile } from './profile.mjs';
import {
  DEFAULT_FRESHNESS_DAYS,
  RERANK_LIMIT,
  RETRIEVAL_POOL,
  rankCandidates,
  retrieveCandidates,
} from './retrieve.mjs';
import { MODEL_NAME, MODEL_PROVIDER, rerank } from './rerank.mjs';

const FQ = 'workspace.vthacks_2026';

/**
 * How long a cached result is considered current.
 *
 * 45 minutes, because the job pipeline ingests hourly — a shorter TTL re-scores
 * against an unchanged corpus and pays 20 model calls for an identical answer,
 * and a longer one outlives the data it was computed from.
 */
export const CACHE_TTL_MINUTES = 45;

/**
 * Hard cap on rows written per INSERT statement.
 *
 * The API rejects a statement whose combined BOUND PARAMETERS exceed 1,048,576
 * characters, and the job pipeline hit that limit for real. 20 evaluation rows is
 * roughly 30 KB, so this never fires today; it exists so that raising
 * RERANK_LIMIT cannot silently produce a request the API refuses.
 */
const WRITE_CHUNK_ROWS = 50;

const EVAL_ROW_SCHEMA = `ARRAY<STRUCT<
  evaluation_id: STRING, job_id: STRING, user_id: STRING,
  overall_score: DOUBLE, recommendation: STRING, explanation_text: STRING,
  requirement_scores_json: STRING, retrieval_rank: INT, similarity: DOUBLE,
  skills_matched: ARRAY<STRING>, skills_missing: ARRAY<STRING>,
  courses_matched: ARRAY<STRING>, eligibility: STRING, eligibility_reason: STRING>>`;

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Shape one scored candidate as the public `/api/match` contract requires. */
function toMatchContract(row) {
  return {
    // The six fields TASK_DIVISION.md §4 names, spelled exactly as it spells
    // them. Everything after them is additive; renaming one of these breaks
    // Nidhi's fixture contract and the voice tool router with it.
    job_id: row.job_id,
    company: row.company_name,
    title: row.job_title,
    score: row.overall_score,
    matched_skills: row.skills_matched,
    missing_skills: row.skills_missing,
    reason: row.explanation_text,
    // Additive.
    recommendation: row.recommendation,
    similarity: row.similarity,
    retrieval_rank: row.retrieval_rank,
    courses_matched: row.courses_matched,
    eligibility: row.eligibility,
    eligibility_reason: row.eligibility_reason,
    location: row.location_text ?? null,
    source: row.source ?? null,
    source_url: row.source_url ?? null,
    posted_at: row.posted_at ?? null,
    requirement_scores: row.requirement_scores ?? [],
  };
}

/**
 * Read the cached result for a user, or null.
 *
 * Keyed on the most recent SUCCEEDED run for that user inside the TTL. Keyed on
 * the run rather than on a per-row timestamp because a run is the atomic unit: a
 * half-written run must never be served as if it were complete, and
 * `finished_at IS NOT NULL` is what distinguishes the two.
 *
 * @param {import('./profile.mjs').SqlFn} sql
 */
export async function readCachedRun(sql, userId, ttlMinutes = CACHE_TTL_MINUTES) {
  const result = await sql(
    `WITH latest AS (
       SELECT run_id, started_at, finished_at, candidates_total, after_filters,
              after_similarity, reranked, written, dropped_ineligible
         FROM ${FQ}.match_runs
        WHERE user_id = :user_id
          AND finished_at IS NOT NULL
          AND error_message IS NULL
          AND started_at >= current_timestamp() - make_dt_interval(0, 0, :ttl, 0)
        ORDER BY started_at DESC
        LIMIT 1
     )
     SELECT l.run_id, l.candidates_total, l.after_filters, l.after_similarity,
            l.reranked, l.written, l.dropped_ineligible,
            CAST(l.started_at AS STRING) AS started_at,
            m.job_id, s.company_name, s.job_title, s.location_text, s.source,
            s.source_url, CAST(s.posted_at AS STRING) AS posted_at,
            CAST(m.overall_score AS DOUBLE) AS overall_score, m.recommendation,
            m.explanation_text, m.requirement_scores_json, m.retrieval_rank,
            m.similarity, m.skills_matched, m.skills_missing, m.courses_matched,
            m.eligibility, m.eligibility_reason
       FROM latest l
       JOIN ${FQ}.match_evaluations m ON m.run_id = l.run_id
       LEFT JOIN ${FQ}.job_snapshots s ON s.job_id = m.job_id
      -- Must match rerank.mjs's sort EXACTLY. It did not, and that is a bug a
      -- consumer would experience as "/api/match returns a different order the
      -- second time you call it": the fresh path sorts by the model's score and
      -- the cached path was sorting by retrieval_rank, so Gusto/75 led a cached
      -- response while Pinterest/85 led an identical fresh one. A cache that
      -- reorders is not a cache.
      ORDER BY m.overall_score DESC, m.retrieval_rank`,
    [
      { name: 'user_id', value: userId },
      { name: 'ttl', value: String(ttlMinutes), type: 'DOUBLE' },
    ],
  );
  if (result.rows.length === 0) return null;

  const i = Object.fromEntries(result.columns.map((c, k) => [c, k]));
  const parse = (v) => {
    if (typeof v !== 'string' || !v.trim()) return [];
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  };
  const first = result.rows[0];
  return {
    run_id: first[i.run_id],
    cached: true,
    started_at: first[i.started_at],
    stats: {
      candidates_total: Number(first[i.candidates_total] ?? 0),
      after_filters: Number(first[i.after_filters] ?? 0),
      after_similarity: Number(first[i.after_similarity] ?? 0),
      reranked: Number(first[i.reranked] ?? 0),
      written: Number(first[i.written] ?? 0),
      dropped_ineligible: Number(first[i.dropped_ineligible] ?? 0),
      model_calls_this_request: 0,
    },
    matches: result.rows.map((row) =>
      toMatchContract({
        job_id: row[i.job_id],
        company_name: row[i.company_name],
        job_title: row[i.job_title],
        location_text: row[i.location_text],
        source: row[i.source],
        source_url: row[i.source_url],
        posted_at: row[i.posted_at],
        overall_score: Number(row[i.overall_score] ?? 0),
        recommendation: row[i.recommendation],
        explanation_text: row[i.explanation_text],
        requirement_scores: parse(row[i.requirement_scores_json]),
        retrieval_rank: Number(row[i.retrieval_rank] ?? 0),
        similarity: Number(row[i.similarity] ?? 0),
        skills_matched: parse(row[i.skills_matched]),
        skills_missing: parse(row[i.skills_missing]),
        courses_matched: parse(row[i.courses_matched]),
        eligibility: row[i.eligibility],
        eligibility_reason: row[i.eligibility_reason],
      }),
    ),
    filtered_ineligible: [],
  };
}

/**
 * Run the match agent for one user.
 *
 * @param {{
 *   sql: import('./profile.mjs').SqlFn,
 *   userId: string,
 *   refresh?: boolean,
 *   freshnessDays?: number,
 *   pool?: number,
 *   limit?: number,
 *   goalsOverride?: Record<string, unknown>|null,
 *   persist?: boolean,
 *   onProgress?: (message: string) => void
 * }} args
 */
export async function runMatch({
  sql,
  userId,
  refresh = false,
  freshnessDays = DEFAULT_FRESHNESS_DAYS,
  pool = RETRIEVAL_POOL,
  limit = RERANK_LIMIT,
  goalsOverride = null,
  persist = true,
  onProgress = () => {},
}) {
  if (!userId) throw new Error('runMatch needs a userId');

  if (!refresh) {
    const cached = await readCachedRun(sql, userId);
    if (cached) {
      onProgress(`cache hit: run ${cached.run_id}, ${cached.matches.length} matches, 0 model calls`);
      return cached;
    }
  }

  const runId = randomUUID();
  const startedAt = Date.now();
  onProgress(`run ${runId} starting for user ${userId}`);

  // The run row is opened BEFORE any work, with finished_at NULL. A crash then
  // leaves a visibly unfinished run rather than no trace at all, and the cache
  // reader's `finished_at IS NOT NULL` means a half-run is never served.
  await sql(
    `INSERT INTO ${FQ}.match_runs
       (run_id, user_id, started_at, model_provider, model_name)
     VALUES (:run_id, :user_id, current_timestamp(), :provider, :model)`,
    [
      { name: 'run_id', value: runId },
      { name: 'user_id', value: userId },
      { name: 'provider', value: MODEL_PROVIDER },
      { name: 'model', value: MODEL_NAME },
    ],
  );

  try {
    const profile = await loadProfile(sql, userId);
    if (goalsOverride) {
      // The CLI can supply goals for a user whose `goals` row does not exist yet.
      // The voice lane owns that table and it is empty in the workspace today, so
      // without this the eligibility gate could not be exercised against real
      // postings without writing a teammate's preferences row. Merged over, never
      // written back.
      profile.goals = { ...(profile.goals ?? {}), ...goalsOverride };
      // Rebuilt, not left stale: buildEmbedText folds target_roles into the text
      // that gets embedded, so an override that changes them and not the
      // embedding would rank against the old intent.
      profile.embedText = buildEmbedText({
        summary: profile.summary,
        headline: null,
        location: profile.location,
        claimedSkills: profile.claimedSkills,
        targetRoles: Array.isArray(profile.goals.target_roles) ? profile.goals.target_roles : [],
      });
    }
    onProgress(
      `profile: ${profile.claimedSkills.length} skills, ${profile.courses.length} courses, ` +
        `goals ${profile.goals ? 'present' : 'ABSENT (no goals row)'}`,
    );

    const candidatesTotal = Number(
      (await sql(`SELECT COUNT(*) FROM ${FQ}.job_embeddings`)).rows[0][0],
    );

    const { rows, afterFilters } = await retrieveCandidates(sql, profile, {
      freshnessDays,
      pool,
    });
    onProgress(
      `stage 1: ${candidatesTotal} embedded jobs -> ${afterFilters} past hard filters -> ` +
        `${rows.length} in the cosine pool`,
    );

    const gated = rankCandidates(rows, profile, { limit });
    onProgress(
      `gate: ${gated.ineligible.length} dropped ineligible, ${gated.unknownEligibility} unknown (kept), ` +
        `${gated.eligibleTotal} eligible -> top ${gated.top.length} to rerank`,
    );

    const { scored, modelCalls, droppedNoReason } = await rerank(sql, profile, gated.top);
    onProgress(
      `stage 2: ${modelCalls} model calls, ${scored.length} scored, ` +
        `${droppedNoReason.length} dropped for having no usable reason`,
    );

    let written = 0;
    if (persist && scored.length > 0) {
      written = await writeEvaluations(sql, runId, userId, scored, { replaceUserRows: true });
    }

    await sql(
      `UPDATE ${FQ}.match_runs
          SET finished_at = current_timestamp(),
              candidates_total = :candidates_total,
              after_filters = :after_filters,
              after_similarity = :after_similarity,
              reranked = :reranked,
              written = :written,
              dropped_ineligible = :dropped_ineligible
        WHERE run_id = :run_id`,
      [
        { name: 'candidates_total', value: String(candidatesTotal), type: 'INT' },
        { name: 'after_filters', value: String(gated.eligibleTotal), type: 'INT' },
        { name: 'after_similarity', value: String(gated.top.length), type: 'INT' },
        { name: 'reranked', value: String(modelCalls), type: 'INT' },
        { name: 'written', value: String(written), type: 'INT' },
        { name: 'dropped_ineligible', value: String(gated.ineligible.length), type: 'INT' },
        { name: 'run_id', value: runId },
      ],
    );

    return {
      run_id: runId,
      cached: false,
      started_at: new Date(startedAt).toISOString(),
      stats: {
        candidates_total: candidatesTotal,
        after_sql_filters: afterFilters,
        cosine_pool: rows.length,
        after_filters: gated.eligibleTotal,
        after_similarity: gated.top.length,
        reranked: modelCalls,
        written,
        dropped_ineligible: gated.ineligible.length,
        dropped_no_reason: droppedNoReason.length,
        unknown_eligibility: gated.unknownEligibility,
        model_calls_this_request: modelCalls + 1, // + the one profile embedding
        wall_clock_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      },
      matches: scored.map(toMatchContract),
      // Surfaced, never hidden. A student is entitled to know a role was removed
      // and why — that is the difference between a filter and a disappearance.
      filtered_ineligible: gated.ineligible.map((r) => ({
        job_id: r.job_id,
        company: r.company_name,
        title: r.job_title,
        reason: r.eligibility_reason,
      })),
      dropped_no_reason: droppedNoReason,
    };
  } catch (error) {
    const message = error?.message ?? String(error);
    await sql(
      `UPDATE ${FQ}.match_runs
          SET finished_at = current_timestamp(), error_message = :message
        WHERE run_id = :run_id`,
      [
        { name: 'message', value: message.slice(0, 2_000) },
        { name: 'run_id', value: runId },
      ],
    ).catch(() => {});
    throw error;
  }
}

/**
 * Write evaluation rows.
 *
 * `replaceUserRows` DELETEs this user's existing rows first. That is what makes a
 * re-score idempotent in the only sense that matters for a cache: one row per
 * (user_id, job_id), never an accumulating pile that differs only by run_id.
 * Unity Catalog PRIMARY KEYs are INFORMATIONAL and Delta does not enforce them
 * (sql/schema.sql says so at the top), so uniqueness has to be arranged, not
 * declared.
 *
 * @param {import('./profile.mjs').SqlFn} sql
 * @returns {Promise<number>} rows written
 */
export async function writeEvaluations(sql, runId, userId, scored, { replaceUserRows } = {}) {
  if (replaceUserRows) {
    await sql(`DELETE FROM ${FQ}.match_evaluations WHERE user_id = :user_id`, [
      { name: 'user_id', value: userId },
    ]);
  }

  let written = 0;
  for (const batch of chunk(scored, WRITE_CHUNK_ROWS)) {
    const payload = batch.map((row) => ({
      evaluation_id: randomUUID(),
      job_id: row.job_id,
      user_id: userId,
      overall_score: row.overall_score,
      recommendation: row.recommendation,
      explanation_text: row.explanation_text,
      requirement_scores_json: JSON.stringify(row.requirement_scores ?? []),
      retrieval_rank: row.retrieval_rank,
      similarity: row.similarity,
      skills_matched: row.skills_matched,
      skills_missing: row.skills_missing,
      courses_matched: row.courses_matched,
      eligibility: row.eligibility,
      eligibility_reason: row.eligibility_reason,
    }));

    await sql(
      `INSERT INTO ${FQ}.match_evaluations
         (evaluation_id, job_id, candidate_profile_id, model_provider, model_name,
          overall_score, recommendation, explanation_text, requirement_scores_json,
          created_at, run_id, user_id, retrieval_rank, similarity,
          skills_matched, skills_missing, courses_matched, eligibility, eligibility_reason)
       SELECT r.evaluation_id, r.job_id, r.user_id, :provider, :model,
              r.overall_score, r.recommendation, r.explanation_text,
              r.requirement_scores_json, current_timestamp(), :run_id, r.user_id,
              r.retrieval_rank, r.similarity, r.skills_matched, r.skills_missing,
              r.courses_matched, r.eligibility, r.eligibility_reason
         FROM (SELECT explode(from_json(:rows, '${EVAL_ROW_SCHEMA}')) AS r)`,
      [
        { name: 'rows', value: JSON.stringify(payload) },
        { name: 'provider', value: MODEL_PROVIDER },
        { name: 'model', value: MODEL_NAME },
        { name: 'run_id', value: runId },
      ],
    );
    written += batch.length;
  }
  return written;
}

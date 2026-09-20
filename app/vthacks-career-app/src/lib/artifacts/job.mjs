/**
 * job.mjs — load and VALIDATE one posting.
 *
 * Every endpoint in this feature starts here. `jobId` arrives from a URL
 * segment, which means it arrives from the open internet: it is checked against
 * `job_snapshots` on every single call, and the check is the same one every
 * time because it lives here rather than being re-written per route.
 *
 * `job_id` is bound as a NAMED PARAMETER. It is deterministic (derived from the
 * posting URL by career-ops' `url-key.mjs`, hard rule 2) and therefore looks
 * safe, but "looks like a hash" is not a validation strategy and the day
 * someone adds a slug fallback it stops being true.
 *
 * READS ONLY, and it has to stay that way: `job_snapshots` is WRITE-ONCE.
 * `description_text` and `raw_payload_json` must never appear in a SET list
 * (hard rule 2), so nothing here builds an UPDATE at all.
 */

/** @typedef {import('../match/profile.mjs').SqlFn} SqlFn */

/**
 * The shapes are declared as typedefs rather than left to inference for a
 * concrete reason: `loadContext` returns a DISCRIMINATED UNION on `ok`, and TS
 * widens a bare `ok: true` in an object literal to `boolean`, which silently
 * destroys narrowing at every call site. Annotating the union with literal types
 * is what makes `if (!context.ok) return` actually narrow the success branch.
 *
 * @typedef {{
 *   job_id: string,
 *   company_name: string|null,
 *   job_title: string|null,
 *   location_text: string|null,
 *   source: string|null,
 *   source_url: string|null,
 *   posted_at: string|null,
 *   discovered_at: string|null,
 *   description_text: string,
 *   description_chars: number,
 *   has_description: boolean,
 * }} JobSnapshot
 *
 * @typedef {{
 *   run_id: string|null,
 *   run_started_at: string|null,
 *   score: number,
 *   recommendation: string|null,
 *   reason: string|null,
 *   similarity: number,
 *   skills_matched: string[],
 *   skills_missing: string[],
 *   courses_matched: string[],
 *   eligibility: string|null,
 *   eligibility_reason: string|null,
 * }} CachedMatch
 */

const FQ = 'workspace.vthacks_2026';

/**
 * How much JD text a model call is allowed to carry.
 *
 * Postings run to 20k+ characters of benefits boilerplate and EEO statements,
 * and the requirements are always near the top. Capping is not only a cost
 * decision: an unbounded posting is an unbounded prompt, and an unbounded
 * prompt is an unbounded surface for the injection attempt the delimiter block
 * in `prompts.mjs` exists to contain.
 */
export const JD_PROMPT_CHARS = 6000;

/**
 * The posting, or null when `jobId` is not a real job.
 *
 * `null` and "a job with no description" are different answers and callers need
 * both: the first is a 404, the second is a posting we can still run the tier
 * read and the eligibility read against, and saying so is more useful than
 * refusing.
 *
 * @param {SqlFn} sql
 * @param {string} jobId
 * @returns {Promise<JobSnapshot|null>}
 */
export async function loadJob(sql, jobId) {
  const result = await sql(
    `SELECT job_id, company_name, job_title, location_text, source, source_url,
            CAST(posted_at AS STRING)     AS posted_at,
            CAST(discovered_at AS STRING) AS discovered_at,
            description_text
       FROM ${FQ}.job_snapshots
      WHERE job_id = :job_id
      LIMIT 1`,
    [{ name: 'job_id', value: jobId }],
  );
  if (result.rows.length === 0) return null;

  const index = Object.fromEntries(result.columns.map((c, i) => [c, i]));
  const row = result.rows[0];
  const description = String(row[index.description_text] ?? '');

  return {
    job_id: String(row[index.job_id]),
    company_name: row[index.company_name] ?? null,
    job_title: row[index.job_title] ?? null,
    location_text: row[index.location_text] ?? null,
    source: row[index.source] ?? null,
    source_url: row[index.source_url] ?? null,
    posted_at: row[index.posted_at] ?? null,
    discovered_at: row[index.discovered_at] ?? null,
    description_text: description,
    /**
     * Hard rule 4 reaches even here. A tool that returns "no requirements
     * found" needs to be able to say whether that is because the posting is
     * thin or because we failed to read it.
     */
    description_chars: description.length,
    has_description: description.trim().length > 200,
  };
}

/**
 * The one cached match row for this job, or null.
 *
 * Reads the same rows `readCachedRun` reads, but for ONE job rather than a whole
 * run, because the job page needs exactly one score and pulling a 20-row run
 * apart in the page would duplicate that module's cache semantics badly. The
 * TTL is deliberately NOT applied: a match written two hours ago is still the
 * reason this student is looking at this posting, and hiding it because a
 * 45-minute cache expired would replace a true sentence with silence. The row's
 * own timestamp is returned so the page can say how old it is.
 *
 * @param {SqlFn} sql
 * @param {string} userId
 * @param {string} jobId
 * @returns {Promise<CachedMatch|null>}
 */
export async function loadCachedMatchForJob(sql, userId, jobId) {
  const result = await sql(
    `SELECT CAST(m.overall_score AS DOUBLE) AS overall_score,
            m.recommendation, m.explanation_text,
            CAST(m.similarity AS DOUBLE) AS similarity,
            m.skills_matched, m.skills_missing, m.courses_matched,
            m.eligibility, m.eligibility_reason,
            CAST(r.started_at AS STRING) AS run_started_at, r.run_id
       FROM ${FQ}.match_evaluations m
       JOIN ${FQ}.match_runs r ON r.run_id = m.run_id
      WHERE m.user_id = :user_id AND m.job_id = :job_id
        AND r.finished_at IS NOT NULL AND r.error_message IS NULL
      ORDER BY r.started_at DESC
      LIMIT 1`,
    [
      { name: 'user_id', value: userId },
      { name: 'job_id', value: jobId },
    ],
  );
  if (result.rows.length === 0) return null;

  const index = Object.fromEntries(result.columns.map((c, i) => [c, i]));
  const row = result.rows[0];
  const parse = (value) => {
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  };

  return {
    run_id: row[index.run_id],
    run_started_at: row[index.run_started_at],
    score: Math.round(Number(row[index.overall_score] ?? 0)),
    recommendation: row[index.recommendation] ?? null,
    // The stored reason sentence, written at match time. Showing it costs ZERO
    // model calls, which is the whole reason the match agent stores it.
    reason: row[index.explanation_text] ?? null,
    similarity: Number(row[index.similarity] ?? 0),
    skills_matched: parse(row[index.skills_matched]),
    skills_missing: parse(row[index.skills_missing]),
    courses_matched: parse(row[index.courses_matched]),
    eligibility: row[index.eligibility] ?? null,
    eligibility_reason: row[index.eligibility_reason] ?? null,
  };
}

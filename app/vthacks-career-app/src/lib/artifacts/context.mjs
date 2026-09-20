/**
 * context.mjs — the four reads every endpoint in this feature needs, once.
 *
 * `analyze`, `generate` and the page itself all need the same four things: the
 * validated posting, the match profile, the fact source, and the cached match
 * row if there is one. Doing that assembly in each route would mean three
 * slightly different versions of `jobId` validation, and the one that drifts is
 * the one that stops validating.
 *
 * BATCHED. Four statements, issued in parallel, on a warehouse that bills by the
 * second while awake. The `jobId` check is not separable from the rest — a job
 * that does not exist makes the other three reads wasted, but serialising to
 * avoid that waste costs a full round trip on every legitimate request, and
 * legitimate requests are the common case by a wide margin.
 */

import { loadProfile } from '../match/profile.mjs';
import { loadJob, loadCachedMatchForJob } from './job.mjs';
import { loadFactSource } from './facts.mjs';

/**
 * The union is annotated with LITERAL `true` / `false` on purpose. TypeScript
 * widens a bare `ok: true` in an object literal to `boolean`, and a union
 * discriminated on a `boolean` does not narrow — so every consumer would see
 * `job: object` after its own `if (!context.ok) return`, and every field access
 * on the posting would be a type error. This annotation is the whole reason the
 * routes and the page can read `context.job.job_title` at all.
 *
 * @param {import('../match/profile.mjs').SqlFn} sql
 * @param {string} userId
 * @param {string} jobId
 * @returns {Promise<
 *   {ok: true,
 *    job: import('./job.mjs').JobSnapshot,
 *    profile: import('./facts.mjs').MatchProfile,
 *    facts: import('./facts.mjs').FactSource,
 *    cachedMatch: import('./job.mjs').CachedMatch|null}
 *   | {ok: false, status: number, error: string}
 * >}
 */
export async function loadContext(sql, userId, jobId) {
  // Shape check before anything is spent. `job_id` is a deterministic key
  // derived from the posting URL (hard rule 2), so it is long and it is not a
  // sentence; a 400 here costs nothing and keeps obvious junk off the warehouse.
  if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 256) {
    return { ok: false, status: 400, error: 'job_id is missing or not a plausible job id' };
  }

  const [job, profile, facts, cachedMatch] = await Promise.all([
    loadJob(sql, jobId),
    loadProfile(sql, userId),
    loadFactSource(sql, userId),
    loadCachedMatchForJob(sql, userId, jobId),
  ]);

  // THE VALIDATION. Every call, every endpoint. A posting that is not in
  // `job_snapshots` is a 404 and nothing downstream runs — not a model call, not
  // an artifacts insert. An artifact whose `job_id` has no posting behind it is
  // unreadable the moment anyone tries to display it.
  if (!job) {
    return {
      ok: false,
      status: 404,
      error: `No posting with that id exists in job_snapshots. Nothing was generated.`,
    };
  }

  return { ok: true, job, profile, facts, cachedMatch };
}

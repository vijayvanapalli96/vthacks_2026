/**
 * match-read.ts — the READ side of the match agent, for server components.
 *
 * `runMatch()` is the expensive path: one embedding plus up to 20 model calls.
 * This is the cheap one. It reads the last SUCCEEDED run inside
 * `CACHE_TTL_MINUTES` straight out of `match_evaluations`, so a page can render
 * a student's real ranked matches for ZERO model calls. That is the whole reason
 * `/applicant` does not auto-run a match on every visit: the automatic run
 * happens once, when intake finishes, and every page load afterwards reads this.
 *
 * WHY A THIN WRAPPER AND NOT INLINE IN THE PAGE. Two consumers already want it —
 * the `/applicant` match queue and `/applicant/jobs` — and the voice lane wants
 * it too, to answer "why am I a good match for this role" without a model call.
 * One exported function taking a `userId` is the seam that keeps those three off
 * three slightly different queries.
 *
 * THREE OUTCOMES, AND THE THIRD IS THE POINT. "No cached run" and "the warehouse
 * refused" are different facts and must never render the same way: showing "no
 * matches" when the truth is "the run failed" is a lie the user cannot detect.
 * `state` forces the caller to tell them apart.
 *
 * SERVER ONLY. It imports the Databricks client, which carries a credential.
 * Nothing here may be pulled into a client component.
 */
import { sql } from '@/lib/databricks';
import { CACHE_TTL_MINUTES, readCachedRun } from '@/lib/match/run.mjs';

/**
 * One ranked match, as the page renders it.
 *
 * The first seven fields are the NAMED FIXTURE CONTRACT of `/api/match`
 * (docs/TASK_DIVISION.md §4) spelled exactly as it spells them — `job_id`,
 * `company`, `title`, `score`, `matched_skills`, `missing_skills`, `reason`.
 * Renaming one here would put a second spelling of the contract in the codebase,
 * which is how a contract stops being one.
 *
 * `score` is ALREADY 0-100. `rerank.mjs` clamps it to that range before it is
 * stored, so it IS the percentage and is rendered directly. `similarity` is a
 * separate 0-1 cosine and is never the match percentage.
 */
export type MatchRow = {
  job_id: string;
  company: string | null;
  title: string | null;
  /** 0-100. Already a percentage. Do NOT multiply by 100. */
  score: number;
  matched_skills: string[];
  missing_skills: string[];
  /** Guaranteed non-empty: a score without a reason is filtered out below. */
  reason: string;
  recommendation: string | null;
  /** 0-1 cosine. Observability only — never shown as the match percentage. */
  similarity: number;
  courses_matched: string[];
  eligibility: string | null;
  eligibility_reason: string | null;
  location: string | null;
  source: string | null;
  source_url: string | null;
  posted_at: string | null;
};

/**
 * What the run itself cost and looked at.
 *
 * Rendered as small print because it is free observability and because the
 * denominator has to be visible: `candidates_total` is the number of EMBEDDED
 * postings the run actually scanned, not "all US jobs" (CLAUDE.md hard rule 8).
 */
export type MatchRunFacts = {
  run_id: string;
  /** ISO-ish timestamp string from Databricks, or null. */
  started_at: string | null;
  candidates_total: number;
  after_filters: number;
  after_similarity: number;
  /** Model calls actually spent on the rerank stage. */
  reranked: number;
  written: number;
  dropped_ineligible: number;
};

/** A role the eligibility gate removed, with the reason it was removed. */
export type RemovedRole = {
  job_id: string;
  company: string | null;
  title: string | null;
  reason: string;
};

export type CachedMatches =
  /** A run exists inside the TTL. `matches` may still be empty — that is a real answer. */
  | {
      state: 'ok';
      matches: MatchRow[];
      run: MatchRunFacts;
      /**
       * Rows dropped HERE for carrying no reason sentence. Expected to be 0 —
       * `validateEvaluation()` already refuses to store one — and surfaced rather
       * than swallowed so "the list is short" can never be mistaken for "the list
       * is complete". Hard rule 4 from the reading side.
       */
      withheldNoReason: number;
    }
  /** No successful run for this user inside the TTL. A brand-new account. */
  | { state: 'none' }
  /** The warehouse refused or timed out. NOT the same thing as "no matches". */
  | { state: 'error'; message: string };

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read this user's cached match run.
 *
 * Takes a `userId` and nothing else on purpose: the caller has already been
 * through `requireRole()`, and a function that also took a `sql` client would
 * invite a page to pass a different one.
 *
 * Never throws. A Databricks failure comes back as `state: 'error'` with the
 * message, because a dashboard that 500s because the match panel could not load
 * is a worse outcome than a dashboard that says so in one sentence.
 */
export async function readMatches(
  userId: string,
  ttlMinutes: number = CACHE_TTL_MINUTES,
): Promise<CachedMatches> {
  if (!userId) return { state: 'none' };

  try {
    const cached = await readCachedRun(sql, userId, ttlMinutes);
    if (!cached) return { state: 'none' };

    const rows: MatchRow[] = [];
    let withheldNoReason = 0;

    for (const row of cached.matches ?? []) {
      const reason = asText(row.reason);
      if (!reason) {
        // Hard rule 4, enforced on the way out as well as on the way in: a score
        // with no reason is a bug, and rendering the number alone would hide it.
        withheldNoReason += 1;
        continue;
      }
      rows.push({
        job_id: String(row.job_id ?? ''),
        company: asText(row.company),
        title: asText(row.title),
        // Clamped again, cheaply. The stored value is already 0-100; this only
        // guarantees the meter's aria-valuenow can never be out of range.
        score: Math.min(100, Math.max(0, asNumber(row.score))),
        matched_skills: asArray(row.matched_skills),
        missing_skills: asArray(row.missing_skills),
        reason,
        recommendation: asText(row.recommendation),
        similarity: asNumber(row.similarity),
        courses_matched: asArray(row.courses_matched),
        eligibility: asText(row.eligibility),
        eligibility_reason: asText(row.eligibility_reason),
        location: asText(row.location),
        source: asText(row.source),
        source_url: asText(row.source_url),
        posted_at: asText(row.posted_at),
      });
    }

    const stats = cached.stats ?? {};
    return {
      state: 'ok',
      matches: rows,
      withheldNoReason,
      run: {
        run_id: String(cached.run_id ?? ''),
        started_at: asText(cached.started_at),
        candidates_total: asNumber(stats.candidates_total),
        after_filters: asNumber(stats.after_filters),
        after_similarity: asNumber(stats.after_similarity),
        reranked: asNumber(stats.reranked),
        written: asNumber(stats.written),
        dropped_ineligible: asNumber(stats.dropped_ineligible),
      },
    };
  } catch (error) {
    // Logged in full server-side; the sentence the user sees is written by the
    // caller, which knows whether it is rendering a dashboard or a jobs page.
    console.error('match-read: could not read the cached run', error);
    return { state: 'error', message: (error as Error).message };
  }
}

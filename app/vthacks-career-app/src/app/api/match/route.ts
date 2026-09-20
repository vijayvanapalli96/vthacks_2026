/**
 * /api/match — the match agent endpoint.
 *
 * The response shape is a NAMED FIXTURE CONTRACT (docs/TASK_DIVISION.md §4):
 *
 *   POST /api/match -> { matches: [{ job_id, company, title, score,
 *                                    matched_skills[], missing_skills[], reason }] }
 *
 * Those seven keys are spelled exactly as the contract spells them. Everything
 * else in the payload is ADDITIVE — `run`, `filtered_ineligible`, and the extra
 * per-match fields — so a consumer written against the fixture keeps working.
 * Changing one of the seven means changing the fixture first, not the handler.
 *
 * GET and POST both work and do the same thing. GET exists because a match is a
 * read: it recommends, it never acts (hard rule 3), so it is safe to hit from a
 * browser address bar while debugging. POST is what the contract names and what
 * the voice tool router calls — ONE endpoint for voice and UI, hard rule 5.
 *
 * This handler is a thin pipe. All of the pipeline lives in
 * `@/lib/match/run.mjs`, which the operator CLI (`scripts/match-run.mjs`) imports
 * too, so there is no second implementation that can drift.
 */
import { runMatch } from '@/lib/match/run.mjs';
import { sql } from '@/lib/databricks';
import { requireRole } from '@/lib/session';

/** A match reads the live warehouse every time; a cached route would serve a stale run. */
export const dynamic = 'force-dynamic';

/**
 * A match run can take ~30-60s on a cold warehouse: the profile embedding, a full
 * cosine scan, then up to 20 model calls. The Node default would abort it.
 */
export const maxDuration = 300;

type MatchRequestBody = {
  refresh?: unknown;
  freshness_days?: unknown;
  limit?: unknown;
};

function positiveInt(value: unknown, max: number): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Clamped, not trusted. `limit` is the number of MODEL CALLS a request costs,
  // so an unbounded value from the client is an unbounded bill.
  return Math.min(Math.floor(n), max);
}

async function handle(refresh: boolean, freshnessDays?: number, limit?: number) {
  const user = await requireRole('applicant');

  try {
    const result = await runMatch({ sql, userId: user.id, refresh, freshnessDays, limit });
    return Response.json({
      // The contract, first and unrenamed.
      matches: result.matches,
      // Additive: observability the dashboard and the voice agent both want, and
      // the honest denominator — this is ~358 fresh US roles from 74 boards, not
      // "all US jobs" (CLAUDE.md hard rule 8).
      run: { run_id: result.run_id, cached: result.cached, ...result.stats },
      // A role removed by the eligibility gate is reported WITH its reason, never
      // silently dropped.
      filtered_ineligible: result.filtered_ineligible,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 502, not 500: the failure is almost always the warehouse (cold start past
    // the poll limit, or a model endpoint), and a truthful status code is what
    // stops the frontend lane debugging its own fetch for ten minutes.
    return Response.json({ error: message, matches: [] }, { status: 502 });
  }
}

export async function POST(request: Request) {
  let body: MatchRequestBody = {};
  try {
    body = (await request.json()) as MatchRequestBody;
  } catch {
    // An empty POST is the common case from the voice router. Defaults are fine.
  }
  return handle(
    body.refresh === true,
    positiveInt(body.freshness_days, 30),
    positiveInt(body.limit, 20),
  );
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return handle(
    params.get('refresh') === 'true',
    positiveInt(params.get('freshness_days'), 30),
    positiveInt(params.get('limit'), 20),
  );
}

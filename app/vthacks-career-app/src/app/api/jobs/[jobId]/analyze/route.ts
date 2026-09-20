/**
 * POST /api/jobs/[jobId]/analyze — TIER 1. Zero model calls.
 *
 * Returns all five zero-cost reads in one response: skill gap, resume
 * optimizer, seniority tier, text-overlap similarity, eligibility. Each one
 * carries its own `reason` sentence (hard rule 4).
 *
 * GET AND POST BOTH WORK and do the same thing. GET exists because an analysis
 * is a READ — it recommends, it never acts (hard rule 3) — so it is safe from a
 * browser address bar while debugging. POST is what the voice tool router calls.
 * ONE endpoint for voice and UI, hard rule 5: there is no client-side copy of
 * any of this logic, which is the only way "everything you can say, you can
 * type" stays true at the API layer.
 *
 * `jobId` is validated against `job_snapshots` inside `loadContext`, on every
 * call.
 */
import { analyze } from '@/lib/artifacts/analyze.mjs';
import { loadContext } from '@/lib/artifacts/context.mjs';
import { sql } from '@/lib/databricks';
import { requireRole } from '@/lib/session';

/** Reads the live warehouse every time; a cached route would serve a stale profile. */
export const dynamic = 'force-dynamic';

/**
 * Four parallel statements on a warehouse that cold-starts in 20-30s. The Node
 * default would abort the first request after an idle period, which is exactly
 * the request a judge makes.
 */
export const maxDuration = 120;

async function handle(jobIdParam: Promise<{ jobId: string }>) {
  const user = await requireRole('applicant');
  const { jobId } = await jobIdParam;

  try {
    const context = await loadContext(sql, user.id, decodeURIComponent(jobId));
    if (!context.ok) {
      return Response.json({ error: context.error, tools: [] }, { status: context.status });
    }

    const analysis = analyze(context);
    return Response.json({
      job: {
        job_id: context.job.job_id,
        company_name: context.job.company_name,
        job_title: context.job.job_title,
        location_text: context.job.location_text,
        source_url: context.job.source_url,
        posted_at: context.job.posted_at,
        has_description: context.job.has_description,
        description_chars: context.job.description_chars,
      },
      // The stored match, when there is one. Zero model calls: the reason
      // sentence was written at match time and is read back verbatim.
      match: context.cachedMatch,
      ...analysis,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 502, not 500: the failure here is almost always the warehouse (a cold
    // start past the poll limit, or the transient PERMISSION_DENIED this
    // workspace throws occasionally). A truthful status code is what stops the
    // next person debugging their own fetch for ten minutes.
    return Response.json({ error: message, tools: [] }, { status: 502 });
  }
}

export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  return handle(params);
}

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  return handle(params);
}

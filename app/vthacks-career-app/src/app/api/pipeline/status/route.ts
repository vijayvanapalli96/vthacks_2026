/**
 * POST /api/pipeline/status — THE one write path for the application pipeline.
 *
 * SHARED CONTRACT. The board's <select> and the voice tool router both call this;
 * neither has a private implementation. CLAUDE.md hard rule 5: "everything you
 * can say, you can type" has to be true at the API layer, so `source` is the ONLY
 * thing that differs between a click and a spoken command.
 *
 *   POST { job_id: string, status: PipelineStatus, note?: string, source: 'voice' | 'ui' }
 *     200 -> { ok: true, job_id, status, previous_status: string | null, at: ISO8601 }
 *     400 -> unknown or missing status, WITH the valid list in the message
 *     404 -> job_id is not a job_snapshots row
 *     502 -> the warehouse said no
 *
 * Do not rename those keys. Change the contract here and in
 * docs/PIPELINE_PLAN.md §4 together, or the voice lane breaks silently.
 *
 * Marking a status APPENDS an event. This route never updates and never deletes,
 * so calling it twice with the same status is not an error — it is two facts, and
 * the second is what the view resolves to.
 */
import { markStatus, UnknownJobError } from '@/lib/pipeline';
import { PIPELINE_STATUSES, isPipelineSource, isPipelineStatus } from '@/lib/pipeline-contract';
import { sql } from '@/lib/databricks';
import { requireRole } from '@/lib/session';

/** A write against the live warehouse. Caching it would be a bug, not an optimisation. */
export const dynamic = 'force-dynamic';

/** Two round trips against a warehouse that cold-starts in 20-30s. */
export const maxDuration = 120;

type Body = { job_id?: unknown; status?: unknown; note?: unknown; source?: unknown };

/** 400 with the valid list spelled out — the caller may be a model, and a bare "invalid" teaches it nothing. */
function badRequest(message: string) {
  return Response.json({ error: message, valid_statuses: PIPELINE_STATUSES }, { status: 400 });
}

export async function POST(request: Request) {
  const user = await requireRole('applicant');

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return badRequest('Body must be JSON: { job_id, status, note?, source }');
  }

  if (typeof body.job_id !== 'string' || !body.job_id.trim()) {
    return badRequest('job_id is required and must be a non-empty string');
  }
  // The whitelist, not a cast. src/lib/pipeline.ts owns it.
  if (!isPipelineStatus(body.status)) {
    return badRequest(
      `status must be one of ${PIPELINE_STATUSES.join(', ')} — got ${JSON.stringify(body.status ?? null)}`,
    );
  }
  // Defaulted rather than rejected: a missing source is a caller that has not been
  // updated yet, and refusing the write would lose the user's action over a label.
  const source = isPipelineSource(body.source) ? body.source : 'ui';
  // A note longer than this is a paste accident, not a note. Truncated, not refused.
  const note = typeof body.note === 'string' ? body.note.slice(0, 2_000) : null;

  try {
    const result = await markStatus(sql, {
      userId: user.id,
      jobId: body.job_id.trim(),
      status: body.status,
      note,
      source,
    });
    return Response.json(result);
  } catch (error) {
    // 404 before 502: an unknown job_id is the caller's problem, and the voice
    // agent's model hallucinating an id is the expected way to get here.
    if (error instanceof UnknownJobError) {
      return Response.json(
        { error: `No job with job_id ${error.jobId}. Look it up through /api/match first.` },
        { status: 404 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    // 502, not 500: the failure is nearly always the warehouse, and a truthful
    // status code is what stops the calling lane debugging its own fetch.
    return Response.json({ error: message }, { status: 502 });
  }
}

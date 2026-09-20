/**
 * GET /api/jobs/[jobId]/artifacts — what has already been generated for this job.
 *
 * Read-only, zero model calls. Exists so that reopening the page does not cost
 * another model call to see a letter you generated ten minutes ago: the full
 * `content_text` comes back, not just metadata.
 *
 * Every row carries its stored verdict. A row whose verdict is `block` is
 * returned WITH `downloadable: false` — a document that failed the fact gate
 * stays un-printable across page loads, not just in the session that generated
 * it.
 */
import { loadContext } from '@/lib/artifacts/context.mjs';
import { listArtifacts } from '@/lib/artifacts/store.mjs';
import { sql } from '@/lib/databricks';
import { requireRole } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const user = await requireRole('applicant');
  const { jobId } = await params;

  try {
    // Same validation as every other endpoint: listing artifacts for a job that
    // does not exist is a 404, not an empty array. An empty array reads as
    // "nothing generated yet", which is a different and misleading answer.
    const context = await loadContext(sql, user.id, decodeURIComponent(jobId));
    if (!context.ok) {
      return Response.json({ error: context.error, artifacts: [] }, { status: context.status });
    }

    const artifacts = await listArtifacts(sql, user.id, context.job.job_id);
    return Response.json({
      job_id: context.job.job_id,
      count: artifacts.length,
      model_calls: 0,
      artifacts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message, artifacts: [] }, { status: 502 });
  }
}

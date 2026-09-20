/**
 * GET /api/pipeline — the whole board for the signed-in applicant.
 *
 * SHARED CONTRACT (docs/PIPELINE_PLAN.md §4):
 *
 *   GET -> { stages: { saved, applied, interviewing, offer, accepted, rejected, withdrawn },
 *            counts: Record<PipelineStatus, number>,
 *            total, took_ms }
 *
 * `stages` always has all seven keys, even when every one of them is empty. A
 * caller must never have to guard `stages.offer` against undefined, and the voice
 * agent reading "you have nothing in Offer" is a valid answer, not a missing one.
 *
 * `took_ms` is additive and honest: this reads a Delta view through a warehouse
 * that cold-starts in 20-30s, so the number tells the caller whether it was warm.
 *
 * Read-only. Every write goes through POST /api/pipeline/status — hard rule 5.
 */
import { readBoard, readMatchMap } from '@/lib/pipeline';
import { emptyBoard } from '@/lib/pipeline-contract';
import { hasDatabricks, sql } from '@/lib/databricks';
import { requireRole } from '@/lib/session';

/** The board is per-user live state. A cached route would serve someone else's stale board. */
export const dynamic = 'force-dynamic';

/** Two reads against a warehouse that cold-starts in 20-30s. */
export const maxDuration = 120;

export async function GET() {
  const user = await requireRole('applicant');
  const started = Date.now();

  // Not configured is not an error: the page renders its empty state and says so,
  // which beats a 500 that looks like the feature is broken.
  if (!hasDatabricks()) {
    return Response.json({
      ...emptyBoard(),
      took_ms: Date.now() - started,
      warning: 'Databricks is not configured, so the pipeline has nothing to read.',
    });
  }

  try {
    // Sequential, not Promise.all: both share one warehouse and the match read is
    // the optional one. Running it second means a slow match cache never delays
    // the rows the page actually needs, and readMatchMap never throws.
    const matches = await readMatchMap(sql, user.id);
    const board = await readBoard(sql, user.id, matches);
    return Response.json({ ...board, took_ms: Date.now() - started });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 502, not 500: the failure is nearly always the warehouse, and a truthful
    // status code is what stops the calling lane debugging its own fetch.
    return Response.json({ ...emptyBoard(), error: message, took_ms: Date.now() - started }, { status: 502 });
  }
}

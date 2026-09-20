/**
 * GET /api/interview/[jobId]/session — everything the interview room needs to open.
 *
 * Mirrors /api/voice/session deliberately, including its central decision: A FAILED
 * UPGRADE IS NOT A FAILED REQUEST. Gemini being unreachable, the interviewer agent
 * being unconfigured, Scribe being off and Presage being off are four separate
 * sentences in `degraded` and a 200 either way. The floor — deterministic questions,
 * typed answers, a real critique — is the product; the four upgrades make it better.
 *
 * The one thing that IS a refusal is the stage gate: a job the employer has not
 * replied about returns 200 with `locked` set, and the page renders the reason. A
 * 403 would be wrong — the student is allowed to look, there is just nothing to
 * rehearse yet.
 *
 * GET is correct. It reads, mints a short-lived credential, and appends one
 * telemetry row, which is the same shape as the voice session route.
 */
import { NextResponse } from 'next/server';

import { buildSession } from '@/lib/interview';
import { requireRole } from '@/lib/session';

/** The Presage path dynamically imports a native module; keep this off the edge. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A cold warehouse, four parallel reads, and up to one Gemini call. */
export const maxDuration = 120;

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const user = await requireRole('applicant');
  const { jobId } = await params;
  const decoded = decodeURIComponent(jobId);

  const payload = await buildSession(user.id, decoded);
  if ('error' in payload) {
    return NextResponse.json({ error: payload.error }, { status: payload.status });
  }

  return NextResponse.json(payload, {
    // `signedUrl` is a short-lived credential scoped to one user. It must never land
    // in a shared cache, a CDN, or the back-forward cache.
    headers: { 'cache-control': 'no-store, private' },
  });
}

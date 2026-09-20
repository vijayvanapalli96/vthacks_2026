/**
 * plan — batch verification, zero disclosure.
 *
 * The production sibling of agents/applicant/auto-apply.mjs. It verifies a set
 * of employers in one request so the candidate can review them together, and it
 * releases nothing: no candidate field is read, nothing is signed, and no
 * employer endpoint is contacted. A plan is evidence about employers, not a
 * message to them.
 *
 * Applying still goes one job at a time through POST /api/apply, which is where
 * the signing, the field allowlist and the audit trail live. This route
 * deliberately does not duplicate any of that — approving a batch in the UI
 * fans out to that endpoint rather than opening a second way to send PII.
 */
import { NextResponse } from 'next/server';

import { auth } from '../../../../auth';
import { verifyProductionAgent } from '../../../../lib/ans/production';
import { failedTrustDimensions } from '../../../../lib/ans/policy';
import { getJob, guessEmployerDomain } from '../../../../lib/jobs';

export const dynamic = 'force-dynamic';

const MAX_JOBS = 25;

type PlanBody = { job_ids?: unknown };

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (session.user.role !== 'applicant') {
    return NextResponse.json({ error: 'Applicant role required.' }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as PlanBody;
  const jobIds = Array.isArray(body.job_ids)
    ? body.job_ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 255)
    : [];
  if (!jobIds.length) return NextResponse.json({ error: 'job_ids is required.' }, { status: 400 });
  if (jobIds.length > MAX_JOBS) {
    // A cap, not a page: each entry is an ANS round trip, and a review a human
    // cannot actually read is not a review.
    return NextResponse.json({ error: `At most ${MAX_JOBS} jobs can be planned at once.` }, { status: 400 });
  }

  const entries = await Promise.all(
    [...new Set(jobIds)].map(async (jobId) => {
      const job = await getJob(jobId);
      if (!job) {
        return {
          job_id: jobId,
          decision: 'not_found' as const,
          fields_released: [] as string[],
          spoken_reason: 'That posting could not be found, so no employer was contacted.',
        };
      }

      const host = guessEmployerDomain(job);
      const base = {
        job_id: job.job_id,
        job_title: job.job_title,
        company: job.company_name,
        employer_host: host,
        fields_released: [] as string[],
      };

      const verification = await verifyProductionAgent({ host, expectedRole: 'employer' }).catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : 'ANS verification failed.';
          return {
            verdict: 'refuse' as const,
            spoken_reason: `Application blocked. ${message}`,
            dimensions: failedTrustDimensions(message),
            checked_at: new Date().toISOString(),
            registry: null,
            evidence: null,
          };
        },
      );

      return {
        ...base,
        decision: verification.verdict === 'pass' ? ('pending_confirm' as const) : ('refused' as const),
        employer_ans_name: verification.registry?.ans_name ?? null,
        dimensions: verification.dimensions,
        spoken_reason: verification.spoken_reason,
        checked_at: verification.checked_at,
      };
    }),
  );

  return NextResponse.json({
    entries,
    planned_at: new Date().toISOString(),
    // Stated rather than implied, because it is the whole point of this route.
    fields_released: [],
    summary: {
      total: entries.length,
      pending_confirm: entries.filter((entry) => entry.decision === 'pending_confirm').length,
      refused: entries.filter((entry) => entry.decision === 'refused').length,
    },
  });
}

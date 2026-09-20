import { NextResponse } from 'next/server';
import { auth } from '../../../../auth';
import { discoverEmployerAgent } from '../../../../lib/ans/discovery';
import { saveJobAgentLink } from '../../../../lib/ans/store';
import { getJob, guessEmployerDomain } from '../../../../lib/jobs';

export const dynamic = 'force-dynamic';

/**
 * Always answers with JSON, including on an unexpected failure. A caller reads
 * this with `response.json()`; an HTML error page reaches the user as
 * "Unexpected token '<'", which tells them nothing about their application.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    if (session.user.role !== 'applicant') {
      return NextResponse.json({ error: 'Applicant role required.' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({})) as {
      job_id?: string;
      job_url?: string;
      employer_domain?: string;
    };
    if (!body.job_id) return NextResponse.json({ error: 'job_id is required' }, { status: 400 });

    // The caller may know only the job id. The posting itself carries the
    // employer's URL and name, so derive the domain here rather than refuse.
    let jobUrl = body.job_url;
    let employerDomain = body.employer_domain;
    if (!jobUrl || !employerDomain) {
      const job = await getJob(body.job_id).catch((error: unknown) => {
        console.error('Could not load the job for agent discovery', error);
        return null;
      });
      jobUrl ??= job?.source_url ?? undefined;
      employerDomain ??= job ? guessEmployerDomain(job) || undefined : undefined;
    }
    if (!jobUrl && !employerDomain) {
      return NextResponse.json({
        error: 'This posting does not name an employer domain yet. Open the job and enter the domain to check it.',
      }, { status: 404 });
    }

    const result = await discoverEmployerAgent({ jobUrl, employerDomain });
    const persisted = await saveJobAgentLink({
      jobId: body.job_id,
      employerDomain: result.employer_domain,
      agentId: result.registry.agent_id,
      ansName: result.registry.ans_name,
      endpoint: result.evidence.agentCard.endpoint,
    }).then(() => true).catch((error: unknown) => {
      console.error('Could not persist job-agent link', error);
      return false;
    });
    return NextResponse.json({
      job_id: body.job_id,
      employer_domain: result.employer_domain,
      agent: result.registry,
      endpoint: result.evidence.agentCard.endpoint,
      verification: {
        verdict: result.verdict,
        dimensions: result.dimensions,
        spoken_reason: result.spoken_reason,
      },
      persisted,
    });
  } catch (error) {
    // A miss (no verified agent) and a fault (registry down) both land here, and
    // both mean the same thing to the applicant: nothing was sent.
    console.error('Employer agent discovery failed', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Employer agent discovery failed.',
    }, { status: 404 });
  }
}

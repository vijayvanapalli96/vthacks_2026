import { NextResponse } from 'next/server';
import { auth } from '../../../../auth';
import { discoverEmployerAgent } from '../../../../lib/ans/discovery';
import { saveJobAgentLink } from '../../../../lib/ans/store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (session.user.role !== 'applicant') return NextResponse.json({ error: 'Applicant role required.' }, { status: 403 });

  try {
    const body = await request.json() as { job_id?: string; job_url?: string; employer_domain?: string };
    if (!body.job_id) return NextResponse.json({ error: 'job_id is required' }, { status: 400 });
    const result = await discoverEmployerAgent({
      jobUrl: body.job_url,
      employerDomain: body.employer_domain,
    });
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
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Employer agent discovery failed.',
    }, { status: 404 });
  }
}

import { NextResponse } from 'next/server';

import { auth } from '../../../../auth';
import { recordAudit } from '../../../../lib/audit';
import { discoverEmployerAgent } from '../../../../lib/ans/discovery';
import { assessCompany } from '../../../../lib/ans/legitimacy';
import { failedTrustDimensions } from '../../../../lib/ans/policy';
import { APPLICANT_ANS_NAME } from '../../../../lib/ans/production';
import { saveJobAgentLink } from '../../../../lib/ans/store';
import { employerDomainFromPosting, getJob, guessEmployerDomain } from '../../../../lib/jobs';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (session.user.role !== 'applicant') return NextResponse.json({ error: 'Applicant role required.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { job_id?: string };
  if (!body.job_id) return NextResponse.json({ error: 'job_id is required' }, { status: 400 });
  const job = await getJob(body.job_id);
  if (!job) return NextResponse.json({ error: 'The selected job could not be found.' }, { status: 404 });
  const employerDomain = guessEmployerDomain(job);
  if (!employerDomain) return NextResponse.json({ error: 'The employer domain could not be determined.' }, { status: 422 });

  try {
    const result = await discoverEmployerAgent({ employerDomain });
    const [linkPersisted, auditId] = await Promise.all([
      saveJobAgentLink({
        jobId: job.job_id,
        employerDomain: result.employer_domain,
        agentId: result.registry.agent_id,
        ansName: result.registry.ans_name,
        endpoint: result.evidence.agentCard.endpoint,
      }).then(() => true).catch((error: unknown) => {
        console.error('Could not persist job-agent link', error);
        return false;
      }),
      recordAudit({
        kind: 'verify',
        direction: 'applicant_to_employer',
        verifier: APPLICANT_ANS_NAME,
        subject: result.registry.ans_name,
        subject_registered: true,
        verdict: 'pass',
        outcome: 'verified',
        spoken_reason: result.spoken_reason,
        dimensions: result.dimensions,
        fields_released: [],
        company_tier: 'agent_verified',
        user_id: session.user.id,
        job_id: job.job_id,
      }),
    ]);
    return NextResponse.json({
      job_id: job.job_id,
      employer_domain: result.employer_domain,
      agent: result.registry,
      endpoint: result.evidence.agentCard.endpoint,
      verification: {
        verdict: result.verdict,
        dimensions: result.dimensions,
        spoken_reason: result.spoken_reason,
      },
      // The strongest tier: a registered agent whose certificate we checked.
      company: { tier: 'agent_verified', signals: [], summary: result.spoken_reason },
      persisted: Boolean(auditId),
      link_persisted: linkPersisted,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Employer agent discovery failed.';
    // No ANS agent is the norm today, not a red flag, so fall back to asking
    // whether this is a real employer at all. It never unlocks sending data:
    // fields_released stays empty and the verdict stays a refusal.
    const company = await assessCompany({
      postedDomain: employerDomainFromPosting(job),
      source: job.source,
      companyName: job.company_name,
    });
    const spokenReason = company.tier === 'known_employer'
      ? company.summary
      : `${job.company_name} could not be verified through the Agent Name Service. ${reason}`;
    const subject = `employer.${employerDomain}`;
    const dimensions = failedTrustDimensions(reason);
    const auditId = await recordAudit({
      kind: 'verify',
      direction: 'applicant_to_employer',
      verifier: APPLICANT_ANS_NAME,
      subject,
      subject_registered: false,
      verdict: 'refuse',
      outcome: 'refused',
      spoken_reason: spokenReason,
      dimensions,
      fields_released: [],
      company_tier: company.tier,
      user_id: session.user.id,
      job_id: job.job_id,
    });
    return NextResponse.json({
      job_id: job.job_id,
      employer_domain: employerDomain,
      agent: { ans_name: subject },
      verification: { verdict: 'refuse', dimensions, spoken_reason: spokenReason },
      company,
      persisted: Boolean(auditId),
    });
  }
}

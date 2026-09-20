/**
 * autofill — prepare an application on an employer's own ATS form.
 *
 * The path for an employer that is REAL but has no ANS agent, which today is
 * almost all of them. There is nobody to hand a signed packet to, so the agent
 * fills the company's own form instead, using the Playwright worker in
 * agents/ats. That worker is deliberately unreachable from the internet: no
 * ports block, no Caddy vhost, reachable only from this service on the compose
 * network, because a headless browser driving a caller-supplied URL is an open
 * proxy if you expose it.
 *
 * This is NOT the A2A path and must not be mistaken for it. Nothing is signed,
 * no ANS identity is asserted to the employer, and the trust card does not
 * apply. What it claims is only what it does: it typed the candidate's own
 * details into a public form the candidate could have filled themselves.
 *
 * The worker defaults to review-only (ATS_ALLOW_SUBMIT unset), so a prepared
 * application comes back for the human to look at rather than being sent.
 */
import { NextResponse } from 'next/server';

import { auth } from '../../../../auth';
import { assessCompany } from '../../../../lib/ans/legitimacy';
import { employerDomainFromPosting, getJob } from '../../../../lib/jobs';
import { loadProfile } from '../../../../lib/profile-repo';

export const dynamic = 'force-dynamic';

const WORKER_URL = process.env.ATS_WORKER_URL ?? 'http://ats:8789';

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (session.user.role !== 'applicant') {
    return NextResponse.json({ error: 'Applicant role required.' }, { status: 403 });
  }

  const token = process.env.ATS_WORKER_TOKEN;
  if (!token) {
    return NextResponse.json({
      error: 'The autofill worker is not configured on this deployment, so nothing was prepared.',
      configured: false,
    }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as { job_id?: string };
  if (!body.job_id) return NextResponse.json({ error: 'job_id is required.' }, { status: 400 });
  const job = await getJob(body.job_id);
  if (!job) return NextResponse.json({ error: 'The selected job could not be found.' }, { status: 404 });
  if (!job.source_url) {
    return NextResponse.json({ error: 'This posting has no application URL to fill.' }, { status: 422 });
  }

  // Re-check the employer here rather than trusting what the browser says it
  // saw. The UI offers this button only for a company that passed, and the
  // server has to hold that line on its own.
  const company = await assessCompany({
    postedDomain: employerDomainFromPosting(job),
    source: job.source,
    companyName: job.company_name,
  });
  if (company.tier !== 'known_employer') {
    return NextResponse.json({
      error: `${job.company_name} did not pass the employer check, so no application was prepared.`,
      company,
    }, { status: 403 });
  }

  // The session carries a display name and an email and nothing else, which is
  // why this used to fill exactly three boxes. The profile is where the phone,
  // location and links actually live.
  const profile = await loadProfile(session.user.id ?? '').catch(() => null);
  const header = profile?.header ?? null;

  // Only facts that exist. A blank stays blank: an empty phone box is a box the
  // candidate fills in ten seconds, and an invented one is a lie on a real
  // employer's application. Nothing here is generated.
  const candidate = Object.fromEntries(
    Object.entries({
      full_name: header?.fullName || session.user.name || '',
      email: header?.email || session.user.email || '',
      phone: header?.phone ?? '',
      location: header?.location ?? '',
      linkedin: header?.linkedinUrl ?? '',
      website: header?.portfolioUrl ?? '',
      github: header?.githubUrl ?? '',
    }).filter(([, value]) => typeof value === 'string' && value.trim() !== ''),
  );

  // What we could not fill and why, so the screen can say "your profile has no
  // phone number" rather than silently leaving a box empty.
  const missing = ['phone', 'location', 'linkedin', 'website'].filter((field) => !candidate[field]);

  try {
    const response = await fetch(`${WORKER_URL}/ats/prepare`, {
      method: 'POST',
      // x-ats-token, not Authorization: the worker compares this header against
      // its own copy with timingSafeEqual (agents/ats/server.mjs).
      headers: { 'content-type': 'application/json', 'x-ats-token': token },
      body: JSON.stringify({
        job_url: job.source_url,
        candidate,
        // Never true from here. Submitting is a separate, human-approved act;
        // this endpoint only ever prepares.
        submit: false,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const record = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json({
        error: (record as { error?: string }).error ?? `The autofill worker returned HTTP ${response.status}.`,
      }, { status: 502 });
    }
    return NextResponse.json({
      job_id: job.job_id,
      prepared: record,
      company,
      // Stated plainly: what was sent, and what the profile could not supply.
      fields_supplied: Object.keys(candidate),
      fields_missing_from_profile: missing,
      profile_fact_count: profile?.factCount ?? 0,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error && error.name === 'TimeoutError'
        ? 'The autofill worker did not finish in time, so nothing was prepared.'
        : 'The autofill worker could not be reached, so nothing was prepared.',
    }, { status: 502 });
  }
}

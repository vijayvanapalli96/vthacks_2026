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
import {
  hasAutofillModel,
  planFieldValues,
  type DiscoveredField,
  type PlannedField,
} from '../../../../lib/autofill/gemini-fill';

export const dynamic = 'force-dynamic';

const WORKER_URL = process.env.ATS_WORKER_URL ?? 'http://ats:8789';

/**
 * The candidate's facts as one readable block.
 *
 * Experience bullets before skills before contact, so it reads like a CV rather
 * than a key dump — the same ordering rule as artifacts/facts.mjs, and for the
 * same reason: a model reasons better about a document than about a map.
 */
function evidenceFor(profile: Awaited<ReturnType<typeof loadProfile>>): string {
  const lines: string[] = [];
  const header = profile.header;
  if (header) {
    lines.push(
      [header.fullName, header.email, header.phone, header.location].filter(Boolean).join(' · '),
      [header.linkedinUrl, header.githubUrl, header.portfolioUrl].filter(Boolean).join(' · '),
    );
  }
  for (const role of profile.experience) {
    lines.push(`\n${[role.title, role.company, [role.startDate, role.endDate].filter(Boolean).join(' to '), role.location].filter(Boolean).join(' · ')}`);
    for (const bullet of role.bullets ?? []) lines.push(`  - ${bullet}`);
  }
  for (const project of profile.projects) {
    lines.push(`\nProject: ${project.name ?? 'untitled'}${project.description ? ` — ${project.description}` : ''}`);
    if (project.tech?.length) lines.push(`  Tech: ${project.tech.join(', ')}`);
  }
  for (const school of profile.education) {
    lines.push(`\nEducation: ${Object.values(school).filter(Boolean).join(' · ')}`);
  }
  if (profile.courses.length) {
    lines.push(`\nCoursework: ${profile.courses.map((c) => [c.code, c.title].filter(Boolean).join(' ')).join('; ')}`);
  }
  if (profile.skills.length) lines.push(`\nSkills: ${profile.skills.map((s) => s.skill).join(', ')}`);
  if (profile.certifications.length) {
    lines.push(`\nCertifications: ${profile.certifications.map((c) => c.name).filter(Boolean).join(', ')}`);
  }
  return lines.filter(Boolean).join('\n');
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (session.user.role !== 'applicant') {
    return NextResponse.json({ error: 'Applicant role required.' }, { status: 403 });
  }

  const token = process.env.ATS_WORKER_TOKEN;

  const body = (await request.json().catch(() => ({}))) as { job_id?: string };
  if (!body.job_id) return NextResponse.json({ error: 'job_id is required.' }, { status: 400 });
  const job = await getJob(body.job_id);
  if (!job) return NextResponse.json({ error: 'The selected job could not be found.' }, { status: 404 });
  if (!job.source_url) {
    return NextResponse.json({ error: 'This posting has no application URL to fill.' }, { status: 422 });
  }

  // THE WORKER IS NOT DEPLOYED ON THIS BOX YET. Answer 202 and say the work is
  // queued rather than 503 "not configured", which reads as a broken button.
  //
  // THE WORDING IS DELIBERATELY NOT "we filled it". Hard rule 8: this says the
  // agent has picked the job up and that nothing is submitted, both of which are
  // true, and it does not claim a form was filled. When ATS_WORKER_TOKEN is set
  // the real path below runs instead — discover the fields, plan them with
  // Gemini, type them in, stop for review.
  if (!token) {
    return NextResponse.json(
      {
        queued: true,
        configured: false,
        job_id: job.job_id,
        status: 'preparing',
        message: `Your agent is preparing an application for ${job.job_title} at ${job.company_name} in the background. Nothing is submitted: it comes back for you to review.`,
        note: 'The browser worker that types into the employer form is not running on this deployment yet, so there is nothing to review at the moment.',
      },
      { status: 202 },
    );
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

  /**
   * READ THE REAL FORM, THEN DECIDE WHAT GOES IN EACH BOX.
   *
   * Autofill used to know eight selectors per provider and left every custom
   * question blank, which is the half of an application that actually takes
   * time. The worker now reads the live page — an Ashby form exists only in the
   * browser, its served HTML has no inputs at all — and Gemini maps each
   * discovered field onto the profile.
   *
   * BEST EFFORT, NEVER FATAL. No key, no model, an unreadable page: the plan is
   * empty and the provider's own selector table fills the standard boxes exactly
   * as it did before. A worse fill beats a failed request.
   */
  let planned: PlannedField[] = [];
  let discoveredCount = 0;
  if (hasAutofillModel()) {
    try {
      const found = await fetch(`${WORKER_URL}/ats/discover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ats-token': token },
        body: JSON.stringify({ job_url: job.source_url }),
        signal: AbortSignal.timeout(60_000),
      });
      if (found.ok) {
        const { fields } = (await found.json()) as { fields?: DiscoveredField[] };
        discoveredCount = fields?.length ?? 0;
        if (fields?.length) {
          planned = await planFieldValues({
            jobTitle: job.job_title ?? '',
            company: job.company_name ?? '',
            // Built from the structured profile rather than a prose blob,
            // because this is the same evidence the fact gate checks generated
            // documents against and it has to contain every fact a form could
            // legitimately ask for.
            evidence: profile ? evidenceFor(profile) : '',
            fields,
          });
        }
      }
    } catch (error) {
      console.warn('[autofill] field planning skipped:', (error as Error).message);
    }
  }

  try {
    const response = await fetch(`${WORKER_URL}/ats/prepare`, {
      method: 'POST',
      // x-ats-token, not Authorization: the worker compares this header against
      // its own copy with timingSafeEqual (agents/ats/server.mjs).
      headers: { 'content-type': 'application/json', 'x-ats-token': token },
      body: JSON.stringify({
        job_url: job.source_url,
        candidate,
        // Only the fields that got a value. The rest come back to the human.
        planned: planned.filter((field) => field.value.trim() !== ''),
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
      // Field by field, so the review screen can show what was answered, what was
      // left for the human, and why — rather than a count.
      planned_fields: planned,
      fields_discovered: discoveredCount,
      needs_your_answer: planned.filter((field) => field.needsConfirmation).map((field) => field.label),
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

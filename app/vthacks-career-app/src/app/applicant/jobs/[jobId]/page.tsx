/**
 * /applicant/jobs/[jobId] — the job detail page.
 *
 * WHAT WAS HERE BEFORE: eleven lines that called `redirect('/applicant/jobs')`.
 * There was no job detail page at all, which is also why the voice lane's "take
 * me to that job" landed nowhere useful. This is built from nothing.
 *
 * THE HONEST CONTEXT COMES FIRST, above the toolbox: title, company, location,
 * posted date, source link, and then either the stored match score WITH the
 * reason sentence that was written at match time — zero model calls, it is read
 * back verbatim — or a plain statement that there is no match for this job and
 * no score is being invented. A student who reached this page from the full
 * postings list rather than from their matches gets the tools anyway.
 *
 * SERVER-RENDERED, and the reads are the same ones the endpoints use
 * (`loadContext`, `listArtifacts`). No duplicate query lives in this file.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApplicantNav } from '@/components/ApplicantNav';
import { loadContext } from '@/lib/artifacts/context.mjs';
import { listArtifacts } from '@/lib/artifacts/store.mjs';
import { sql } from '@/lib/databricks';
import { currentStage } from '@/lib/interview';
import { interviewUnlocked } from '@/lib/interview-contract';
import { requireRole } from '@/lib/session';

import { JobDetail } from '@/components/JobDetail';

import { JobToolbox, type Artifact } from './JobToolbox';

import '../../apply/apply.css';
import './toolbox.css';

export const dynamic = 'force-dynamic';

/** A cold warehouse plus four parallel reads plus the artifacts list. */
export const maxDuration = 120;

export async function generateMetadata({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  // Deliberately does NOT hit the warehouse. A metadata function that queries is
  // a second cold-start on every page load, and the title is not worth it.
  return { title: `Job · HireWire`, other: { 'x-hirewire-job': decodeURIComponent(jobId) } };
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value.endsWith('Z') || value.includes('+') ? value : `${value}Z`);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default async function JobDetailPage({ params }: { params: Promise<{ jobId: string }> }) {
  const user = await requireRole('applicant');
  const { jobId } = await params;
  const decoded = decodeURIComponent(jobId);

  let context: Awaited<ReturnType<typeof loadContext>>;
  let loadError: string | null = null;
  try {
    context = await loadContext(sql, user.id, decoded);
  } catch (error) {
    // The warehouse, almost always: a cold start past the poll limit or the
    // transient PERMISSION_DENIED this workspace throws. Rendering the page with
    // the error stated beats a 500 that tells the reader nothing.
    loadError = error instanceof Error ? error.message : String(error);
    context = { ok: false, status: 502, error: loadError };
  }

  if (!context.ok) {
    if (context.status === 404) notFound();
    return (
      <main>
        <ApplicantNav current="jobs" />
        <section className="hero trust-hero">
          <p className="eyebrow">JOB</p>
          <h1>We could not read this posting just now.</h1>
          <p className="muted">
            {context.error} The warehouse cold-starts in 20 to 30 seconds and occasionally returns a
            transient permission error; reloading usually fixes it. Nothing was generated and
            nothing was written.
          </p>
        </section>
      </main>
    );
  }

  const { job, facts, cachedMatch } = context;

  // Read-only and cheap. Serving it from the server means the history is present
  // on first paint instead of appearing a second later.
  let artifacts: Artifact[] = [];
  try {
    artifacts = (await listArtifacts(sql, user.id, job.job_id)) as Artifact[];
  } catch {
    // An empty history renders as "nothing yet", which is wrong but harmless; the
    // client refetches after the first generation either way.
  }

  const posted = formatDate(job.posted_at);

  // One cheap read of the same view the board reads. A rehearsal is only offered
  // once the employer has actually replied, so the page has to know the stage.
  const stage = await currentStage(user.id, job.job_id).catch(() => null);

  return (
    <main>
      <ApplicantNav current="jobs" />

      <section className="hero trust-hero">
        <p className="eyebrow">{job.company_name ?? 'POSTING'}</p>
        <h1>{job.job_title ?? 'Untitled posting'}</h1>
        <ul className="jd-meta">
          {job.location_text ? <li>{job.location_text}</li> : null}
          {posted ? <li>Posted {posted}</li> : null}
          {job.source ? <li>via {job.source}</li> : null}
          <li>{job.description_chars.toLocaleString()} characters of description stored</li>
          {job.source_url ? (
            <li>
              <a href={job.source_url} target="_blank" rel="noreferrer">
                Original posting
              </a>
            </li>
          ) : null}
        </ul>

        {cachedMatch ? (
          <div className="jd-match">
            <div className="jd-score">
              <b>{cachedMatch.score}%</b>
              <span className="muted">
                match · {cachedMatch.recommendation ?? 'no recommendation recorded'}
              </span>
            </div>
            {/* The stored reason sentence, written when the match ran. Read back
                verbatim: showing it costs ZERO model calls, which is exactly why
                the match agent stores it. */}
            {cachedMatch.reason ? <p className="jd-reason">{cachedMatch.reason}</p> : null}
            <p className="jd-reason muted">
              From your match run of {formatDate(cachedMatch.run_started_at) ?? 'an earlier session'}
              . Eligibility: {cachedMatch.eligibility ?? 'not recorded'}
              {cachedMatch.eligibility_reason ? ` — ${cachedMatch.eligibility_reason}` : ''}
            </p>
          </div>
        ) : (
          <div className="jd-match jd-match--none">
            <p className="jd-reason">
              <strong>You have no match score for this posting.</strong> That means it was not in
              your last match run — you probably reached it from the full postings list rather than
              from your matches. We are not going to invent a number for it. Every tool below still
              works, and the free ones will tell you how well you actually line up.
            </p>
          </div>
        )}
      </section>

      {/* The employer check, between the posting and the tools. What it finds
          decides which route is offered: agent-to-agent apply for a verified
          agent, autofill for a real company with no agent, nothing for neither.
          renderRole is false because the hero above already carries the role. */}
      <JobDetail
        renderRole={false}
        job={{
          job_id: job.job_id,
          title: job.job_title ?? '',
          company: job.company_name ?? '',
          location: job.location_text,
          source: job.source,
          source_url: job.source_url,
          posted_at: job.posted_at,
        }}
      />

      {/* Offered above the document toolbox, not inside it: every tool in that
          panel produces a DOCUMENT, and this produces a rehearsal. Only rendered
          once an employer has replied, which is the whole gate. */}
      {interviewUnlocked(stage) ? (
        <section className="panel" aria-labelledby="jd-interview-h">
          <header>
            <div>
              <small>THEY REPLIED</small>
              <h2 id="jd-interview-h">Rehearse this interview</h2>
            </div>
          </header>
          <p>
            Questions built from this posting and your own match gaps, answered one at a time, on camera if you want
            it. Nothing is recorded as video.
          </p>
          <p>
            <Link href={`/applicant/interview/${encodeURIComponent(job.job_id)}`}>Open the mock interview room</Link>
          </p>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="jd-toolbox-h">
        <header>
          <div>
            <small>DOCUMENT TOOLBOX</small>
            <h2 id="jd-toolbox-h">Everything we can do for this job</h2>
          </div>
        </header>

        <JobToolbox
          jobId={job.job_id}
          jobTitle={job.job_title}
          companyName={job.company_name}
          hasDescription={job.has_description}
          descriptionChars={job.description_chars}
          factCount={facts.factCount}
          initialArtifacts={artifacts}
        />
      </section>
    </main>
  );
}

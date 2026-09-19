import Link from 'next/link';
import { ArrowRight, BriefcaseBusiness } from 'lucide-react';

import { ApplicantNav } from '@/components/ApplicantNav';
import { DEMO_JOB, listJobs } from '@/lib/jobs';
import { requireRole } from '@/lib/session';

import '../apply/apply.css';

export const metadata = { title: 'Jobs · HireWire' };
export const dynamic = 'force-dynamic';

function posted(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default async function JobsPage() {
  await requireRole('applicant');
  const { jobs, source } = await listJobs(40);

  return (
    <main>
      <ApplicantNav current="jobs" />
      <section className="hero trust-hero">
        <p className="eyebrow">JOBS</p>
        <h1>Real openings, checked before you apply.</h1>
        <p>
          Postings come straight from employers&apos; public job boards. Open one and your agent looks for that
          employer&apos;s verified agent. No verified agent, no data sent.
        </p>
      </section>

      <section className="panel" aria-labelledby="jobs-h">
        <header>
          <div>
            <small>{source === 'open_us_jobs' ? 'US · POSTED IN THE LAST 3 DAYS' : 'LATEST POSTINGS'}</small>
            <h2 id="jobs-h">Openings</h2>
          </div>
          <BriefcaseBusiness aria-hidden="true" />
        </header>
        <ul className="job-list">
          {[DEMO_JOB, ...jobs].map((job) => (
            <li key={job.job_id}>
              <Link href={`/applicant/jobs/${encodeURIComponent(job.job_id)}`} className="job-row">
                <span>
                  <strong>{job.job_title}</strong>
                  <small>
                    {job.company_name}
                    {job.location_text ? ` · ${job.location_text}` : ''}
                    {posted(job.posted_at) ? ` · posted ${posted(job.posted_at)}` : ''}
                  </small>
                </span>
                {job.demo ? <span className="job-tag">Demo ANS agent</span> : <span className="job-tag muted-tag">{job.source}</span>}
                <ArrowRight size={17} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
        {jobs.length === 0 ? (
          <p className="job-empty">
            {source === 'unavailable'
              ? 'The job feed could not be reached just now. The demo posting still works.'
              : 'No real postings yet. The discovery pipeline fills this list every five minutes once it is running.'}
          </p>
        ) : null}
      </section>
    </main>
  );
}

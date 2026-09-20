import { BriefcaseBusiness } from 'lucide-react';

import { ApplicantNav } from '@/components/ApplicantNav';
import { JobVerificationList } from '@/components/JobVerificationList';
import { applicantJobVerificationMemory } from '@/lib/audit';
import { DEMO_JOB, listJobs } from '@/lib/jobs';
import { requireRole } from '@/lib/session';

import '../apply/apply.css';

export const metadata = { title: 'Jobs · HireWire' };
export const dynamic = 'force-dynamic';

export default async function JobsPage() {
  const user = await requireRole('applicant');
  const [{ jobs, source }, memory] = await Promise.all([
    listJobs(40),
    applicantJobVerificationMemory(user.id),
  ]);

  return (
    <main>
      <ApplicantNav current="jobs" />
      <section className="hero trust-hero">
        <p className="eyebrow">JOBS</p>
        <h1>Real openings, checked before you apply.</h1>
        <p>
          Select a posting and your agent checks the employer in the background. The result stays attached to
          that job in your workspace. No verified agent, no data sent.
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
        <JobVerificationList jobs={[DEMO_JOB, ...jobs]} initialMemory={memory} />
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

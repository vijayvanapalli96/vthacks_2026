/**
 * /applicant/interview/[jobId] — the video mock interview room.
 *
 * WHY THIS PAGE EXISTS AT ALL. The pipeline board could already tell you an employer
 * had replied and then had nothing to offer you about it. "They responded" is the
 * moment a student most needs something to do, and the thing they need is to say
 * their answers out loud once before they have to say them for real.
 *
 * THE SERVER HALF IS SMALL ON PURPOSE. It renders the heading from one cheap job
 * read so the page has a title in the HTML, and hands off. The gate, the questions,
 * the credential and the four upgrade checks all live behind
 * GET /api/interview/[jobId]/session, because the room refetches them when the
 * student starts a second run and duplicating that assembly here would mean two
 * versions of the gate.
 */
import { notFound } from 'next/navigation';

import { AccountButton } from '@/components/AccountButton';
import { ApplicantNav } from '@/components/ApplicantNav';
import { getJob } from '@/lib/jobs';
import { requireRole } from '@/lib/session';

import { InterviewRoom } from './InterviewRoom';
import './interview.css';
import '../../apply/apply.css';

export const dynamic = 'force-dynamic';

/** One read against a warehouse that cold-starts in 20-30 seconds. */
export const maxDuration = 120;

export const metadata = { title: 'Mock interview · HireWire' };

export default async function InterviewPage({ params }: { params: Promise<{ jobId: string }> }) {
  await requireRole('applicant');
  const { jobId } = await params;
  const decoded = decodeURIComponent(jobId);

  // A job that does not resolve is a 404, not an empty room. The stage gate is a
  // different question and is answered inside the room.
  const job = await getJob(decoded).catch(() => null);
  if (!job) notFound();

  return (
    <main>
      <ApplicantNav current="pipeline" account={<AccountButton />} />
      {/* Trimmed to match the pipeline: the room below explains itself as you
          use it, and the camera note moved next to the camera control where it
          is actually needed. */}
      <section className="hero hero-compact">
        <p className="eyebrow">MOCK INTERVIEW</p>
        <h1>
          {job.job_title} at {job.company_name}
        </h1>
        <p className="iv-muted">Camera optional and never recorded. Everything works typed.</p>
      </section>

      <InterviewRoom jobId={decoded} jobTitle={job.job_title} company={job.company_name} />
    </main>
  );
}

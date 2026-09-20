import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';

import { ApplicantNav } from '@/components/ApplicantNav';
import { JobDetail } from '@/components/JobDetail';
import { getJob } from '@/lib/jobs';
import { requireRole } from '@/lib/session';

import '../../apply/apply.css';

export const metadata = { title: 'Job · HireWire' };
export const dynamic = 'force-dynamic';

/**
 * A job opens into its own screen rather than expanding in the list.
 *
 * The list used to run the employer check inline, which put the verdict, the
 * reasons and the next action into a row two lines tall, and made the posting
 * itself - the thing being applied for - the one detail with nowhere to go.
 *
 * job_id is a URL for real postings, so it arrives percent-encoded.
 */
export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  await requireRole('applicant');
  const { jobId } = await params;
  const decoded = decodeURIComponent(jobId);
  const job = await getJob(decoded);
  if (!job) notFound();

  return (
    <main id="main">
      <ApplicantNav current="jobs" />
      <section className="hero trust-hero">
        <p className="eyebrow">
          <Link href="/applicant/jobs">
            <ArrowLeft size={14} aria-hidden="true" /> All openings
          </Link>
        </p>
        <h1>{job.job_title}</h1>
        <p>
          Your agent is checking {job.company_name} now. What you can do next depends on what it finds, and
          nothing about you is sent while it looks.
        </p>
      </section>
      <JobDetail
        job={{
          job_id: job.job_id,
          title: job.job_title,
          company: job.company_name,
          location: job.location_text,
          source: job.source,
          source_url: job.source_url,
          posted_at: job.posted_at,
        }}
      />
    </main>
  );
}

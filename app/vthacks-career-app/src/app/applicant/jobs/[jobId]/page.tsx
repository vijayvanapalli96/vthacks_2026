import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { ApplicantNav } from '@/components/ApplicantNav';
import { EmployerAgentFinder } from '@/components/EmployerAgentFinder';
import { getJob, guessEmployerDomain } from '@/lib/jobs';
import { requireRole } from '@/lib/session';

import '../../apply/apply.css';

export const metadata = { title: 'Job · HireWire' };
export const dynamic = 'force-dynamic';

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  await requireRole('applicant');
  const { jobId } = await params;
  const job = await getJob(decodeURIComponent(jobId));
  if (!job) notFound();

  return (
    <main>
      <ApplicantNav current="jobs" />
      <p className="back-link">
        <Link href="/applicant/jobs">
          <ArrowLeft size={16} aria-hidden="true" /> All jobs
        </Link>
      </p>
      <section className="hero trust-hero">
        <p className="eyebrow">{job.demo ? 'DEMO POSTING · OUR OWN ANS EMPLOYER AGENT' : job.company_name.toUpperCase()}</p>
        <h1>{job.job_title}</h1>
        <p>
          {job.company_name}
          {job.location_text ? ` · ${job.location_text}` : ''}
          {job.source_url && !job.demo ? (
            <>
              {' · '}
              <a href={job.source_url} target="_blank" rel="noreferrer">
                original posting
              </a>
            </>
          ) : null}
        </p>
      </section>
      <div className="trust-flow">
        <EmployerAgentFinder
          jobId={job.job_id}
          jobUrl={job.demo ? null : job.source_url}
          initialDomain={guessEmployerDomain(job)}
          company={job.company_name}
        />
      </div>
    </main>
  );
}

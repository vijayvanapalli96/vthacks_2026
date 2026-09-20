import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { notFound } from 'next/navigation';

import { SignOutForm } from '@/components/SignOutForm';
import { TrustApply } from '@/components/TrustApply';
import { DEMO_JOB, employerHostForJob, getJob } from '@/lib/jobs';
import { requireRole } from '@/lib/session';

import './apply.css';

export const metadata = { title: 'Verify and apply · HireWire' };

export default async function ApplyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole('applicant');
  // Job cards link here with both the employer agent host and the selected job.
  const { host, job: jobParam } = await searchParams;
  const initialHost = typeof host === 'string' && /^[a-z0-9.-]{3,253}$/i.test(host) ? host.toLowerCase() : undefined;
  const jobId = typeof jobParam === 'string' && jobParam.length <= 255 ? jobParam : undefined;
  if (jobParam !== undefined && !jobId) notFound();
  const selectedJob = jobId ? await getJob(jobId) : DEMO_JOB;
  if (!selectedJob) notFound();

  return (
    <main>
      <nav>
        <Link href="/applicant">
          <ArrowLeft size={16} aria-hidden="true" /> Overview
        </Link>
        <SignOutForm />
      </nav>
      <section className="hero trust-hero">
        <p className="eyebrow">VERIFIED APPLY</p>
        <h1>Prove who is asking before anything leaves.</h1>
        <p>
          Your agent looks this employer up in GoDaddy&apos;s Agent Name Service, checks its certificates and published
          card, and scores five trust dimensions — before you are asked to send anything. If it cannot prove who it
          is, your agent refuses and says why.
        </p>
      </section>
      <TrustApply
        name={user.name ?? ''}
        email={user.email ?? ''}
        host={initialHost ?? employerHostForJob(selectedJob)}
        job={{
          job_id: selectedJob.job_id,
          title: selectedJob.job_title,
          company: selectedJob.company_name,
          location: selectedJob.location_text,
          source: selectedJob.source,
          source_url: selectedJob.source_url,
          posted_at: selectedJob.posted_at,
          required_skills: selectedJob.demo ? ['Python', 'SQL'] : undefined,
          preferred_skills: selectedJob.demo ? ['TypeScript'] : undefined,
        }}
      />
      <footer>
        <ShieldCheck aria-hidden="true" />
        <strong>A refusal always releases zero fields.</strong>
        <span>The server re-verifies on every send, so the browser cannot talk it into releasing data.</span>
      </footer>
    </main>
  );
}

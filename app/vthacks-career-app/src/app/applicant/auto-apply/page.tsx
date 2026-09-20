import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

import { AutoApplyQueue } from '@/components/AutoApplyQueue';
import { SignOutForm } from '@/components/SignOutForm';
import { listJobs } from '@/lib/jobs';
import { requireRole } from '@/lib/session';

import '../apply/apply.css';

export const metadata = { title: 'Review and apply as a batch · HireWire' };

export default async function AutoApplyPage() {
  const user = await requireRole('applicant');
  const { jobs } = await listJobs(25);

  return (
    <main>
      <nav>
        <strong>Application Workspace</strong>
        <Link href="/applicant">
          <ArrowLeft size={16} aria-hidden="true" /> Overview
        </Link>
        <SignOutForm />
      </nav>

      <section className="hero trust-hero">
        <p className="eyebrow">BATCH APPLY</p>
        <h1>Verify everyone first. Then decide once.</h1>
        <p>
          Your agent looks up every employer in GoDaddy&apos;s Agent Name Service and scores the same five trust
          dimensions it scores for a single application. That happens before you choose anything, and it releases
          nothing. You then approve the verified employers together — the batch is in how you say yes, not in
          whether anyone checked.
        </p>
      </section>

      {jobs.length ? (
        <AutoApplyQueue
          jobIds={jobs.map((job) => job.job_id)}
          candidate={{ full_name: user.name ?? '', email: user.email ?? '' }}
        />
      ) : (
        <p className="job-empty">
          No open postings are loaded yet, so there is nothing to verify. Run the job scan first.
        </p>
      )}

      <footer>
        <ShieldCheck aria-hidden="true" />
        <strong>A refusal always releases zero fields.</strong> An employer that fails verification appears in
        the refused list with its reason and has no approval control at all.
      </footer>
    </main>
  );
}

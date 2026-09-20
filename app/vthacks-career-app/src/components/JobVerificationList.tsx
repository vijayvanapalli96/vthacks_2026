import Link from 'next/link';
import { BadgeCheck, Check, ChevronRight, ShieldAlert } from 'lucide-react';

import type { ApplicantJobVerificationMemory } from '@/lib/audit';
import type { Job } from '@/lib/jobs';

/**
 * The openings list. Each row is a link into that job's own screen, where the
 * employer check runs and the next action is offered.
 *
 * It used to run the check inline on click, which crammed a verdict, its five
 * reasons and an apply link into a two-line row, and left the posting itself -
 * the thing being applied for - as the only detail with nowhere to go. The
 * badge here is memory of a check already made, not a control.
 *
 * No 'use client': there is nothing to do in the browser any more.
 */
function posted(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function JobVerificationList({
  jobs,
  initialMemory,
}: {
  jobs: Job[];
  initialMemory: Record<string, ApplicantJobVerificationMemory>;
}) {
  return (
    <ul className="job-list">
      {jobs.map((job) => {
        const state = initialMemory[job.job_id];
        return (
          <li key={job.job_id}>
            <Link className="job-row job-row-link" href={`/applicant/jobs/${encodeURIComponent(job.job_id)}`}>
              <span>
                <strong>{job.job_title}</strong>
                <small>
                  {job.company_name}
                  {job.location_text ? ` · ${job.location_text}` : ''}
                  {posted(job.posted_at) ? ` · posted ${posted(job.posted_at)}` : ''}
                </small>
              </span>
              {state?.status === 'verified' ? (
                <span className="job-tag verified-tag">
                  <BadgeCheck size={13} aria-hidden="true" /> Verified agent
                </span>
              ) : state?.status === 'known_employer' ? (
                <span className="job-tag known-tag">
                  <Check size={13} aria-hidden="true" /> Real company
                </span>
              ) : state?.status === 'refused' ? (
                <span className="job-tag refused-tag">
                  <ShieldAlert size={13} aria-hidden="true" /> Not verified
                </span>
              ) : (
                <span className={job.demo ? 'job-tag' : 'job-tag muted-tag'}>
                  {job.demo ? 'ANS demo employer' : (job.source ?? 'Not checked yet')}
                </span>
              )}
              <ChevronRight size={17} aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

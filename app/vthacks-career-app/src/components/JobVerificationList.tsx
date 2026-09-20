'use client';

import Link from 'next/link';
import { Check, Loader2, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import type { Job } from '@/lib/jobs';

type Memory = {
  status: 'verified' | 'refused';
  ansName: string;
  reason: string;
  checkedAt: string;
};

type State = Memory | { status: 'checking'; ansName: ''; reason: ''; checkedAt: '' };

function posted(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function hostFromAnsName(ansName: string) {
  return /^ans:\/\/v\d+\.\d+\.\d+\.(.+)$/i.exec(ansName)?.[1]?.toLowerCase() ?? '';
}

export function JobVerificationList({
  jobs,
  initialMemory,
}: {
  jobs: Job[];
  initialMemory: Record<string, Memory>;
}) {
  const [memory, setMemory] = useState<Record<string, State>>(initialMemory);

  async function verify(job: Job) {
    if (memory[job.job_id]?.status === 'checking') return;
    setMemory((current) => ({
      ...current,
      [job.job_id]: { status: 'checking', ansName: '', reason: '', checkedAt: '' },
    }));
    try {
      const response = await fetch('/api/jobs/discover-agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: job.job_id }),
      });
      const payload = await response.json() as {
        error?: string;
        agent?: { ans_name?: string };
        verification?: { verdict?: 'pass' | 'refuse'; spoken_reason?: string };
      };
      if (!response.ok || !payload.verification) throw new Error(payload.error ?? 'Verification failed.');
      setMemory((current) => ({
        ...current,
        [job.job_id]: {
          status: payload.verification?.verdict === 'pass' ? 'verified' : 'refused',
          ansName: payload.agent?.ans_name ?? '',
          reason: payload.verification?.spoken_reason ?? 'Verification finished.',
          checkedAt: new Date().toISOString(),
        },
      }));
    } catch (error) {
      setMemory((current) => ({
        ...current,
        [job.job_id]: {
          status: 'refused',
          ansName: '',
          reason: error instanceof Error ? error.message : 'Verification could not be completed.',
          checkedAt: new Date().toISOString(),
        },
      }));
    }
  }

  return (
    <ul className="job-list">
      {jobs.map((job) => {
        const state = memory[job.job_id];
        const host = state?.status === 'verified' ? hostFromAnsName(state.ansName) : '';
        return (
          <li key={job.job_id}>
            <button
              type="button"
              className="job-row job-row-button"
              onClick={() => verify(job)}
              disabled={state?.status === 'checking'}
              aria-describedby={state ? `verification-${job.job_id}` : undefined}
            >
              <span>
                <strong>{job.job_title}</strong>
                <small>
                  {job.company_name}
                  {job.location_text ? ` · ${job.location_text}` : ''}
                  {posted(job.posted_at) ? ` · posted ${posted(job.posted_at)}` : ''}
                </small>
              </span>
              {state?.status === 'verified' ? (
                <span className="job-tag verified-tag"><Check size={13} aria-hidden="true" /> Employer verified</span>
              ) : state?.status === 'checking' ? (
                <span className="job-tag checking-tag"><Loader2 size={13} className="spin" aria-hidden="true" /> Checking</span>
              ) : state?.status === 'refused' ? (
                <span className="job-tag refused-tag"><ShieldAlert size={13} aria-hidden="true" /> Not verified</span>
              ) : (
                <span className={job.demo ? 'job-tag' : 'job-tag muted-tag'}>
                  {job.demo ? 'Select to verify' : (job.source ?? 'Select to verify')}
                </span>
              )}
              <span aria-hidden="true">{state?.status === 'verified' ? <Check size={17} /> : null}</span>
            </button>
            {state ? (
              <div className={`job-verification-note is-${state.status}`} id={`verification-${job.job_id}`} role="status">
                <span>{state.status === 'checking' ? 'Checking GoDaddy ANS in the background…' : state.reason}</span>
                {state.status === 'verified' && host ? (
                  <Link href={`/applicant/apply?host=${encodeURIComponent(host)}&job=${encodeURIComponent(job.job_id)}`}>
                    Review and apply
                  </Link>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

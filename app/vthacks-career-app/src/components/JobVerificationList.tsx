'use client';

import Link from 'next/link';
import { BadgeCheck, Check, Loader2, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import type { Job } from '@/lib/jobs';

type Signal = { name: string; passed: boolean; reason: string };

type Memory = {
  /**
   * Three outcomes, not two. `verified` means ANS attested the employer's agent
   * and we checked its certificate. `known_employer` means no agent exists —
   * which today is true of almost every company — but the posting came from the
   * company's own ATS and it operates its domain. Only `verified` may send data.
   */
  status: 'verified' | 'known_employer' | 'refused';
  ansName: string;
  reason: string;
  checkedAt: string;
  signals?: Signal[];
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
        company?: { tier?: 'agent_verified' | 'known_employer' | 'unverified'; signals?: Signal[] };
      };
      if (!response.ok || !payload.verification) throw new Error(payload.error ?? 'Verification failed.');
      const status = payload.verification?.verdict === 'pass'
        ? 'verified'
        : payload.company?.tier === 'known_employer'
          ? 'known_employer'
          : 'refused';
      setMemory((current) => ({
        ...current,
        [job.job_id]: {
          status,
          ansName: payload.agent?.ans_name ?? '',
          reason: payload.verification?.spoken_reason ?? 'Verification finished.',
          checkedAt: new Date().toISOString(),
          signals: payload.company?.signals,
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
                <span className="job-tag verified-tag"><BadgeCheck size={13} aria-hidden="true" /> Verified agent</span>
              ) : state?.status === 'known_employer' ? (
                <span className="job-tag known-tag"><Check size={13} aria-hidden="true" /> Real company</span>
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
                <span>
                  {state.status === 'checking' ? 'Checking GoDaddy ANS in the background…' : state.reason}
                  {/* A badge without its evidence is just a claim. Rule 4. */}
                  {state.status !== 'checking' && state.signals?.length ? (
                    <ul className="job-signals">
                      {state.signals.map((signal) => (
                        <li key={signal.name} className={signal.passed ? 'is-pass' : 'is-fail'}>
                          {signal.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </span>
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

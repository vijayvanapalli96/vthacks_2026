'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, BadgeCheck, Check, Loader2, PenLine, ShieldAlert } from 'lucide-react';

type Signal = { name: string; passed: boolean; reason: string };
type Tier = 'agent_verified' | 'known_employer' | 'unverified';

type Check =
  | { state: 'checking' }
  | { state: 'done'; tier: Tier; reason: string; ansName: string; signals: Signal[] }
  | { state: 'error'; message: string };

type Prepared =
  | { state: 'idle' }
  | { state: 'working' }
  | { state: 'done'; fields: string[]; reason: string; screenshot: string | null }
  | { state: 'error'; message: string };

export type DetailJob = {
  job_id: string;
  title: string;
  company: string;
  location: string | null;
  source: string | null;
  source_url: string | null;
  posted_at: string | null;
};

/**
 * The screen a job opens into. It checks the employer on arrival and then offers
 * the one route actually available for that employer:
 *
 *   agent_verified  an ANS agent answered and its certificate checked out, so
 *                   agent-to-agent apply is possible - signed, audited, and the
 *                   only path that can release a field.
 *   known_employer  a real company with no agent registered, which today is
 *                   almost all of them. There is nobody to hand a packet to, so
 *                   the offer is to fill the company's own form instead.
 *   unverified      neither. No action, and the reason is stated.
 *
 * Offering both routes at once would imply they are interchangeable. They are
 * not: one proves who receives the data, the other only types it into a public
 * form the candidate could have filled themselves.
 */
export function JobDetail({
  job,
  /**
   * The job detail page already leads with title, company, location and the
   * link to the original posting, so it asks for the check alone. Standalone
   * callers get the role panel too.
   */
  renderRole = true,
}: {
  job: DetailJob;
  renderRole?: boolean;
}) {
  const [check, setCheck] = useState<Check>({ state: 'checking' });
  const [prepared, setPrepared] = useState<Prepared>({ state: 'idle' });

  const run = useCallback(async () => {
    setCheck({ state: 'checking' });
    try {
      const response = await fetch('/api/jobs/discover-agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: job.job_id }),
      });
      const payload = (await response.json()) as {
        error?: string;
        agent?: { ans_name?: string };
        verification?: { verdict?: 'pass' | 'refuse'; spoken_reason?: string };
        company?: { tier?: Tier; signals?: Signal[] };
      };
      if (!response.ok || !payload.verification) {
        throw new Error(payload.error ?? 'The check could not be completed.');
      }
      setCheck({
        state: 'done',
        tier: payload.verification.verdict === 'pass' ? 'agent_verified' : (payload.company?.tier ?? 'unverified'),
        reason: payload.verification.spoken_reason ?? '',
        ansName: payload.agent?.ans_name ?? '',
        signals: payload.company?.signals ?? [],
      });
    } catch (error) {
      setCheck({
        state: 'error',
        message: error instanceof Error ? error.message : 'The check could not be completed.',
      });
    }
  }, [job.job_id]);

  // The job was chosen on the previous screen, so there is nothing to confirm.
  useEffect(() => {
    void run();
  }, [run]);

  async function autofill() {
    setPrepared({ state: 'working' });
    try {
      const response = await fetch('/api/jobs/autofill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: job.job_id }),
      });
      const payload = (await response.json()) as {
        error?: string;
        prepared?: { fields_filled?: string[]; spoken_reason?: string; screenshot_path?: string };
      };
      if (!response.ok) throw new Error(payload.error ?? 'Nothing was prepared.');
      const shot = payload.prepared?.screenshot_path?.split('/').pop() ?? null;
      setPrepared({
        state: 'done',
        fields: payload.prepared?.fields_filled ?? [],
        reason: payload.prepared?.spoken_reason ?? 'The application was prepared for your review.',
        screenshot: shot,
      });
    } catch (error) {
      setPrepared({
        state: 'error',
        message: error instanceof Error ? error.message : 'Nothing was prepared.',
      });
    }
  }

  const posted = job.posted_at
    ? new Date(job.posted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  const badgeClass =
    check.state === 'checking'
      ? 'checking-tag'
      : check.state === 'done' && check.tier === 'agent_verified'
        ? 'verified-tag'
        : check.state === 'done' && check.tier === 'known_employer'
          ? 'known-tag'
          : 'refused-tag';

  const agentHost = check.state === 'done' ? check.ansName.replace(/^ans:\/\/v\d+\.\d+\.\d+\./i, '') : '';

  return (
    <>
      {renderRole ? (
      <section className="panel trust-step" aria-labelledby="job-detail-h">
        <header>
          <div>
            <small>THE ROLE</small>
            <h2 id="job-detail-h">{job.title}</h2>
            <p className="trust-who">
              {job.company}
              {job.location ? <span> · {job.location}</span> : null}
              {posted ? <span> · posted {posted}</span> : null}
            </p>
          </div>
          <span className={`job-tag ${badgeClass}`} role="status">
            {check.state === 'checking' ? (
              <>
                <Loader2 size={13} className="spin" aria-hidden="true" /> Checking the employer
              </>
            ) : check.state === 'done' && check.tier === 'agent_verified' ? (
              <>
                <BadgeCheck size={13} aria-hidden="true" /> Verified agent
              </>
            ) : check.state === 'done' && check.tier === 'known_employer' ? (
              <>
                <Check size={13} aria-hidden="true" /> Real company
              </>
            ) : (
              <>
                <ShieldAlert size={13} aria-hidden="true" /> Not verified
              </>
            )}
          </span>
        </header>
        <div className="trust-body">
          <dl className="job-facts">
            {job.source ? (
              <div>
                <dt>Source</dt>
                <dd>{job.source}</dd>
              </div>
            ) : null}
            {/* Only when one actually answered. On a miss this host is the name
                we LOOKED for, and printing it reads as an agent that exists. */}
            {check.state === 'done' && check.tier === 'agent_verified' && agentHost ? (
              <div>
                <dt>Employer agent</dt>
                <dd>{agentHost}</dd>
              </div>
            ) : null}
          </dl>
          {job.source_url ? (
            <p className="job-source-link">
              <a href={job.source_url} target="_blank" rel="noopener noreferrer">
                Read the full posting <ArrowUpRight size={13} aria-hidden="true" />
              </a>
            </p>
          ) : null}
        </div>
      </section>
      ) : null}

      <section
        className={`panel trust-card ${
          check.state === 'done' && check.tier === 'agent_verified'
            ? 'is-pass'
            : check.state === 'done' && check.tier === 'unverified'
              ? 'is-refusing'
              : ''
        }`}
        aria-labelledby="job-check-h"
      >
        <header>
          <div>
            <small>THE EMPLOYER CHECK</small>
            <h2 id="job-check-h">
              {check.state === 'checking'
                ? 'Looking this employer up in ANS…'
                : check.state === 'error'
                  ? 'The check could not be completed'
                  : check.tier === 'agent_verified'
                    ? 'Verified employer agent'
                    : check.tier === 'known_employer'
                      ? 'A real company, with no agent registered'
                      : 'Not verified'}
            </h2>
          </div>
        </header>
        <div className="trust-body">
          {check.state === 'error' ? (
            <>
              <p className="auth-error" role="alert">
                {check.message}
              </p>
              <div className="trust-actions">
                <button type="button" className="secondary" onClick={run}>
                  Try the check again
                </button>
              </div>
            </>
          ) : check.state === 'done' ? (
            <>
              <p className="trust-reason" role={check.tier === 'unverified' ? 'alert' : undefined}>
                {check.reason}
              </p>
              {check.signals.length ? (
                <ul className="job-signals">
                  {check.signals.map((signal) => (
                    <li key={signal.name} className={signal.passed ? 'is-pass' : 'is-fail'}>
                      {signal.reason}
                    </li>
                  ))}
                </ul>
              ) : null}

              {check.tier === 'agent_verified' ? (
                <div className="trust-actions">
                  <Link
                    className="primary"
                    href={`/applicant/apply?host=${encodeURIComponent(agentHost)}&job=${encodeURIComponent(job.job_id)}`}
                  >
                    <BadgeCheck size={18} aria-hidden="true" /> Start agent-to-agent apply
                  </Link>
                  <p className="muted">Signed, audited, and you approve every field before it leaves.</p>
                </div>
              ) : check.tier === 'known_employer' ? (
                <div className="trust-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={autofill}
                    disabled={prepared.state === 'working'}
                  >
                    {prepared.state === 'working' ? (
                      <>
                        <Loader2 size={18} className="spin" aria-hidden="true" /> Filling the form…
                      </>
                    ) : (
                      <>
                        <PenLine size={18} aria-hidden="true" /> Autofill this application
                      </>
                    )}
                  </button>
                  <p className="muted">
                    There is no agent to hand a signed packet to, so your agent fills the company&rsquo;s own form
                    and leaves it for you to review. Nothing is submitted.
                  </p>
                </div>
              ) : null}

              {prepared.state === 'done' ? (
                <div className="job-prepared" role="status">
                  <p>{prepared.reason}</p>
                  {prepared.fields.length ? (
                    <p className="muted">Filled: {prepared.fields.join(', ')}</p>
                  ) : null}
                  {/* The form as the agent left it. Saying "prepared" without
                      showing it asks for trust we have not earned. */}
                  {prepared.screenshot ? (
                    // next/image is the wrong tool here: a private, one-off
                    // artifact behind an authenticated route, served once and
                    // never cached at the edge.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="job-prepared-shot"
                      src={`/api/jobs/autofill/screenshot?name=${encodeURIComponent(prepared.screenshot)}`}
                      alt={`The ${job.company} application form with your name and email filled in, not submitted.`}
                    />
                  ) : null}
                  {job.source_url ? (
                    <p className="job-source-link">
                      <a href={job.source_url} target="_blank" rel="noopener noreferrer">
                        Open the application to finish and submit it yourself
                        <ArrowUpRight size={13} aria-hidden="true" />
                      </a>
                    </p>
                  ) : null}
                </div>
              ) : prepared.state === 'error' ? (
                <p className="auth-error" role="alert">
                  {prepared.message}
                </p>
              ) : null}
            </>
          ) : (
            <p className="trust-reason">
              Checking the ANS registry, the certificate and the published agent card.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

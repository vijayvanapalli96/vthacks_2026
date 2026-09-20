'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Loader2, Search, ShieldAlert, ShieldCheck } from 'lucide-react';

import { AgentBadge } from '@/components/AgentBadge';
import { emitAgentState } from '@/lib/agent-state';

type Found = {
  agent: { ans_name: string };
  verification: { verdict: 'pass' | 'refuse'; spoken_reason: string };
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'found'; ansName: string; host: string; reason: string }
  | { kind: 'none'; reason: string };

function hostFromAnsName(ansName: string) {
  return /^ans:\/\/v\d+\.\d+\.\d+\.(.+)$/i.exec(ansName)?.[1]?.toLowerCase() ?? '';
}

export function EmployerAgentFinder({
  jobId,
  jobUrl,
  initialDomain,
  company,
}: {
  jobId: string;
  jobUrl: string | null;
  initialDomain: string;
  company: string;
}) {
  const [domain, setDomain] = useState(initialDomain);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const heading = useRef<HTMLHeadingElement>(null);
  const inputId = useId();

  useEffect(() => {
    if (phase.kind === 'found' || phase.kind === 'none') heading.current?.focus();
  }, [phase.kind]);

  async function find() {
    const cleaned = domain.trim().toLowerCase();
    if (!cleaned) return;
    setPhase({ kind: 'searching' });
    emitAgentState({ state: 'thinking' });
    try {
      const response = await fetch('/api/jobs/discover-agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: jobId, employer_domain: cleaned }),
      });
      const payload = await response.json();
      if (response.ok) {
        const found = payload as Found;
        setPhase({ kind: 'found', ansName: found.agent.ans_name, host: hostFromAnsName(found.agent.ans_name), reason: found.verification.spoken_reason });
        emitAgentState({ state: 'speaking', spoken_reason: found.verification.spoken_reason });
      } else {
        const reason = `${payload.error ?? 'No verified employer agent was found.'} Hirewire will not send your data to ${company} through an agent.`;
        setPhase({ kind: 'none', reason });
        emitAgentState({ state: 'refusing', spoken_reason: reason });
      }
    } catch {
      const reason = 'The agent registry could not be reached. Nothing was sent.';
      setPhase({ kind: 'none', reason });
      emitAgentState({ state: 'refusing', spoken_reason: reason });
    }
  }

  return (
    <section className="panel trust-step" aria-labelledby="finder-h">
      <header>
        <div>
          <small>STEP 1 · FIND THE EMPLOYER&apos;S AGENT</small>
          <h2 id="finder-h">Is there a verified agent for {company}?</h2>
        </div>
      </header>
      <div className="trust-body">
        <p className="muted">
          Your agent looks up <code>employer.{domain || 'their-domain'}</code> in GoDaddy&apos;s Agent Name Service, then
          the apex and the other subdomains employers register under. Only an exact, active registration counts.
        </p>
        <div className="field">
          <label htmlFor={inputId}>Employer domain</label>
          <input
            id={inputId}
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="company.com"
            aria-describedby={`${inputId}-hint`}
          />
          <small id={`${inputId}-hint`} className="field-hint">
            Guessed from the posting. Correct it if the company uses a different domain.
          </small>
        </div>
        <div className="trust-actions">
          <button type="button" className="primary" onClick={find} disabled={phase.kind === 'searching' || !domain.trim()}>
            {phase.kind === 'searching' ? (
              <>
                <Loader2 size={18} className="spin" aria-hidden="true" /> Searching ANS…
              </>
            ) : (
              <>
                <Search size={18} aria-hidden="true" /> Find employer agent
              </>
            )}
          </button>
        </div>
        <p className="sr-only" aria-live="polite">
          {phase.kind === 'searching' ? 'Searching the Agent Name Service.' : ''}
        </p>
      </div>

      {phase.kind === 'found' ? (
        <div className="trust-card is-pass finder-result">
          <h3 id="finder-result" ref={heading} tabIndex={-1}>
            <ShieldCheck aria-hidden="true" /> Verified agent found
          </h3>
          <AgentBadge party="employer" state="verified" ansName={phase.ansName} reason={phase.reason} size="sm" />
          <Link
            className="primary"
            href={`/applicant/apply?host=${encodeURIComponent(phase.host)}&job=${encodeURIComponent(jobId)}`}
          >
            Review trust and choose what to send <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </div>
      ) : null}

      {phase.kind === 'none' ? (
        <div className="trust-card is-refusing finder-result" role="alert">
          <h3 id="finder-result" ref={heading} tabIndex={-1}>
            <ShieldAlert aria-hidden="true" /> No verified agent. Nothing will be sent.
          </h3>
          <AgentBadge party="employer" state="refused" ansName={`employer.${domain}`} reason={phase.reason} size="sm" />
          {jobUrl ? (
            <p>
              You can still apply yourself on{' '}
              <a href={jobUrl} target="_blank" rel="noreferrer">
                the employer&apos;s own posting
              </a>
              , where you decide what to share.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

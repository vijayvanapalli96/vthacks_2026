'use client';

/**
 * InviteCandidate — the first caller of POST /api/recruit/invite.
 *
 * That endpoint was finished and unreachable: it verifies the applicant's agent
 * in ANS, signs an invitation with the employer identity key, posts it to the
 * applicant agent's endpoint and audits the result — and nothing in the app
 * ever called it. This is the button.
 *
 * It is the mirror of the applicant's apply screen, and it refuses the same way:
 * the verdict the server reached is shown whether it passed or not, a refusal
 * says why in the agent's own words, and no invitation "succeeds" quietly.
 */
import { useState } from 'react';
import { BadgeCheck, Loader2, Send, ShieldAlert } from 'lucide-react';

type Result =
  | { state: 'idle' }
  | { state: 'sending' }
  | {
      state: 'done';
      status: string;
      reason: string;
      auditId: string | null;
      verdict: 'pass' | 'refuse';
    }
  | { state: 'error'; message: string };

export function InviteCandidate({
  applicantAnsName,
  jobs,
}: {
  applicantAnsName: string;
  /** The roles this employer agent can invite for, as {job_id, label}. */
  jobs: Array<{ job_id: string; label: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState(jobs[0]?.job_id ?? '');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<Result>({ state: 'idle' });

  const id = applicantAnsName.replace(/[^a-z0-9]/gi, '-');

  async function send() {
    setResult({ state: 'sending' });
    try {
      const response = await fetch('/api/recruit/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applicant_ans_name: applicantAnsName, job_id: jobId, message: message.trim() }),
      });
      const payload = (await response.json()) as {
        status?: string;
        error?: string;
        audit_id?: string | null;
        verification?: { verdict?: 'pass' | 'refuse'; spoken_reason?: string };
      };
      setResult({
        state: 'done',
        status: payload.status ?? (response.ok ? 'sent' : 'refused'),
        reason:
          payload.verification?.spoken_reason ??
          payload.error ??
          (response.ok ? 'The invitation was delivered.' : 'The invitation was not sent.'),
        auditId: payload.audit_id ?? null,
        verdict: payload.status === 'invitation_sent' ? 'pass' : 'refuse',
      });
    } catch {
      setResult({ state: 'error', message: 'Could not reach the invitation service. Nothing was sent.' });
    }
  }

  if (!open) {
    return (
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        <Send size={15} aria-hidden="true" /> Invite this candidate
        <span className="sr-only"> — {applicantAnsName}</span>
      </button>
    );
  }

  return (
    <div className="trust-body">
      <div className="field">
        <label htmlFor={`job-${id}`}>Role to invite them to</label>
        <select id={`job-${id}`} value={jobId} onChange={(event) => setJobId(event.target.value)}>
          {jobs.map((job) => (
            <option key={job.job_id} value={job.job_id}>
              {job.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`message-${id}`}>What your agent should say</label>
        <textarea
          id={`message-${id}`}
          rows={3}
          value={message}
          maxLength={2000}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Why you are reaching out, in your own words."
        />
      </div>
      <div className="trust-actions">
        <button
          type="button"
          className="primary"
          disabled={result.state === 'sending' || !jobId || message.trim().length === 0}
          onClick={send}
        >
          {result.state === 'sending' ? (
            <>
              <Loader2 size={16} className="spin" aria-hidden="true" /> Verifying their agent…
            </>
          ) : (
            <>
              <Send size={16} aria-hidden="true" /> Verify and send
            </>
          )}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)} disabled={result.state === 'sending'}>
          Cancel
        </button>
      </div>
      <p className="muted">
        Your agent resolves their ANS name, checks the certificate and card, and signs the invitation with this
        employer&rsquo;s identity key. A refusal sends nothing and is still recorded.
      </p>

      {result.state === 'done' ? (
        <p className={result.verdict === 'pass' ? 'trust-reason' : 'auth-error'} role="status">
          {result.verdict === 'pass' ? (
            <BadgeCheck size={15} aria-hidden="true" />
          ) : (
            <ShieldAlert size={15} aria-hidden="true" />
          )}{' '}
          {result.status.replace(/_/g, ' ')} — {result.reason}
          {result.auditId ? <> (audit {result.auditId.slice(0, 8)})</> : null}
        </p>
      ) : null}
      {result.state === 'error' ? (
        <p className="auth-error" role="alert">
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

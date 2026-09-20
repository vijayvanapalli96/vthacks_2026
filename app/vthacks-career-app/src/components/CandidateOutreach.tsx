'use client';

import { useId, useState } from 'react';
import { Loader2, Send, ShieldAlert, ShieldCheck } from 'lucide-react';

import { AgentBadge } from '@/components/AgentBadge';
import { emitAgentState } from '@/lib/agent-state';

/**
 * The employer's outbound half of the handshake. It mirrors the applicant's
 * TrustApply exactly, roles swapped: verify the agent on the other side first,
 * then send a signed envelope that carries the role and a message and no PII —
 * the candidate's own agent decides whether a human ever sees it.
 *
 * Wraps POST /api/recruit/invite, which verifies, signs, and delivers.
 */

export type Candidate = {
  applicant_ans_name: string;
  headline: string | null;
  skills: string[];
  target_roles: string[];
  locations: string[];
};

export type OutreachRole = { job_id: string; title: string; location: string };

type Outcome =
  | { kind: 'sending' }
  | { kind: 'sent'; ansName: string; reason: string; score?: number; receiptId: string | null }
  | { kind: 'undelivered'; ansName: string; reason: string; score?: number }
  | { kind: 'refused'; ansName: string; reason: string; score?: number };

type InviteResponse = {
  status?: 'invitation_sent' | 'delivery_failed' | 'refused' | 'not_sent';
  applicant_ans_name?: string;
  error?: string;
  receipt?: { receipt_id?: string };
  verification?: {
    verdict: 'pass' | 'refuse';
    spoken_reason: string;
    dimensions?: { score: number }[];
  };
};

function averageScore(dimensions: { score: number }[] | undefined) {
  if (!dimensions?.length) return undefined;
  return Math.round(dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length);
}

export function CandidateOutreach({
  candidates,
  roles,
  defaultAnsName,
  unavailable,
}: {
  candidates: Candidate[];
  roles: OutreachRole[];
  defaultAnsName: string;
  unavailable?: string;
}) {
  const [ansName, setAnsName] = useState(defaultAnsName);
  const [jobId, setJobId] = useState(roles[0]?.job_id ?? '');
  const [message, setMessage] = useState(
    'We have an open role that matches your public skills. May we send the full posting to your agent?',
  );
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const fieldId = useId();

  async function invite(target: string) {
    const applicant = target.trim();
    if (!applicant || !jobId || !message.trim()) return;
    setAnsName(applicant);
    setOutcome({ kind: 'sending' });
    emitAgentState({ state: 'thinking' });
    try {
      const response = await fetch('/api/recruit/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applicant_ans_name: applicant, job_id: jobId, message: message.trim() }),
      });
      const payload = (await response.json()) as InviteResponse;
      const score = averageScore(payload.verification?.dimensions);
      const named = payload.applicant_ans_name ?? applicant;

      if (payload.status === 'invitation_sent') {
        const reason = `Invitation delivered to verified applicant ${named}. No candidate data was requested.`;
        setOutcome({ kind: 'sent', ansName: named, reason, score, receiptId: payload.receipt?.receipt_id ?? null });
        emitAgentState({ state: 'speaking', spoken_reason: reason });
        return;
      }
      if (payload.status === 'delivery_failed') {
        const reason = 'This agent verified, but it did not accept the invitation. Nothing is pending on their side.';
        setOutcome({ kind: 'undelivered', ansName: named, reason, score });
        emitAgentState({ state: 'refusing', spoken_reason: reason });
        return;
      }
      const reason =
        payload.verification?.spoken_reason ??
        payload.error ??
        'This agent could not be verified, so no invitation was sent.';
      setOutcome({ kind: 'refused', ansName: named, reason, score });
      emitAgentState({ state: 'refusing', spoken_reason: reason });
    } catch {
      const reason = 'The agent registry could not be reached. Nothing was sent.';
      setOutcome({ kind: 'refused', ansName: applicant, reason });
      emitAgentState({ state: 'refusing', spoken_reason: reason });
    }
  }

  const sending = outcome?.kind === 'sending';

  return (
    <div className="trust-body">
      <p className="muted">
        Your agent resolves the candidate&apos;s ANS name, checks the certificate against their domain, and only then
        sends a signed invitation carrying the role and your message. It never asks for contact details — the
        candidate&apos;s agent brings those, if they approve.
      </p>

      <div className="field">
        <label htmlFor={`${fieldId}-role`}>Role to invite for</label>
        <select id={`${fieldId}-role`} value={jobId} onChange={(event) => setJobId(event.target.value)}>
          {roles.map((role) => (
            <option key={role.job_id} value={role.job_id}>
              {role.title} · {role.location}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${fieldId}-message`}>Message</label>
        <textarea
          id={`${fieldId}-message`}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          maxLength={2000}
          aria-describedby={`${fieldId}-message-hint`}
        />
        <small id={`${fieldId}-message-hint`} className="field-hint">
          Signed with your ANS identity and addressed to that agent only. {2000 - message.length} characters left.
        </small>
      </div>

      {unavailable ? (
        <p className="field-hint">{unavailable}</p>
      ) : candidates.length === 0 ? (
        <p className="field-hint">
          No candidate has opted in to discovery yet. You can still invite an agent by its ANS name below.
        </p>
      ) : (
        <ul className="outreach-list">
          {candidates.map((candidate) => (
            <li key={candidate.applicant_ans_name}>
              <article className="job outreach-row">
                <div>
                  <h3>{candidate.headline ?? 'Open to work'}</h3>
                  <p className="outreach-ans">{candidate.applicant_ans_name}</p>
                  {candidate.skills.length ? (
                    <p className="outreach-skills">
                      {candidate.skills.slice(0, 6).map((skill) => (
                        <span key={skill}>{skill}</span>
                      ))}
                    </p>
                  ) : null}
                </div>
                <span className="verified is-pending">
                  {candidate.target_roles.slice(0, 2).join(' · ') || 'Any role'}
                </span>
                <button
                  type="button"
                  className="secondary trust-speak"
                  onClick={() => invite(candidate.applicant_ans_name)}
                  disabled={sending}
                >
                  {sending && ansName === candidate.applicant_ans_name ? (
                    <>
                      <Loader2 size={16} className="spin" aria-hidden="true" /> Verifying…
                    </>
                  ) : (
                    <>
                      <Send size={16} aria-hidden="true" /> Invite
                    </>
                  )}
                </button>
              </article>
            </li>
          ))}
        </ul>
      )}

      <div className="field">
        <label htmlFor={`${fieldId}-ans`}>Or invite an agent by ANS name</label>
        <input
          id={`${fieldId}-ans`}
          value={ansName}
          onChange={(event) => setAnsName(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="ans://v1.0.0.applicant.example.com"
        />
      </div>

      <div className="trust-actions">
        <button
          type="button"
          className="primary"
          onClick={() => invite(ansName)}
          disabled={sending || !ansName.trim() || !message.trim() || !jobId}
        >
          {sending ? (
            <>
              <Loader2 size={18} className="spin" aria-hidden="true" /> Verifying then sending…
            </>
          ) : (
            <>
              <Send size={18} aria-hidden="true" /> Verify and send invitation
            </>
          )}
        </button>
      </div>

      <p className="sr-only" aria-live="polite">
        {sending ? 'Verifying the applicant agent before sending.' : (outcome && 'reason' in outcome ? outcome.reason : '')}
      </p>

      {outcome && outcome.kind !== 'sending' ? (
        <div
          className={`trust-card finder-result ${outcome.kind === 'sent' ? 'is-pass' : 'is-refusing'}`}
          role={outcome.kind === 'sent' ? undefined : 'alert'}
        >
          <h3>
            {outcome.kind === 'sent' ? (
              <>
                <ShieldCheck aria-hidden="true" /> Invitation sent to a verified agent
              </>
            ) : outcome.kind === 'undelivered' ? (
              <>
                <ShieldAlert aria-hidden="true" /> Verified, but not delivered
              </>
            ) : (
              <>
                <ShieldAlert aria-hidden="true" /> Refused. Nothing was sent.
              </>
            )}
          </h3>
          <AgentBadge
            party="applicant"
            state={outcome.kind === 'sent' ? 'verified' : 'refused'}
            ansName={outcome.ansName}
            reason={outcome.reason}
            score={outcome.score}
            size="sm"
          />
          {outcome.kind === 'sent' ? (
            <p>
              Their agent replied <strong>pending candidate approval</strong>
              {outcome.receiptId ? (
                <>
                  {' '}
                  · receipt <code>{outcome.receiptId}</code>
                </>
              ) : null}
              . A human decides what happens next.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * AgentBadge — the one mark that says whether the agent on the other side of a
 * handshake proved who it is. Both directions use it:
 *
 *   applicant looking at an employer  → <AgentBadge party="employer" … />
 *   employer looking at an applicant  → <AgentBadge party="applicant" … />
 *
 * Three states, each carried by shape AND text, never colour alone: `verified`
 * (shield with a check), `refused` (shield with a cross), `checking` (shield
 * with a dotted arc). The seal is inline SVG so it scales, prints, and needs no
 * network. Colours come from theme tokens.
 */
export type BadgeState = 'verified' | 'refused' | 'checking';

const copy: Record<'employer' | 'applicant', Record<BadgeState, { title: string; detail: string }>> = {
  employer: {
    verified: { title: 'Employer agent verified', detail: 'Registered in ANS, certificate and card match.' },
    refused: { title: 'Employer not verified', detail: 'Nothing will be sent to this agent.' },
    checking: { title: 'Checking the employer', detail: 'Looking the agent up in ANS…' },
  },
  applicant: {
    verified: { title: 'Applicant agent verified', detail: 'A real, domain-anchored candidate agent.' },
    refused: { title: 'Applicant not verified', detail: 'This application is not accepted.' },
    checking: { title: 'Checking the applicant', detail: 'Looking the agent up in ANS…' },
  },
};

function Seal({ state, size }: { state: BadgeState; size: number }) {
  return (
    <svg
      className={`seal seal-${state}`}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="seal-shield"
        d="M24 3.5 42 10v13.5c0 11-7.6 18.6-18 21.5C13.6 42.1 6 34.5 6 23.5V10z"
        fill="none"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {state === 'verified' ? (
        <path className="seal-mark" d="M15 24.5 21.5 31 33 18.5" fill="none" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      {state === 'refused' ? (
        <path className="seal-mark" d="M17 17.5 31 31.5M31 17.5 17 31.5" fill="none" strokeWidth="3.2" strokeLinecap="round" />
      ) : null}
      {state === 'checking' ? (
        <circle className="seal-mark" cx="24" cy="24" r="7.5" fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray="7 6" />
      ) : null}
    </svg>
  );
}

export function AgentBadge({
  party,
  state,
  ansName,
  score,
  reason,
  size = 'md',
}: {
  party: 'employer' | 'applicant';
  state: BadgeState;
  ansName?: string;
  score?: number;
  reason?: string;
  size?: 'sm' | 'md';
}) {
  const text = copy[party][state];
  return (
    <div className={`agent-badge is-${state} size-${size}`}>
      <Seal state={state} size={size === 'sm' ? 30 : 44} />
      <div>
        <strong>{text.title}</strong>
        {ansName ? <span className="agent-badge-name">{ansName}</span> : null}
        <small>
          {reason ?? text.detail}
          {typeof score === 'number' ? ` Trust ${score} of 100.` : ''}
        </small>
      </div>
      {state === 'verified' ? <span className="agent-badge-stamp">ANS</span> : null}
    </div>
  );
}

'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Loader2, ShieldAlert, ShieldCheck, Volume2 } from 'lucide-react';

// Mirrors the /api/verify and /api/apply contracts (TASK_DIVISION.md §4).
type Dimension = { name: string; score: number; reason: string };
type Verification = {
  verdict: 'pass' | 'refuse';
  dimensions: Dimension[];
  spoken_reason: string;
  checked_at: string;
  registry?: { agent_id: string; ans_name: string; status: string };
};
type ApplyResult = {
  status: 'submitted' | 'refused' | 'delivery_failed';
  fields_released: string[];
  audit_id: string;
  spoken_reason: string;
  match_explanation?: { score: number; verdict: string; reasons: string[] };
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'verified'; verification: Verification }
  | { kind: 'refused'; verification: Verification }
  | { kind: 'sending'; verification: Verification }
  | { kind: 'done'; verification: Verification; result: ApplyResult }
  | { kind: 'error'; message: string };

const MIN_DIMENSION = 65;

const targets = [
  {
    host: 'employer.hirewire.biz',
    label: 'Hirewire employer agent',
    detail: 'Our ANS-registered employer agent, hosted on Vultr.',
  },
  {
    host: 'fraud.webmesh.ai',
    label: 'Webmesh fraud test agent',
    detail: "GoDaddy's adversarial test agent, claiming to hire.",
  },
  {
    host: 'agent.webmesh.ai',
    label: 'Webmesh lookalike',
    detail: 'Registered in ANS, but not as an employer.',
  },
];

// A demo role for the Hirewire agent until job_snapshots has real postings.
const demoJob = {
  job_id: 'hirewire-demo-swe-intern',
  title: 'Software Engineering Intern',
  company: 'Hirewire demo employer',
  required_skills: ['Python', 'SQL'],
  preferred_skills: ['TypeScript'],
};

const fieldLabels: Record<string, string> = {
  full_name: 'Full name',
  email: 'Email',
  skills: 'Skills',
  resume_url: 'Resume link',
};

function speak(text: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

export function TrustApply({ name, email, initialHost }: { name: string; email: string; initialHost?: string }) {
  const preset = initialHost && !targets.some((option) => option.host === initialHost) ? initialHost : undefined;
  const [host, setHost] = useState(preset ? 'custom' : (initialHost ?? targets[0].host));
  const [customHost, setCustomHost] = useState(preset ?? '');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [speakAloud, setSpeakAloud] = useState(false);
  const [skills, setSkills] = useState('Python, SQL, TypeScript');
  const [resumeUrl, setResumeUrl] = useState('');
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const customId = useId();

  const target = host === 'custom' ? customHost.trim().toLowerCase() : host;
  const verification = 'verification' in phase ? phase.verification : null;

  const values: Record<string, string> = {
    full_name: name,
    email,
    skills,
    resume_url: resumeUrl,
  };

  // Move focus to the verdict so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (phase.kind === 'verified' || phase.kind === 'refused' || phase.kind === 'done') {
      resultHeading.current?.focus();
    }
  }, [phase.kind]);

  function announce(text: string) {
    if (speakAloud) speak(text);
  }

  async function verify() {
    if (!target) return;
    setApproved({});
    setPhase({ kind: 'verifying' });
    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: target, expected_role: 'employer' }),
      });
      const result = (await response.json()) as Verification;
      setPhase(result.verdict === 'pass' ? { kind: 'verified', verification: result } : { kind: 'refused', verification: result });
      announce(result.spoken_reason);
    } catch {
      setPhase({ kind: 'error', message: 'Could not reach the verification service. Try again.' });
    }
  }

  async function apply(humanApproved: boolean, fields: string[]) {
    if (!verification) return;
    setPhase({ kind: 'sending', verification });
    try {
      const response = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          employer_host: target,
          human_approved: humanApproved,
          requested_fields: fields,
          candidate: {
            full_name: name,
            email,
            resume_url: resumeUrl || undefined,
            skills: skills.split(',').map((skill) => skill.trim()).filter(Boolean),
          },
          job: demoJob,
        }),
      });
      const result = (await response.json()) as ApplyResult;
      setPhase({ kind: 'done', verification, result });
      announce(result.spoken_reason);
    } catch {
      setPhase({ kind: 'error', message: 'Could not reach the apply service. Nothing was confirmed as sent.' });
    }
  }

  const approvedFields = Object.keys(fieldLabels).filter((field) => approved[field] && values[field]);
  const busy = phase.kind === 'verifying' || phase.kind === 'sending';

  return (
    <div className="trust-flow">
      <section className="panel trust-step" aria-labelledby="step-target">
        <header>
          <div>
            <small>STEP 1</small>
            <h2 id="step-target">Who is asking for your application?</h2>
          </div>
        </header>
        <div className="trust-body">
          <fieldset className="role-options">
            <legend>Employer agent to verify</legend>
            {targets.map((option) => (
              <label className="role-option" key={option.host}>
                <input
                  type="radio"
                  name="target"
                  value={option.host}
                  checked={host === option.host}
                  onChange={() => setHost(option.host)}
                  disabled={busy}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small className="trust-host">{option.host}</small>
                  <small>{option.detail}</small>
                </span>
              </label>
            ))}
            <label className="role-option">
              <input
                type="radio"
                name="target"
                value="custom"
                checked={host === 'custom'}
                onChange={() => setHost('custom')}
                disabled={busy}
              />
              <span>
                <strong>Another agent</strong>
                <small>Any hostname, checked live against the ANS registry.</small>
              </span>
            </label>
          </fieldset>
          {host === 'custom' ? (
            <div className="field">
              <label htmlFor={customId}>Agent hostname</label>
              <input
                id={customId}
                value={customHost}
                onChange={(event) => setCustomHost(event.target.value)}
                placeholder="employer.example.com"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          ) : null}
          <div className="trust-actions">
            <button type="button" className="primary" onClick={verify} disabled={busy || !target}>
              {phase.kind === 'verifying' ? (
                <>
                  <Loader2 size={18} className="spin" aria-hidden="true" /> Verifying through ANS…
                </>
              ) : (
                <>
                  <ShieldCheck size={18} aria-hidden="true" /> Verify employer
                </>
              )}
            </button>
            <label className="trust-toggle">
              <input type="checkbox" checked={speakAloud} onChange={(event) => setSpeakAloud(event.target.checked)} />
              Speak verdicts aloud
            </label>
          </div>
          <p className="sr-only" aria-live="polite">
            {phase.kind === 'verifying' ? 'Verifying the employer agent. This takes a few seconds.' : ''}
            {phase.kind === 'sending' ? 'Sending the approved fields.' : ''}
          </p>
        </div>
      </section>

      {phase.kind === 'error' ? (
        <p className="auth-error" role="alert">
          {phase.message}
        </p>
      ) : null}

      {verification ? (
        <section
          className={`panel trust-card ${verification.verdict === 'pass' ? 'is-pass' : 'is-refusing'}`}
          aria-labelledby="trust-verdict"
        >
          <header>
            <div>
              <small>STEP 2 · TRUST CARD</small>
              <h2 id="trust-verdict" ref={resultHeading} tabIndex={-1}>
                {verification.verdict === 'pass' ? (
                  <>
                    <ShieldCheck aria-hidden="true" /> Verified employer
                  </>
                ) : (
                  <>
                    <ShieldAlert aria-hidden="true" /> Refusing. Nothing will be sent.
                  </>
                )}
              </h2>
              <p className="trust-who">
                {verification.registry?.ans_name ?? target}
                <span> · checked {new Date(verification.checked_at).toLocaleTimeString()}</span>
              </p>
            </div>
            <button type="button" className="secondary trust-speak" onClick={() => speak(verification.spoken_reason)}>
              <Volume2 size={16} aria-hidden="true" /> Hear why
            </button>
          </header>
          <div className="trust-body">
            <p className="trust-reason" role={verification.verdict === 'pass' ? undefined : 'alert'}>
              {verification.spoken_reason}
            </p>
            <ul className="trust-dimensions">
              {verification.dimensions.map((dimension) => {
                const meets = dimension.score >= MIN_DIMENSION;
                return (
                  <li key={dimension.name} className={meets ? 'meets' : 'below'}>
                    <div className="trust-dim-head">
                      <strong>{dimension.name}</strong>
                      <span>
                        {dimension.score} / 100 · {meets ? 'meets' : 'below'} the {MIN_DIMENSION} minimum
                      </span>
                    </div>
                    <div className="trust-bar" aria-hidden="true">
                      <span style={{ width: `${Math.max(2, dimension.score)}%` }} />
                    </div>
                    <p>{dimension.reason}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ) : null}

      {phase.kind === 'verified' || (phase.kind === 'sending' && verification?.verdict === 'pass') ? (
        <section className="panel trust-step" aria-labelledby="step-approve">
          <header>
            <div>
              <small>STEP 3 · YOUR APPROVAL</small>
              <h2 id="step-approve">Choose exactly what to send</h2>
            </div>
          </header>
          <div className="trust-body">
            <div className="field">
              <label htmlFor="trust-skills">Skills to share</label>
              <input id="trust-skills" value={skills} onChange={(event) => setSkills(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="trust-resume">Resume link (optional)</label>
              <input
                id="trust-resume"
                type="url"
                value={resumeUrl}
                onChange={(event) => setResumeUrl(event.target.value)}
                placeholder="https://"
              />
            </div>
            <fieldset className="trust-fields">
              <legend>Release to {verification?.registry?.ans_name ?? target}</legend>
              {Object.entries(fieldLabels).map(([field, label]) => (
                <label key={field} className={values[field] ? '' : 'is-empty'}>
                  <input
                    type="checkbox"
                    checked={Boolean(approved[field])}
                    disabled={!values[field] || busy}
                    onChange={(event) => setApproved({ ...approved, [field]: event.target.checked })}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{values[field] || 'Not provided'}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              className="primary"
              disabled={busy || approvedFields.length === 0}
              onClick={() => apply(true, approvedFields)}
            >
              {phase.kind === 'sending' ? (
                <>
                  <Loader2 size={18} className="spin" aria-hidden="true" /> Sending…
                </>
              ) : (
                <>
                  Send {approvedFields.length} approved {approvedFields.length === 1 ? 'field' : 'fields'}{' '}
                  <ArrowRight size={18} aria-hidden="true" />
                </>
              )}
            </button>
          </div>
        </section>
      ) : null}

      {phase.kind === 'refused' || (phase.kind === 'sending' && verification?.verdict === 'refuse') ? (
        <section className="panel trust-step" aria-labelledby="step-proof">
          <header>
            <div>
              <small>STEP 3 · PROVE IT</small>
              <h2 id="step-proof">Try to send anyway</h2>
            </div>
          </header>
          <div className="trust-body">
            <p className="muted">
              This asks the server to send every field, with your approval. The server re-verifies on its own and
              must refuse, releasing nothing.
            </p>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => apply(true, Object.keys(fieldLabels))}
            >
              Attempt to send all fields
            </button>
          </div>
        </section>
      ) : null}

      {phase.kind === 'done' ? (
        <section
          className={`panel trust-card ${phase.result.status === 'submitted' ? 'is-pass' : 'is-refusing'}`}
          aria-labelledby="apply-result"
        >
          <header>
            <div>
              <small>RESULT</small>
              <h2 id="apply-result" ref={resultHeading} tabIndex={-1}>
                {phase.result.status === 'submitted'
                  ? 'Application sent'
                  : phase.result.status === 'refused'
                    ? 'Refused by the server. Nothing was sent.'
                    : 'Delivery failed'}
              </h2>
            </div>
            <button type="button" className="secondary trust-speak" onClick={() => speak(phase.result.spoken_reason)}>
              <Volume2 size={16} aria-hidden="true" /> Hear why
            </button>
          </header>
          <div className="trust-body">
            <p className="trust-reason" role="status">
              {phase.result.spoken_reason}
            </p>
            <dl className="trust-receipt">
              <dt>fields_released</dt>
              <dd>
                <code>{JSON.stringify(phase.result.fields_released)}</code>
              </dd>
              <dt>audit_id</dt>
              <dd>
                <code>{phase.result.audit_id}</code>
              </dd>
              {phase.result.match_explanation ? (
                <>
                  <dt>employer fit</dt>
                  <dd>
                    {phase.result.match_explanation.score} / 100 ({phase.result.match_explanation.verdict}).{' '}
                    {phase.result.match_explanation.reasons.join(' ')}
                  </dd>
                </>
              ) : null}
            </dl>
            <button type="button" className="secondary" onClick={() => setPhase({ kind: 'idle' })}>
              Start over
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

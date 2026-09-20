'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Loader2, ShieldAlert, ShieldCheck, Volume2 } from 'lucide-react';

import { A2ATranscript } from '@/components/A2ATranscript';
import { AgentBadge } from '@/components/AgentBadge';
import { emitAgentState } from '@/lib/agent-state';
import type { Turn } from '@/lib/a2a/transcript';

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
  audit_id: string | null;
  spoken_reason: string;
  match_explanation?: { score: number; verdict: string; reasons: string[] };
  /** The exchange as recorded, saved to `hirewire.a2a_transcripts`. */
  transcript?: Turn[];
  transcript_id?: string | null;
  narrator?: 'gemini' | 'none';
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

type ApplyJob = {
  job_id: string;
  title: string;
  company: string;
  location?: string | null;
  source?: string | null;
  source_url?: string | null;
  posted_at?: string | null;
  required_skills?: string[];
  preferred_skills?: string[];
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

export function TrustApply({
  name,
  email,
  host,
  job,
}: {
  name: string;
  email: string;
  /** Settled before this screen: the employer agent for the job just chosen. */
  host: string;
  job: ApplyJob;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [speakAloud, setSpeakAloud] = useState(false);
  const [skills, setSkills] = useState('Python, SQL, TypeScript');
  const [resumeUrl, setResumeUrl] = useState('');
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  // The chain, appended to as each turn arrives from the stream. Kept next to
  // the phase rather than inside it because it outlives the send: after the
  // result lands, the student is still reading it.
  const [turns, setTurns] = useState<Turn[]>([]);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  // Once per visit. "Check again" re-runs the verification but must not fire a
  // second application at the same employer.
  const autoSent = useRef(false);

  const target = host;
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

  // Announce twice: the browser voice when asked, and the agent-state event any
  // visualiser listens to (the voice orb). See lib/agent-state.ts.
  function announce(verdict: 'pass' | 'refuse', text: string) {
    emitAgentState({ state: verdict === 'refuse' ? 'refusing' : 'speaking', spoken_reason: text });
    if (speakAloud) speak(text);
  }

  const verify = useCallback(async function verify() {
    if (!target) return;
    setApproved({});
    setPhase({ kind: 'verifying' });
    emitAgentState({ state: 'thinking' });
    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: target, expected_role: 'employer' }),
      });
      const result = (await response.json()) as Verification;
      setPhase(result.verdict === 'pass' ? { kind: 'verified', verification: result } : { kind: 'refused', verification: result });
      announce(result.verdict, result.spoken_reason);
    } catch {
      setPhase({ kind: 'error', message: 'Could not reach the verification service. Try again.' });
    }
    // announce/speakAloud are read at call time; re-creating this on every
    // toggle would re-fire the arrival effect below and verify twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // Verify on arrival. The employer is already decided by the job the user
  // picked, so making them press a button to confirm the only option was a
  // step that asked nothing.
  useEffect(() => {
    void verify();
  }, [verify]);

  const postedLabel = job.posted_at
    ? new Date(job.posted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  async function apply(humanApproved: boolean, fields: string[], mode: 'confirmed' | 'auto' = 'confirmed') {
    if (!verification) return;
    setPhase({ kind: 'sending', verification });
    setTurns([]);
    emitAgentState({ state: 'thinking' });
    try {
      // The STREAMING route, so the chain fills in while the handshake runs.
      // Same body, same server-side gate as /api/apply — see the route header.
      const response = await fetch('/api/apply/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          employer_host: target,
          human_approved: humanApproved,
          approval_mode: mode,
          requested_fields: fields,
          candidate: {
            full_name: name,
            email,
            resume_url: resumeUrl || undefined,
            skills: skills.split(',').map((skill) => skill.trim()).filter(Boolean),
          },
          job,
        }),
      });

      // A 401/403 or any other refusal to open the stream answers with plain
      // JSON, so it is read as JSON rather than parsed as an empty chain.
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        const result = (await response.json()) as ApplyResult & { error?: string };
        if (result.error) throw new Error(result.error);
        setPhase({ kind: 'done', verification, result });
        announce(result.status === 'submitted' ? 'pass' : 'refuse', result.spoken_reason);
        return;
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let settled = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        // SSE frames are separated by a blank line; a partial frame stays in
        // the buffer until the rest of it arrives.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          if (!event || !data) continue;
          if (event === 'turn') {
            const turn = JSON.parse(data) as Turn;
            setTurns((current) => [...current, turn]);
          } else if (event === 'result') {
            const result = JSON.parse(data) as ApplyResult;
            settled = true;
            // The saved transcript, with Gemini's lines attached, replaces the
            // turns streamed live — same turns, now narrated.
            if (result.transcript?.length) setTurns(result.transcript);
            setPhase({ kind: 'done', verification, result });
            announce(result.status === 'submitted' ? 'pass' : 'refuse', result.spoken_reason);
          } else if (event === 'error') {
            settled = true;
            throw new Error((JSON.parse(data) as { error?: string }).error ?? 'The application could not be completed.');
          }
        }
      }
      // The connection ended without a result: the exchange may well have
      // happened, so this does not claim it did not.
      if (!settled) {
        setPhase({
          kind: 'error',
          message: 'The connection closed before the result arrived. Check your activity log before sending again.',
        });
      }
    } catch {
      setPhase({ kind: 'error', message: 'Could not reach the apply service. Nothing was confirmed as sent.' });
    }
  }

  // Ticked by default now: these are the fields that WENT, and unticking one is
  // how you take it out of a deliberate re-send.
  const approvedFields = Object.keys(fieldLabels).filter((field) => values[field] && (approved[field] ?? true));
  const busy = phase.kind === 'verifying' || phase.kind === 'sending';
  /** Every field that actually has a value. Empty ones are not sent as blanks. */
  const releasable = Object.keys(fieldLabels).filter((field) => values[field]);

  /**
   * THE SEND, WITH NO CONFIRMATION STEP. Owner decision, 2026-09-20: once the
   * employer's agent has cleared the Trust Index in front of the student, asking
   * them to tick the same fields again was asking them to re-approve a check
   * they had just watched run. A refusal still sends nothing — this changes who
   * presses send, not whether the gate has to pass — and the audit log and the
   * transcript both record that it went automatically rather than by hand.
   *
   * The fields below the result stay editable, and a changed set can be sent
   * again deliberately.
   */
  useEffect(() => {
    if (phase.kind !== 'verified' || autoSent.current || releasable.length === 0) return;
    autoSent.current = true;
    void apply(false, releasable, 'auto');
    // `apply` and the field values are read at call time; adding them here would
    // re-fire this on every keystroke in the skills box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  return (
    <div className="trust-flow">
      {/* The posting itself. Verification starts on arrival: the job was chosen
          on the previous screen, so asking again who to check was a question
          with one possible answer. */}
      <section className="panel trust-step" aria-labelledby="step-job">
        <header>
          <div>
            <small>THE ROLE</small>
            <h2 id="step-job">{job.title}</h2>
            <p className="trust-who">
              {job.company}
              {job.location ? <span> · {job.location}</span> : null}
              {postedLabel ? <span> · posted {postedLabel}</span> : null}
            </p>
          </div>
          <span className={`job-tag ${phase.kind === 'verifying' ? 'checking-tag' : verification?.verdict === 'pass' ? 'verified-tag' : verification ? 'refused-tag' : 'muted-tag'}`}>
            {phase.kind === 'verifying' ? (
              <><Loader2 size={13} className="spin" aria-hidden="true" /> Checking</>
            ) : verification?.verdict === 'pass' ? (
              <><ShieldCheck size={13} aria-hidden="true" /> Verified agent</>
            ) : verification ? (
              <><ShieldAlert size={13} aria-hidden="true" /> Not verified</>
            ) : (
              'Waiting'
            )}
          </span>
        </header>
        <div className="trust-body">
          <dl className="job-facts">
            <div>
              <dt>Employer agent</dt>
              <dd>{target}</dd>
            </div>
            {job.source ? (
              <div>
                <dt>Source</dt>
                <dd>{job.source}</dd>
              </div>
            ) : null}
            {job.required_skills?.length ? (
              <div>
                <dt>Required</dt>
                <dd>{job.required_skills.join(', ')}</dd>
              </div>
            ) : null}
            {job.preferred_skills?.length ? (
              <div>
                <dt>Preferred</dt>
                <dd>{job.preferred_skills.join(', ')}</dd>
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
          <div className="trust-actions">
            {/* Only offered once a check has finished, so it reads as a retry
                rather than as the button that starts the flow. */}
            {phase.kind !== 'verifying' && verification ? (
              <button type="button" className="secondary" onClick={verify} disabled={busy}>
                <ShieldCheck size={16} aria-hidden="true" /> Check again
              </button>
            ) : null}
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
              <small>STEP 1 · TRUST CARD</small>
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
            <AgentBadge
              party="employer"
              state={verification.verdict === 'pass' ? 'verified' : 'refused'}
              ansName={verification.registry?.ans_name ?? target}
              score={Math.round(
                verification.dimensions.reduce((sum, dimension) => sum + dimension.score, 0) /
                  Math.max(verification.dimensions.length, 1),
              )}
            />
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

      {/* Between the trust card and the result, because that is where it
          happens. Live while sending, then the saved, narrated version. */}
      {phase.kind === 'sending' || (phase.kind === 'done' && turns.length > 0) ? (
        <A2ATranscript
          turns={turns}
          live={phase.kind === 'sending'}
          narrator={phase.kind === 'done' ? (phase.result.narrator ?? 'none') : 'none'}
          transcriptId={phase.kind === 'done' ? (phase.result.transcript_id ?? null) : null}
        />
      ) : null}

      {/* STEP 2 IS NO LONGER A GATE. Nothing is held here waiting to be ticked:
          the fields go the moment the check passes, and this panel says which
          ones went and offers a deliberate re-send after an edit. The list is
          still shown field by field, because "we sent your name, email and
          skills" has to be readable without opening the transcript. */}
      {phase.kind === 'verified' || phase.kind === 'sending' || phase.kind === 'done' ? (
        <section className="panel trust-step" aria-labelledby="step-approve">
          <header>
            <div>
              <small>STEP 2 · RELEASED AUTOMATICALLY</small>
              <h2 id="step-approve">
                {phase.kind === 'sending' ? 'Sending these fields now' : 'These fields were sent'}
              </h2>
            </div>
          </header>
          <div className="trust-body">
            <p className="muted">
              A verified employer agent is a proven recipient, so your agent released these the moment the
              Trust Index passed, with no second confirmation. A refusal still sends nothing, and the audit
              log records that this went automatically rather than by hand.
            </p>
            <fieldset className="trust-fields" disabled={busy}>
              <legend>Released to {verification?.registry?.ans_name ?? target}</legend>
              {Object.entries(fieldLabels).map(([field, label]) => (
                <label key={field} className={values[field] ? '' : 'is-empty'}>
                  <input
                    type="checkbox"
                    checked={Boolean(values[field]) && (approved[field] ?? true)}
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
            {/* The one remaining button, and it is a re-send rather than the
                approval: changing the skills line or adding a resume link after
                the fact is the reason it exists. */}
            <button
              type="button"
              className="secondary"
              disabled={busy || approvedFields.length === 0}
              onClick={() => apply(true, approvedFields)}
            >
              {phase.kind === 'sending' ? (
                <>
                  <Loader2 size={18} className="spin" aria-hidden="true" /> Sending…
                </>
              ) : (
                <>
                  Send again with {approvedFields.length} {approvedFields.length === 1 ? 'field' : 'fields'}{' '}
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
                <code>{phase.result.audit_id ?? 'not recorded'}</code>
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

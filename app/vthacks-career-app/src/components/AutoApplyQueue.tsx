'use client';

/**
 * Batch review for verified apply.
 *
 * The one-gesture part of this is APPROVING A REVIEWED LIST, not skipping the
 * review. Three things hold that line and should survive refactoring:
 *
 *   1. A refused employer has no checkbox at all. There is no control to
 *      override the gate, so the UI cannot express the thing hard rule 3
 *      forbids.
 *   2. "Select all" selects the verified ones only, and says so.
 *   3. Sending fans out to POST /api/apply, one job at a time, which is where
 *      the signing, the field allowlist and the audit trail live. This
 *      component has no second path for sending PII.
 */

import { useId, useMemo, useState } from 'react';
import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';

type Dimension = { name: string; score: number; reason: string };

type Entry = {
  job_id: string;
  job_title?: string;
  company?: string;
  employer_host?: string;
  employer_ans_name?: string | null;
  decision: 'pending_confirm' | 'refused' | 'not_found';
  dimensions?: Dimension[];
  spoken_reason: string;
};

type SendState = {
  status: 'submitted' | 'refused' | 'delivery_failed' | 'error';
  fields_released: string[];
  spoken_reason: string;
};

const MIN_DIMENSION = 65;

const FIELD_LABELS: Record<string, string> = {
  full_name: 'Full name',
  email: 'Email',
  resume_url: 'Resume link',
  skills: 'Skills',
};

export function AutoApplyQueue({
  jobIds,
  candidate,
}: {
  jobIds: string[];
  candidate: { full_name: string; email: string; resume_url?: string; skills?: string[] };
}) {
  const headingId = useId();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [fields, setFields] = useState<string[]>(['full_name', 'email']);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Record<string, SendState>>({});
  const [error, setError] = useState<string | null>(null);

  const verified = useMemo(
    () => (entries ?? []).filter((entry) => entry.decision === 'pending_confirm'),
    [entries],
  );
  const refused = useMemo(
    () => (entries ?? []).filter((entry) => entry.decision !== 'pending_confirm'),
    [entries],
  );

  async function runPlan() {
    setPlanning(true);
    setError(null);
    setResults({});
    setApproved(new Set());
    try {
      const response = await fetch('/api/auto-apply/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job_ids: jobIds }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Planning failed (HTTP ${response.status}).`);
      setEntries(body.entries as Entry[]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Planning failed.');
    } finally {
      setPlanning(false);
    }
  }

  function toggle(jobId: string) {
    setApproved((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function toggleField(field: string) {
    setFields((current) =>
      current.includes(field) ? current.filter((item) => item !== field) : [...current, field],
    );
  }

  async function sendApproved() {
    setSending(true);
    setError(null);
    const collected: Record<string, SendState> = {};
    // Sequential on purpose: each call is a real application to a real employer,
    // and a burst of parallel POSTs to the same agent is indistinguishable from
    // an attack from the receiving end.
    for (const entry of verified) {
      if (!approved.has(entry.job_id)) continue;
      try {
        const response = await fetch('/api/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            employer_host: entry.employer_host,
            employer_ans_name: entry.employer_ans_name ?? undefined,
            job: { job_id: entry.job_id },
            candidate,
            requested_fields: fields,
            human_approved: true,
          }),
        });
        const body = await response.json();
        collected[entry.job_id] = {
          status: body.status ?? 'error',
          fields_released: body.fields_released ?? [],
          spoken_reason: body.spoken_reason ?? `HTTP ${response.status}`,
        };
      } catch (caught) {
        collected[entry.job_id] = {
          status: 'error',
          fields_released: [],
          spoken_reason: caught instanceof Error ? caught.message : 'The application could not be sent.',
        };
      }
      setResults({ ...collected });
    }
    setSending(false);
  }

  const approvedCount = verified.filter((entry) => approved.has(entry.job_id)).length;

  return (
    <section className="panel" aria-labelledby={headingId}>
      <header>
        <h2 id={headingId}>Review and apply as a batch</h2>
        <p>
          Your agent verifies every employer first and releases nothing while it does. You then approve the
          verified ones together. Employers that fail verification are listed with the reason and cannot be
          approved.
        </p>
      </header>

      <button type="button" className="primary" onClick={runPlan} disabled={planning || sending}>
        {planning ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
        {planning ? 'Verifying employers…' : `Verify ${jobIds.length} employers`}
      </button>

      {error ? (
        <p className="trust-reason" role="alert">
          {error}
        </p>
      ) : null}

      {entries ? (
        <div aria-live="polite">
          <p>
            {verified.length} verified · {refused.length} refused · nothing has been sent yet.
          </p>

          {verified.length ? (
            <>
              <button
                type="button"
                onClick={() =>
                  setApproved((current) =>
                    current.size === verified.length
                      ? new Set()
                      : new Set(verified.map((entry) => entry.job_id)),
                  )
                }
                disabled={sending}
              >
                {approved.size === verified.length ? 'Clear selection' : 'Select all verified'}
              </button>

              <ul className="job-list">
                {verified.map((entry) => {
                  const result = results[entry.job_id];
                  return (
                    <li key={entry.job_id} className="job-row">
                      <label>
                        <input
                          type="checkbox"
                          checked={approved.has(entry.job_id)}
                          onChange={() => toggle(entry.job_id)}
                          disabled={sending || Boolean(result)}
                        />
                        <strong>{entry.job_title ?? entry.job_id}</strong>
                        <span> · {entry.company ?? entry.employer_host}</span>
                      </label>
                      <p className="trust-reason">{entry.spoken_reason}</p>
                      <details>
                        <summary>Why this employer passed</summary>
                        <ul className="trust-dimensions">
                          {(entry.dimensions ?? []).map((dimension) => {
                            const meets = dimension.score >= MIN_DIMENSION;
                            return (
                              <li key={dimension.name} className={meets ? 'meets' : 'below'}>
                                <div className="trust-dim-head">
                                  <strong>{dimension.name}</strong>
                                  <span>
                                    {dimension.score} / 100 · {meets ? 'meets' : 'below'} the {MIN_DIMENSION}{' '}
                                    minimum
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
                      </details>
                      {result ? (
                        <p className={result.status === 'submitted' ? 'pill pill-pass' : 'pill pill-refuse'}>
                          {result.spoken_reason}
                          {result.fields_released.length
                            ? ` Released: ${result.fields_released.join(', ')}.`
                            : ' Released: nothing.'}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>

              <fieldset>
                <legend>What to send to the approved employers</legend>
                {Object.entries(FIELD_LABELS).map(([field, label]) => (
                  <label key={field}>
                    <input
                      type="checkbox"
                      checked={fields.includes(field)}
                      onChange={() => toggleField(field)}
                      disabled={sending}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>

              <div className="trust-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={sendApproved}
                  disabled={sending || approvedCount === 0 || fields.length === 0}
                >
                  {sending ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
                  {sending
                    ? 'Sending…'
                    : `Send ${approvedCount} application${approvedCount === 1 ? '' : 's'}`}
                </button>
                <p>
                  <ShieldCheck size={14} aria-hidden="true" /> {approvedCount} approved of {verified.length}{' '}
                  verified. Each is signed and sent individually, and each is audited.
                </p>
              </div>
            </>
          ) : null}

          {refused.length ? (
            <section aria-labelledby={`${headingId}-refused`}>
              <h3 id={`${headingId}-refused`}>
                <ShieldAlert size={16} aria-hidden="true" /> Refused — no fields released
              </h3>
              <ul className="job-list">
                {refused.map((entry) => (
                  <li key={entry.job_id} className="job-row">
                    <strong>{entry.job_title ?? entry.job_id}</strong>
                    <span> · {entry.company ?? entry.employer_host}</span>
                    {/* No checkbox, deliberately: there is no control that can
                        approve a refusal, so the UI cannot express it. */}
                    <p className="trust-reason" role="alert">
                      {entry.spoken_reason}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

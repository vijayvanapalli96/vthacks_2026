'use client';

/**
 * The live attack console (F7.10).
 *
 * Runs the threat battery against our own employer agent, live, and shows what
 * it did. Two rules about how this reports, both of which matter more than the
 * counter looking good:
 *
 *   1. The control probe is displayed as prominently as the blocks. A gate that
 *      refuses everything is an outage, and a console that hides that is a
 *      commercial for an outage.
 *   2. A leak renders in the failure colour and says so. The number that is
 *      allowed to be zero is the leak count, not the block count.
 */

import { useState } from 'react';
import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';

import type { ProbeResult } from '@/lib/ans/attack-probes';

type Summary = {
  blocked: number;
  attacks: number;
  control_accepted: boolean;
  leaked: number;
  passed: boolean;
};

type Run = { target: string; results: ProbeResult[]; summary: Summary; ran_at: string };

export function AttackConsole() {
  const [run, setRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fire() {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch('/api/attack', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `The battery failed (HTTP ${response.status}).`);
      setRun(body as Run);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The battery failed.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="attack-heading">
      <header>
        <h2 id="attack-heading">Attack console</h2>
        <p>
          Twelve probes against our own employer agent, live: forged signatures, replays, a swapped audience, a
          rewritten payload, stale and future-dated envelopes. One of them is a genuine application that must be
          accepted — a gate that refuses everything is an outage, not a gate.
        </p>
      </header>

      <button type="button" className="primary" onClick={fire} disabled={running}>
        {running ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
        {running ? 'Running the battery…' : 'Run the battery'}
      </button>

      {error ? (
        <p className="trust-reason" role="alert">
          {error}
        </p>
      ) : null}

      {run ? (
        <div aria-live="polite">
          <div className="attack-score">
            <p>
              <strong className={run.summary.leaked ? 'attack-leak' : undefined}>
                {run.summary.blocked}/{run.summary.attacks}
              </strong>
              attacks blocked
            </p>
            <p className={run.summary.control_accepted ? 'attack-control' : 'attack-control-bad'}>
              {run.summary.control_accepted
                ? 'Genuine application accepted.'
                : 'The genuine application was refused — the endpoint is down, not secure.'}
            </p>
            {run.summary.leaked ? (
              <p className="attack-leak" role="alert">
                {run.summary.leaked} attack{run.summary.leaked === 1 ? '' : 's'} got through. Fix before demoing.
              </p>
            ) : null}
          </div>

          <p>
            Target <code>{run.target}</code> · every probe below is written to the audit log as it runs.
          </p>

          <ul className="attack-list">
            {run.results.map((result) => (
              <li key={result.id}>
                <span className={result.correct ? (result.expect === 'accept' ? 'attack-control' : undefined) : 'attack-leak'}>
                  {result.expect === 'accept'
                    ? result.correct
                      ? 'ACCEPTED'
                      : 'WRONGLY REFUSED'
                    : result.correct
                      ? 'BLOCKED'
                      : 'LEAKED'}
                  {' '}
                  [{result.status}]
                </span>
                <span>
                  <strong>{result.label}</strong>
                  <em>{result.threat}</em>
                  {result.reason ? <span>{result.reason}</span> : null}
                </span>
              </li>
            ))}
          </ul>

          <p>
            {run.summary.passed ? (
              <>
                <ShieldCheck size={14} aria-hidden="true" /> Every probe behaved correctly.
              </>
            ) : (
              <>
                <ShieldAlert size={14} aria-hidden="true" /> This run did not fully pass.
              </>
            )}{' '}
            Ran at {new Date(run.ran_at).toLocaleTimeString()}.
          </p>
        </div>
      ) : null}
    </section>
  );
}

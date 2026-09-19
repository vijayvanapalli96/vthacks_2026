'use client';

/**
 * The waiting screen, which is really a log viewer.
 *
 * The user is going to sit here for 30-60 seconds, so the design decision is to show
 * them exactly what is happening to their data — which file is being fetched, which
 * model is reading it, how many facts were recorded, what is still unknown. A
 * spinner would be less work and would teach them nothing about a product whose
 * pitch is that it explains itself.
 *
 * POST rather than EventSource: EventSource can only issue GET requests, and kicking
 * off work that writes to the profile from a GET is the kind of thing a prefetch or a
 * link preview will fire for you by accident.
 *
 * ACCESSIBILITY. The list is aria-live="polite" so a screen reader hears each step
 * as it settles; the per-line spinner is decorative and the state is carried in text.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

type Line = {
  id: string;
  label: string;
  detail?: string;
  state: 'start' | 'ok' | 'warn' | 'skip';
  ms?: number;
};

type Outcome =
  | { kind: 'running' }
  | { kind: 'complete'; factsAppended: number; openGaps: number; ms: number }
  | { kind: 'error'; message: string };

const MARK: Record<Line['state'], string> = {
  start: '…',
  ok: '✓',
  warn: '!',
  skip: '–',
};

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function IntakeProgress() {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>([]);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'running' });
  // React 19 runs effects twice in development. Without this the analysis would be
  // kicked off twice, and while the content-hash check makes that harmless for the
  // documents, it would double the log and waste a model call.
  const started = useRef(false);
  const doneAction = useRef<HTMLButtonElement | null>(null);

  /**
   * One run of the analysis, from kick-off to the last event.
   *
   * Extracted from the effect so "Try again" can call it directly. router.refresh()
   * alone would not do it: this component stays mounted across a refresh, so the
   * `started` guard would still be set and nothing would re-run.
   */
  const run = useCallback(async () => {
    setLines([]);
    setOutcome({ kind: 'running' });

    /**
     * Deliberately NO AbortController and NO cleanup.
     *
     * THE BUG THIS REPLACES, because it is easy to reintroduce: Strict Mode runs
     * this effect twice. The first version aborted the request in its cleanup, so
     * pass one started the fetch, the simulated unmount killed it before it left the
     * browser, and pass two hit the `started` guard above — refs survive that
     * remount — and returned without re-sending. The server never saw a request and
     * the page sat on "Starting up" forever, silently, because the catch recognised
     * its own abort and said nothing. A cleanup that nulls a liveness flag has the
     * same failure: it disables the UI updates of the one request still running.
     *
     * Nothing needs cancelling. This request is not a read — it writes the user's
     * profile — so navigating away should let it finish, not interrupt it halfway.
     * And a setState on an unmounted component is a silent no-op in React 19, so a
     * liveness guard would only buy back the bug.
     */
    try {
      const res = await fetch('/api/intake/analyze', { method: 'POST' });
      if (!res.ok || !res.body) {
        setOutcome({ kind: 'error', message: `The analysis could not start (${res.status}).` });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Standard SSE framing: events are separated by a blank line, and a single
      // read can contain a partial event, so the tail stays in the buffer.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';

        for (const chunk of chunks) {
          const payload = chunk
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          if (!payload) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }

          if (event.type === 'log') {
            const line = event as unknown as Line;
            setLines((previous) => {
              const index = previous.findIndex((entry) => entry.id === line.id);
              if (index === -1) return [...previous, line];
              const next = [...previous];
              next[index] = line;
              return next;
            });
          } else if (event.type === 'complete') {
            setOutcome({
              kind: 'complete',
              factsAppended: Number(event.factsAppended ?? 0),
              openGaps: Number(event.openGaps ?? 0),
              ms: Number(event.ms ?? 0),
            });
          } else if (event.type === 'error') {
            setOutcome({ kind: 'error', message: String(event.message ?? 'Something failed.') });
          }
        }
      }
    } catch (error) {
      setOutcome({ kind: 'error', message: (error as Error).message });
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  /**
   * Move focus to the continue action once the run finishes.
   *
   * This is focus management after an async state change, not `autoFocus` on page
   * load — the distinction the jsx-a11y rule cannot make. A keyboard user who has
   * been waiting a minute should not have to hunt for where the page went; the
   * aria-live log has already announced each step, so the move is expected rather
   * than a surprise.
   */
  useEffect(() => {
    if (outcome.kind === 'complete') doneAction.current?.focus();
  }, [outcome.kind]);

  // Deliberately NOT an automatic redirect. The log is the most informative thing
  // this product shows about itself, and yanking it away the instant it completes
  // means nobody ever reads it. The button is focused instead.
  return (
    <div className="progress">
      <ol className="progress-log" aria-live="polite" aria-busy={outcome.kind === 'running'}>
        {lines.map((line) => (
          <li key={line.id} className={`progress-line is-${line.state}`}>
            <span className="progress-mark" aria-hidden="true">
              {MARK[line.state]}
            </span>
            <span className="progress-body">
              <strong>{line.label}</strong>
              {line.detail ? <small>{line.detail}</small> : null}
            </span>
            <span className="progress-ms">{line.ms === undefined ? '' : seconds(line.ms)}</span>
          </li>
        ))}
        {lines.length === 0 ? (
          <li className="progress-line is-start">
            <span className="progress-mark" aria-hidden="true">
              …
            </span>
            <span className="progress-body">
              <strong>Starting up</strong>
              <small>
                The first query wakes the Databricks warehouse, which can take 20-30 seconds.
              </small>
            </span>
            <span className="progress-ms" />
          </li>
        ) : null}
      </ol>

      {/* Completion reveals the dashboard in place instead of navigating: this IS the
          dashboard already. router.refresh() re-runs the server component, which now
          sees no outstanding analysis and renders the real workspace.

          Not automatic on purpose. This log is the most informative thing the product
          shows about itself, and replacing it the instant it finishes means nobody
          ever reads it. */}
      {outcome.kind === 'complete' ? (
        <div className="progress-done">
          <p role="status">
            <strong>Done in {seconds(outcome.ms)}.</strong> {outcome.factsAppended} facts recorded,{' '}
            {outcome.openGaps} question{outcome.openGaps === 1 ? '' : 's'} left for the voice agent
            to ask.
          </p>
          <button className="primary" type="button" onClick={() => router.refresh()} ref={doneAction}>
            Show my workspace
          </button>
          <a className="ghost" href="/applicant/profile">
            See my profile
          </a>
        </div>
      ) : null}

      {outcome.kind === 'error' ? (
        <div className="progress-error" role="alert">
          <p>
            <strong>That did not finish.</strong> {outcome.message}
          </p>
          <p className="muted">
            Your uploads are safe — they are already stored. Retrying re-reads only what is left,
            so nothing is recorded twice.
          </p>
          <button className="primary" type="button" onClick={() => void run()}>
            Try again
          </button>
          <a className="ghost" href="/applicant/profile">
            See my profile
          </a>
        </div>
      ) : null}
    </div>
  );
}

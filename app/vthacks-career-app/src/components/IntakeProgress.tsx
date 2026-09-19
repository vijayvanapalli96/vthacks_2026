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
import { useEffect, useRef, useState } from 'react';

type Line = {
  id: string;
  label: string;
  detail?: string;
  state: 'start' | 'ok' | 'warn' | 'skip';
  ms?: number;
};

type Outcome =
  | { kind: 'running' }
  | { kind: 'complete'; factsAppended: number; openGaps: number; next: string; ms: number }
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
  const [lines, setLines] = useState<Line[]>([]);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'running' });
  // React 19 runs effects twice in development. Without this the analysis would be
  // kicked off twice, and while the content-hash check makes that harmless for the
  // documents, it would double the log and waste a model call.
  const started = useRef(false);
  const doneAction = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch('/api/intake/analyze', {
          method: 'POST',
          signal: controller.signal,
        });
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
                next: String(event.next ?? '/applicant'),
                ms: Number(event.ms ?? 0),
              });
            } else if (event.type === 'error') {
              setOutcome({ kind: 'error', message: String(event.message ?? 'Something failed.') });
            }
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setOutcome({ kind: 'error', message: (error as Error).message });
      }
    })();

    return () => controller.abort();
  }, []);

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

      {outcome.kind === 'complete' ? (
        <div className="progress-done">
          <p role="status">
            <strong>Done in {seconds(outcome.ms)}.</strong> {outcome.factsAppended} facts recorded,{' '}
            {outcome.openGaps} question{outcome.openGaps === 1 ? '' : 's'} left for the voice agent
            to ask.
          </p>
          <a className="primary" href={outcome.next} ref={doneAction}>
            Go to my workspace
          </a>
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
            Your uploads are safe — they are already stored. Reloading this page retries the
            reading step, and anything already read is not read twice.
          </p>
          <a className="primary" href="/applicant/intake/processing">
            Try again
          </a>
          <a className="ghost" href="/applicant">
            Skip for now
          </a>
        </div>
      ) : null}
    </div>
  );
}

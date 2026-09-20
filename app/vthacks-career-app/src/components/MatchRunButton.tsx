'use client';

/**
 * The manual "run a match" button, for the case where there is no cached run.
 *
 * WHY THIS EXISTS RATHER THAN AN AUTOMATIC RUN ON PAGE LOAD. A match is one
 * embedding plus up to 20 model calls and 30-60 seconds, so auto-running it on
 * every visit to /applicant would mean a forty-second dashboard and a model bill
 * for anyone who merely opened the page. The AUTOMATIC run happens exactly once,
 * when intake finishes (see IntakeProgress). This button is for afterwards: a
 * cache that has aged out, or an account that skipped intake.
 *
 * The body is EMPTY — no `refresh` — so the 45-minute cache in run.mjs makes a
 * double click cost zero model calls instead of double.
 *
 * It reports what happened in words, in a role="status" region, and it never
 * says "no matches" when the truth is that the run failed: those are two
 * different sentences below and they are not interchangeable.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import './match.css';

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; matches: number; top: number | null; seconds: number | null; cached: boolean }
  | { kind: 'failed'; message: string };

type MatchApiResponse = {
  matches?: { score?: unknown; reason?: unknown }[];
  run?: { wall_clock_seconds?: unknown; cached?: unknown };
  error?: unknown;
};

export function MatchRunButton({ label = 'Run a match now' }: { label?: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'idle' });

  const run = useCallback(async () => {
    setState({ kind: 'running' });
    try {
      // No body at all. The route treats an unparseable/absent body as "defaults",
      // which is the documented common case, and defaults mean the cache applies.
      const res = await fetch('/api/match', { method: 'POST' });
      const payload = (await res.json()) as MatchApiResponse;

      if (!res.ok) {
        setState({
          kind: 'failed',
          message:
            typeof payload.error === 'string'
              ? payload.error
              : `The match agent answered ${res.status}.`,
        });
        return;
      }

      const matches = Array.isArray(payload.matches) ? payload.matches : [];
      // `score` is ALREADY 0-100 (rerank.mjs clamps it). No multiplication.
      const top = matches.length
        ? Math.round(Math.max(...matches.map((row) => Number(row.score) || 0)))
        : null;
      const seconds = Number(payload.run?.wall_clock_seconds);

      setState({
        kind: 'done',
        matches: matches.length,
        top,
        seconds: Number.isFinite(seconds) ? seconds : null,
        cached: payload.run?.cached === true,
      });
      // Re-renders the server component, which now reads the fresh cached run.
      router.refresh();
    } catch (error) {
      setState({ kind: 'failed', message: (error as Error).message });
    }
  }, [router]);

  return (
    <div className="match-run">
      <button
        type="button"
        className="primary"
        onClick={() => void run()}
        disabled={state.kind === 'running'}
      >
        {state.kind === 'running' ? 'Matching…' : label}
      </button>

      {/* One live region, three honest sentences. */}
      <p className="match-run-status" role="status">
        {state.kind === 'running'
          ? 'Reading your profile, embedding it, and scoring the freshest US postings. The first query also wakes the warehouse, which takes 20-30 seconds.'
          : null}
        {state.kind === 'done' && state.matches > 0
          ? `${state.matches} match${state.matches === 1 ? '' : 'es'}, top score ${state.top}%${
              state.seconds !== null ? `, in ${state.seconds}s` : ''
            }${state.cached ? ' (served from the cached run, no model calls)' : ''}.`
          : null}
        {state.kind === 'done' && state.matches === 0
          ? 'The run finished and nothing cleared the bar. That is a real answer, not a failure — the reasons are in the panel below.'
          : null}
        {state.kind === 'failed'
          ? `The match did not run: ${state.message} Nothing was changed, and this is a failure rather than an empty result.`
          : null}
      </p>
    </div>
  );
}

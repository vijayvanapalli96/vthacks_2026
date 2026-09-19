'use client';

/**
 * The result panel both intake forms render.
 *
 * Errors are role="alert" (interrupt — the user needs to act) while successes are
 * role="status" (polite — they can finish reading first). Getting that distinction
 * right is the difference between an announcement that helps and one that talks
 * over the user.
 */
import Link from 'next/link';

import type { IntakeState } from '@/app/actions/intake';

export function IntakeOutcome({
  state,
  nextHref,
  nextLabel,
}: {
  state: IntakeState;
  nextHref: string;
  nextLabel: string;
}) {
  if (!state) return null;

  if (state.status === 'error') {
    return (
      <p className="outcome outcome-error" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <div className="outcome outcome-ok" role="status">
      <p className="outcome-headline">{state.message}</p>

      <ul className="outcome-facts">
        {state.factsAppended != null && state.factsAppended > 0 && (
          <li>
            {state.factsAppended} {state.factsAppended === 1 ? 'fact' : 'facts'} added to your profile
            memory
          </li>
        )}
        {state.model && <li>Read by {state.model}</li>}
        {state.openGaps != null && (
          <li>
            {state.openGaps === 0
              ? 'Nothing left for me to ask about.'
              : `${state.openGaps} ${state.openGaps === 1 ? 'question' : 'questions'} left for me to ask you`}
          </li>
        )}
      </ul>

      {state.warnings && state.warnings.length > 0 && (
        <details className="outcome-warnings">
          <summary>What happened under the hood ({state.warnings.length})</summary>
          <ul>
            {state.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="outcome-next">
        <Link href={nextHref}>{nextLabel}</Link>
        <span aria-hidden="true"> · </span>
        <Link href="/applicant/profile">See my profile</Link>
      </p>
    </div>
  );
}

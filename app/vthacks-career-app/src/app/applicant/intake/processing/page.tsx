import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { IntakeProgress } from '@/components/IntakeProgress';
import { nextIntakeStep } from '@/lib/intake';
import { requireRole } from '@/lib/session';

import '../intake.css';

export const metadata: Metadata = {
  title: 'Reading what you gave me · HireWire',
};

/**
 * Step three: the only slow step.
 *
 * Guarded against arriving early — with nothing collected there is nothing to read,
 * and rendering a progress log over an empty queue would be theatre. nextIntakeStep
 * sends people back to whichever step they have not finished.
 */
export default async function IntakeProcessingPage() {
  const user = await requireRole('applicant');
  const step = await nextIntakeStep(user.id);
  if (step && step !== '/applicant/intake/processing') redirect(step);

  return (
    <main>
      <nav>
        <strong>Application Workspace</strong>
        <Link href="/applicant">Overview</Link>
        <Link href="/applicant/profile">Profile</Link>
      </nav>

      <div className="intake-shell">
        <ol className="intake-steps">
          <li className="is-done">1. Resume</li>
          <li className="is-done">2. LinkedIn</li>
          <li aria-current="step">3. Reading</li>
        </ol>

        <p className="eyebrow">STEP THREE</p>
        <h1>Reading everything you gave me.</h1>
        <p className="muted">
          One pass over every source at once, so a detail missing from one can be filled in by
          another. Below is the actual work, as it happens — including the parts that do not go
          perfectly.
        </p>

        <IntakeProgress />
      </div>
    </main>
  );
}

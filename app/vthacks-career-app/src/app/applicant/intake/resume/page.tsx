import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { ResumeIntakeForm } from '@/components/ResumeIntakeForm';
import { intakeGate } from '@/lib/intake';
import { requireRole } from '@/lib/session';

import '../intake.css';

export const metadata: Metadata = {
  title: 'Add your resume · HireWire',
};

/**
 * No <nav>. Intake is one screen and the only way out of it is adding the file, so a
 * sticky bar with one link in it was chrome on the emptiest page in the app. Every
 * other applicant route still has it; this is deliberate here, not an omission.
 *
 * IT GUARDS ITSELF. intakeGate() decided who gets ROUTED here, but routing is not the
 * only way in: the back button, a bookmark and a pasted URL all reach a page directly.
 * Without this check a user who had already uploaded could land back on the form and
 * stage a second document for the same step. The gate is the single source of truth for
 * "is collecting finished", so this asks it the same question rather than inventing a
 * second rule that could disagree with it.
 *
 * WHERE IT SENDS A FINISHED USER MATTERS, and '/applicant' was the wrong answer. Back
 * from the dashboard lands here, here redirected to the dashboard, and the browser's
 * back button therefore did nothing at all — press it and you bounce straight forward
 * again, which is what "something wrong with the routes" looked like. Sending them to
 * the landing page instead means back walks OUT of the app the way it should, and the
 * resume screen is never seen twice.
 *
 * `nextStep` is still honoured when it names another collection step, so if one is ever
 * added ahead of the dashboard this sends people to it rather than past it.
 */
export default async function ResumeIntakePage() {
  const user = await requireRole('applicant');
  const { nextStep } = await intakeGate(user.id);
  if (nextStep !== '/applicant/intake/resume') redirect(nextStep ?? '/');

  return (
    <main>
      <div className="intake-shell">
        {/* No step counter. There is one step, and "Step 1 of 1" is a progress
            indicator for a journey nobody is on. */}
        <h1>Start with your resume.</h1>
        <p className="muted">
          Add it and I start reading straight away — you can watch on the next screen.
        </p>

        <ResumeIntakeForm />
      </div>
    </main>
  );
}

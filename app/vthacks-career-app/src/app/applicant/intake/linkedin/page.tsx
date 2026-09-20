import type { Metadata } from 'next';

import { LinkedInIntakeForm } from '@/components/LinkedInIntakeForm';

import '../intake.css';

export const metadata: Metadata = {
  title: 'Add your LinkedIn · HireWire',
};

/**
 * NOT A STEP IN THE FLOW ANY MORE. intakeGate() used to send every new account here
 * after the resume; it does not, because a LinkedIn URL is not readable (no public
 * profile API, login wall on anonymous requests) and so this screen collected a string
 * we could display and nothing we could act on. It is now an optional addition, reached
 * from /applicant/profile, and the copy says only what is true of it.
 *
 * No <nav>, for the reason given in ../resume/page.tsx; the way back sits in the form's
 * own action row so every way off this screen is in one place.
 */
export default function LinkedInIntakePage() {
  return (
    <main>
      <div className="intake-shell">
        <h1>Add your LinkedIn.</h1>
        <p className="muted">
          This goes on your applications. I save it and show it — I cannot read the page,
          because LinkedIn blocks that.
        </p>

        <LinkedInIntakeForm />
      </div>
    </main>
  );
}

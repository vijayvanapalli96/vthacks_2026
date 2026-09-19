import type { Metadata } from 'next';
import Link from 'next/link';

import { LinkedInIntakeForm } from '@/components/LinkedInIntakeForm';

import '../intake.css';

export const metadata: Metadata = {
  title: 'Add your LinkedIn · HireWire',
};

export default function LinkedInIntakePage() {
  return (
    <main>
      <nav>
        <strong>Application Workspace</strong>
        <Link href="/applicant">Overview</Link>
        <Link href="/applicant/profile">Profile</Link>
      </nav>

      <div className="intake-shell">

        <p className="eyebrow">STEP TWO</p>
        <h1>Add your LinkedIn.</h1>
        <p className="muted">
          It goes on your profile and travels with anything I send on your behalf. This is the last
          thing I ask for — next I read everything at once.
        </p>

        <LinkedInIntakeForm />
      </div>
    </main>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';

import { ResumeIntakeForm } from '@/components/ResumeIntakeForm';

import '../intake.css';

export const metadata: Metadata = {
  title: 'Add your resume · HireWire',
};

export default function ResumeIntakePage() {
  return (
    <main>
      <nav>
        <strong>Application Workspace</strong>
        <Link href="/applicant">Overview</Link>
        <Link href="/applicant/profile">Profile</Link>
      </nav>

      <div className="intake-shell">
        <ol className="intake-steps">
          <li aria-current="step">1. Resume</li>
          <li>2. LinkedIn</li>
          <li>3. Reading</li>
        </ol>

        <p className="eyebrow">STEP ONE</p>
        <h1>Start with your resume.</h1>
        <p className="muted">
          This just stores the file — I read it in one pass at the end, together with everything else
          you give me, so a detail missing from one source can come from another. The original is
          kept so I can re-read it if I get better at this. Whatever I still cannot find becomes a
          question I ask you later, so skipping is a real option rather than a dead end.
        </p>

        <ResumeIntakeForm />
      </div>
    </main>
  );
}

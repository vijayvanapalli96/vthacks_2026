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
          <li>3. Profile</li>
        </ol>

        <p className="eyebrow">STEP ONE</p>
        <h1>Start with your resume.</h1>
        <p className="muted">
          I read it once, pull out your experience, skills and coursework, and keep the original so I
          can re-read it if I get better at this. Whatever I cannot find becomes a question I ask you
          later — so skipping is a real option, not a dead end.
        </p>

        <ResumeIntakeForm />
      </div>
    </main>
  );
}

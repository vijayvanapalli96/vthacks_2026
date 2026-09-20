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
        <Link href="/applicant/profile">Profile</Link>
      </nav>

      <div className="intake-shell">
        <p className="eyebrow">STEP ONE</p>
        <h1>Start with your resume.</h1>

        <ResumeIntakeForm />
      </div>
    </main>
  );
}

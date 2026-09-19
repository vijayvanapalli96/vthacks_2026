import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

import { SignOutForm } from '@/components/SignOutForm';
import { TrustApply } from '@/components/TrustApply';
import { requireRole } from '@/lib/session';

import './apply.css';

export const metadata = { title: 'Verify and apply · HireWire' };

export default async function ApplyPage() {
  const user = await requireRole('applicant');

  return (
    <main>
      <nav>
        <strong>Application Workspace</strong>
        <Link href="/applicant">
          <ArrowLeft size={16} aria-hidden="true" /> Overview
        </Link>
        <SignOutForm />
      </nav>
      <section className="hero trust-hero">
        <p className="eyebrow">VERIFIED APPLY</p>
        <h1>Prove who is asking before anything leaves.</h1>
        <p>
          Your agent looks the employer up in GoDaddy&apos;s Agent Name Service, checks its certificates and published
          card, and scores five trust dimensions. Only then do you choose what to send. If it cannot prove who it is,
          your agent refuses and says why.
        </p>
      </section>
      <TrustApply name={user.name ?? ''} email={user.email ?? ''} />
      <footer>
        <ShieldCheck aria-hidden="true" />
        <strong>A refusal always releases zero fields.</strong>
        <span>The server re-verifies on every send, so the browser cannot talk it into releasing data.</span>
      </footer>
    </main>
  );
}

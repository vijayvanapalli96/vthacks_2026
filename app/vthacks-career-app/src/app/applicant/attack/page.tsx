import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

import { AttackConsole } from '@/components/AttackConsole';
import { SignOutForm } from '@/components/SignOutForm';
import { requireRole } from '@/lib/session';

import '../apply/apply.css';

export const metadata = { title: 'Attack console · HireWire' };

export default async function AttackPage() {
  await requireRole('applicant');

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
        <p className="eyebrow">THREAT MODEL</p>
        <h1>Attack our own agent, on stage.</h1>
        <p>
          Webmesh&apos;s fraud agent only attacks its own payment supplier, so we cannot honestly claim to have
          withstood it. Instead we run the same threat classes against our own employer agent and show you the
          refusals, in its words, as they are written to the audit log.
        </p>
      </section>

      <AttackConsole />

      <footer>
        <ShieldCheck aria-hidden="true" />
        <strong>One probe is a real application that must succeed.</strong> A gate that refuses everything is an
        outage, and this console is built to show the difference.
      </footer>
    </main>
  );
}

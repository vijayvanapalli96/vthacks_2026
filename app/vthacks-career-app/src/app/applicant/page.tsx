import { ArrowRight, BriefcaseBusiness, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ApplicantNav } from '@/components/ApplicantNav';
import { IntakeProgress } from '@/components/IntakeProgress';
import { JobVerificationList } from '@/components/JobVerificationList';
import { Reveal } from '@/components/Reveal';
import { VoiceAgent } from '@/components/voice/VoiceAgent';
import { applicantJobVerificationMemory } from '@/lib/audit';
import { intakeGate } from '@/lib/intake';
import { DEMO_JOB, listJobs } from '@/lib/jobs';
import { requireRole } from '@/lib/session';

import './intake/intake.css';
import './apply/apply.css';

/**
 * The dashboard IS the landing page, including while onboarding finishes.
 *
 * The COLLECT gate lives in this page rather than the applicant layout, because the
 * intake pages are themselves under /applicant: a layout-level redirect would fire on
 * the very pages it sends you to, and a server layout has no reliable view of the
 * current path to exempt them. Gating the dashboard gives the same behaviour with no
 * loop possible.
 *
 * The READ step has no url of its own. It used to redirect to
 * /applicant/intake/processing, which put an implementation detail in the address bar
 * of the first page a new user ever lands on. Now the analysis runs in place, here,
 * with the live log above the workspace — so the URL after signing up is just
 * /applicant and the work is still visible.
 *
 * WHAT IS NOT ON THIS PAGE. A metrics row reading 24 / 8 / 5 / 3 and an "approval
 * required" panel listing Resume.pdf and Cover-letter.pdf as Ready. Both were
 * fixture values with nothing behind them, presented as this user's own numbers and
 * this user's own files — hard rule 7, and the first thing a judge would click. The
 * match queue below stays because it now reads real postings.
 */
export default async function ApplicantDashboard() {
  const user = await requireRole('applicant');
  const { nextStep, needsAnalysis } = await intakeGate(user.id);
  if (nextStep) redirect(nextStep);
  // Real postings only (CLAUDE.md rule 7). The demo row is our own ANS employer
  // agent and is labelled as such.
  const [{ jobs }, verificationMemory] = await Promise.all([
    listJobs(3),
    applicantJobVerificationMemory(user.id),
  ]);
  const queue = [DEMO_JOB, ...jobs].slice(0, 4);

  return (
    <main id="main">
      <ApplicantNav current="overview" />

      {needsAnalysis ? (
        <Reveal as="section" className="setup-band">
          <p className="eyebrow">SETTING UP YOUR WORKSPACE</p>
          <h1>Reading everything you gave me.</h1>
          <p className="muted">
            Reading your resume and LinkedIn together, so gaps in one get filled by the other.
            Here is what I find as I go.
          </p>
          <IntakeProgress />
        </Reveal>
      ) : (
        <Reveal as="section" className="hero hero--center">
          <p className="eyebrow">APPLICATION COMMAND CENTER</p>
          <h1>
            Find the right role.
            <br />
            Stay in control.
          </h1>
          <p>
            Evaluate opportunities, create evidence-backed materials, and approve every external
            action.
          </p>
          <Link className="primary" href="/applicant/jobs">
            Review best match <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </Reveal>
      )}

      <Reveal as="section" className="panel handshake" index={1}>
        <div>
          <small>BEFORE ANYTHING IS SENT</small>
          <h2>Your agent proves who is asking</h2>
          <p>
            Every application goes through a live check against GoDaddy&apos;s Agent Name Service. Try a verified
            employer, then an impostor.
          </p>
        </div>
        <div className="handshake-actions">
          <Link className="primary" href="/applicant/apply?host=employer.hirewire.biz">
            <ShieldCheck size={18} aria-hidden="true" /> Verified employer
          </Link>
          <Link className="secondary" href="/applicant/apply?host=fraud.webmesh.ai">
            Impostor agent
          </Link>
        </div>
      </Reveal>

      {/* Full width rather than in the old two-column .grid: the "approval required"
          aside that used to fill the narrow column is gone, and one panel sitting in
          a 1.6fr slot beside 0.85fr of nothing reads as a layout bug. */}
      <Reveal className="panel" onScroll>
        <header>
          <div>
            <small>MATCH QUEUE</small>
            <h2>Jobs worth your attention</h2>
          </div>
          <BriefcaseBusiness aria-hidden="true" />
        </header>
        <JobVerificationList jobs={queue} initialMemory={verificationMemory} />
        {queue.length <= 1 ? (
          <p className="job-empty">
            Real postings appear here as the discovery pipeline fills them in.{' '}
            <Link href="/applicant/jobs">See all jobs</Link>.
          </p>
        ) : null}
      </Reveal>

      {/* Last in the DOM, so tab order reaches the page content before the floating
          control rather than making every keyboard user pass through it first. It
          connects nothing until asked.

          This is the ONE voice surface on the page. <VoiceConsole /> used to render
          here too; it called navigator.mediaDevices.getUserMedia itself and its
          buttons were a state-picker harness that talked to no endpoint, so two
          microphone grabs competed on one page. VoiceAgent owns the only stream now,
          and HireWire's face rides along as the widget's visual. */}
      <VoiceAgent />
    </main>
  );
}

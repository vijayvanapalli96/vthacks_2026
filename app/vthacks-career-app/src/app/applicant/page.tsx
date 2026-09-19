import { ArrowRight } from 'lucide-react';
import { redirect } from 'next/navigation';

import { IntakeProgress } from '@/components/IntakeProgress';
import { Reveal } from '@/components/Reveal';
import { SignOutForm } from '@/components/SignOutForm';
import { VoiceAgent } from '@/components/voice/VoiceAgent';
import { intakeGate } from '@/lib/intake';
import { requireRole } from '@/lib/session';

import './intake/intake.css';

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
 */
export default async function ApplicantDashboard() {
  const user = await requireRole('applicant');
  const { nextStep, needsAnalysis } = await intakeGate(user.id);
  if (nextStep) redirect(nextStep);

  return (
    <main id="main">
      <nav>
        <strong>Application Workspace</strong>
        <span>Overview</span>
        <span>Jobs</span>
        <span>Materials</span>
        {/* The "Voice navigation" button that used to sit here did nothing when
            clicked. The floating control is the real one, and it is always on
            screen — a button that looks like it starts a microphone and does not is
            worse than no button, particularly for someone who cannot see whether
            anything happened. */}
        <SignOutForm />
      </nav>

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
          <button className="primary">
            Review best match <ArrowRight size={18} aria-hidden="true" />
          </button>
        </Reveal>
      )}

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

import { ArrowRight, BriefcaseBusiness, FileCheck2, ShieldCheck } from 'lucide-react';
import { redirect } from 'next/navigation';

import { IntakeProgress } from '@/components/IntakeProgress';
import { Reveal } from '@/components/Reveal';
import { SignOutForm } from '@/components/SignOutForm';
import { VoiceAgent } from '@/components/voice/VoiceAgent';
import { VoiceConsole } from '@/components/VoiceConsole';
import { intakeGate } from '@/lib/intake';
import { requireRole } from '@/lib/session';

import './intake/intake.css';

const jobs = [
  ['Data & AI Engineer', 'Northstar Labs', '92%'],
  ['Product Data Analyst', 'Brightworks', '86%'],
  ['Machine Learning Engineer', 'Canopy Systems', '78%'],
];

const metrics = [
  ['Discovered', '24'],
  ['Reviewing', '8'],
  ['Approved', '5'],
  ['Responses', '3'],
];

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
            One pass over every source at once, so a detail missing from one can be filled in by
            another. This is the actual work, as it happens — including the parts that do not go
            perfectly.
          </p>
          <IntakeProgress />
        </Reveal>
      ) : (
        <>
          <Reveal as="section" className="hero">
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

          <Reveal index={1}>
            <VoiceConsole />
          </Reveal>
        </>
      )}

      <section className="metrics">
        {metrics.map(([label, value], i) => (
          <Reveal as="article" key={label} index={i + 2}>
            <span>{label}</span>
            <strong>{value}</strong>
          </Reveal>
        ))}
      </section>

      <section className="grid">
        <Reveal className="panel" onScroll>
          <header>
            <div>
              <small>MATCH QUEUE</small>
              <h2>Jobs worth your attention</h2>
            </div>
            <BriefcaseBusiness aria-hidden="true" />
          </header>
          {jobs.map(([role, company, match]) => (
            <article className="job" key={role}>
              <div>
                <h3>{role}</h3>
                <p>{company}</p>
              </div>
              <span className="verified">
                <ShieldCheck size={15} aria-hidden="true" /> Verified
              </span>
              <strong>{match}</strong>
              <ArrowRight size={17} aria-hidden="true" />
            </article>
          ))}
        </Reveal>

        <Reveal as="aside" className="panel approval" onScroll>
          <small>APPROVAL REQUIRED</small>
          <h2>Your materials are ready</h2>
          <p>Resume and cover letter are prepared for your strongest match.</p>
          <div>
            <FileCheck2 aria-hidden="true" /> Resume.pdf <span>Ready</span>
          </div>
          <div>
            <FileCheck2 aria-hidden="true" /> Cover-letter.pdf <span>Ready</span>
          </div>
          <button className="primary">
            Review materials <ArrowRight size={18} aria-hidden="true" />
          </button>
        </Reveal>
      </section>

      <Reveal as="footer" onScroll>
        <ShieldCheck aria-hidden="true" />
        <strong>Human approval is always required.</strong>
        <span>The system recommends; you control every external action.</span>
      </Reveal>

      {/* Last in the DOM, so tab order reaches the page content before the floating
          control rather than making every keyboard user pass through it first. It
          connects nothing until asked.

          WHOEVER RESOLVES THE MERGE CONFLICT ON THIS FILE, READ THIS.
          PR #14 (already on main, not in this branch) renders <VoiceConsole /> on this
          same page. VoiceConsole calls navigator.mediaDevices.getUserMedia itself, and
          its buttons are a state-picker harness, not an agent — it talks to no
          endpoint. Two getUserMedia grabs on one page is a real bug: the streams
          compete and the second request can simply fail. Keep ONE. This component is
          the functional one (ElevenLabs session, client tool, /api/voice/answer), so
          <VoiceConsole /> should stop being rendered here.
          Their <VoiceOrb /> is worth keeping and is genuinely reusable — wire it into
          VoiceWidget's `visual` prop, which exists for exactly that. */}
      <VoiceAgent />
    </main>
  );
}

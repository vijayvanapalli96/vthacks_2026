import Link from 'next/link';
import { ArrowRight, BriefcaseBusiness, FileCheck2, ShieldCheck } from 'lucide-react';
import { redirect } from 'next/navigation';

import { ApplicantNav } from '@/components/ApplicantNav';
import { IntakeProgress } from '@/components/IntakeProgress';
import { Reveal } from '@/components/Reveal';
import { VoiceAgent } from '@/components/voice/VoiceAgent';
import { VoiceConsole } from '@/components/VoiceConsole';
import { intakeGate } from '@/lib/intake';
import { DEMO_JOB, listJobs } from '@/lib/jobs';
import { requireRole } from '@/lib/session';

import './intake/intake.css';
import './apply/apply.css';

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
  // Real postings only (CLAUDE.md rule 7). The demo row is our own ANS employer
  // agent and is labelled as such.
  const { jobs } = await listJobs(3);
  const queue = [DEMO_JOB, ...jobs].slice(0, 4);

  return (
    <main id="main">
      <ApplicantNav current="overview" />

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
            <Link className="primary" href="/applicant/jobs">
              Review best match <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </Reveal>

          <Reveal index={1}>
            <VoiceConsole />
          </Reveal>
        </>
      )}

      <Reveal as="section" className="panel handshake" index={2}>
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

      <section className="metrics">
        {metrics.map(([label, value], i) => (
          <Reveal as="article" key={label} index={i + 3}>
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
          <ul className="job-list">
            {queue.map((job) => (
              <li key={job.job_id}>
                <Link href={`/applicant/jobs/${encodeURIComponent(job.job_id)}`} className="job-row">
                  <span>
                    <strong>{job.job_title}</strong>
                    <small>
                      {job.company_name}
                      {job.location_text ? ` · ${job.location_text}` : ''}
                    </small>
                  </span>
                  <span className={job.demo ? 'job-tag' : 'job-tag muted-tag'}>
                    {job.demo ? 'Demo ANS agent' : (job.source ?? 'posting')}
                  </span>
                  <ArrowRight size={17} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
          {queue.length <= 1 ? (
            <p className="job-empty">
              Real postings appear here as the discovery pipeline fills them in.{' '}
              <Link href="/applicant/jobs">See all jobs</Link>.
            </p>
          ) : null}
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

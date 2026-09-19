import { ArrowRight, BriefcaseBusiness, FileCheck2, Mic, ShieldCheck } from 'lucide-react';
import { redirect } from 'next/navigation';

import { IntakeProgress } from '@/components/IntakeProgress';
import { SignOutForm } from '@/components/SignOutForm';
import { intakeGate } from '@/lib/intake';
import { requireRole } from '@/lib/session';

import './intake/intake.css';

const jobs = [
  ['Data & AI Engineer', 'Northstar Labs', '92%'],
  ['Product Data Analyst', 'Brightworks', '86%'],
  ['Machine Learning Engineer', 'Canopy Systems', '78%'],
];

/**
 * The dashboard IS the landing page, including while onboarding finishes.
 *
 * Two things are decided here.
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
    <main>
      <nav>
        <strong>Application Workspace</strong>
        <span>Overview</span>
        <span>Jobs</span>
        <span>Materials</span>
        <button>
          <Mic size={17} aria-hidden="true" /> Voice navigation
        </button>
        <SignOutForm />
      </nav>

      {needsAnalysis ? (
        <section className="setup-band" aria-labelledby="setup-h">
          <p className="eyebrow">SETTING UP YOUR WORKSPACE</p>
          <h1 id="setup-h">Reading everything you gave me.</h1>
          <p className="muted">
            One pass over every source at once, so a detail missing from one can be filled in by
            another. This is the actual work, as it happens — including the parts that do not go
            perfectly.
          </p>
          <IntakeProgress />
        </section>
      ) : (
        <section className="hero">
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
        </section>
      )}
      <section className="metrics">
        {[
          ['Discovered', '24'],
          ['Reviewing', '8'],
          ['Approved', '5'],
          ['Responses', '3'],
        ].map(([label, value]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </section>
      <section className="grid">
        <div className="panel">
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
        </div>
        <aside className="panel approval">
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
        </aside>
      </section>
      <footer>
        <ShieldCheck aria-hidden="true" />
        <strong>Human approval is always required.</strong>
        <span>The system recommends; you control every external action.</span>
      </footer>
    </main>
  );
}

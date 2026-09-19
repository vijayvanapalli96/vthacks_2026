import { ArrowRight, BriefcaseBusiness, FileCheck2, Mic, ShieldCheck } from 'lucide-react';
import { redirect } from 'next/navigation';

import { SignOutForm } from '@/components/SignOutForm';
import { nextIntakeStep } from '@/lib/intake';
import { requireRole } from '@/lib/session';

const jobs = [
  ['Data & AI Engineer', 'Northstar Labs', '92%'],
  ['Product Data Analyst', 'Brightworks', '86%'],
  ['Machine Learning Engineer', 'Canopy Systems', '78%'],
];

/**
 * The intake gate lives HERE, in the dashboard page, not in the applicant layout.
 *
 * The intake pages are themselves under /applicant, so a layout-level redirect
 * would fire on the very pages it sends you to — an infinite loop. A server layout
 * also has no reliable view of the current path, so it cannot exempt them. Gating
 * the dashboard instead gives the same behaviour (typing /applicant with unfinished
 * intake routes you to the next step) with no loop possible.
 */
export default async function ApplicantDashboard() {
  const user = await requireRole('applicant');
  const step = await nextIntakeStep(user.id);
  if (step) redirect(step);

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

import { ArrowRight, BriefcaseBusiness, FileCheck2, Mic, ShieldCheck } from 'lucide-react';

import { Reveal } from '@/components/Reveal';
import { SignOutForm } from '@/components/SignOutForm';

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

export default function ApplicantDashboard() {
  return (
    <main id="main">
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

      <section className="metrics">
        {metrics.map(([label, value], i) => (
          <Reveal as="article" key={label} index={i + 1}>
            <span>{label}</span>
            <strong>{value}</strong>
          </Reveal>
        ))}
      </section>

      <section className="grid">
        <Reveal className="panel" index={5}>
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

        <Reveal as="aside" className="panel approval" index={6}>
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

      <Reveal as="footer" index={7}>
        <ShieldCheck aria-hidden="true" />
        <strong>Human approval is always required.</strong>
        <span>The system recommends; you control every external action.</span>
      </Reveal>
    </main>
  );
}

import { ArrowRight, BadgeCheck, BriefcaseBusiness, ShieldCheck, Users } from 'lucide-react';

import { SignOutForm } from '@/components/SignOutForm';

const openRoles = [
  ['Data & AI Engineer', 'Blacksburg / Hybrid', '18'],
  ['Platform Engineer, Identity', 'Remote (US)', '11'],
  ['Applied Research Intern', 'Arlington, VA', '34'],
];

const verifiedApplicants = [
  ['Priya Raghunathan', 'Data & AI Engineer', 'Verified'],
  ['Marcus Ellery', 'Platform Engineer, Identity', 'Verified'],
  ['Dani Okafor', 'Applied Research Intern', 'Pending'],
];

export default function EmployerDashboard() {
  return (
    <main>
      <nav>
        <strong>Hiring Workspace</strong>
        <span>Roles</span>
        <span>Applicants</span>
        <span>Agent</span>
        <SignOutForm />
      </nav>

      <section className="hero">
        <p className="eyebrow">HIRING COMMAND CENTER</p>
        <h1>
          Real applicants.
          <br />
          Provable identity.
        </h1>
        <p>
          Publish a role once and let your agent answer for it. Every inbound application carries a
          domain-anchored identity, so you review people instead of filtering bots.
        </p>
      </section>

      <section className="metrics">
        {[
          ['Open roles', '3'],
          ['Applications', '63'],
          ['Verified', '58'],
          ['Refused', '5'],
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
              <small>OPEN ROLES</small>
              <h2>Roles your agent is answering for</h2>
            </div>
            <BriefcaseBusiness aria-hidden="true" />
          </header>
          {openRoles.map(([role, location, applicants]) => (
            <article className="job" key={role}>
              <div>
                <h3>{role}</h3>
                <p>{location}</p>
              </div>
              <span className="verified">
                <Users size={15} aria-hidden="true" /> {applicants} applicants
              </span>
              <strong>Live</strong>
              <ArrowRight size={17} aria-hidden="true" />
            </article>
          ))}
        </div>

        <aside className="panel approval">
          <small>AGENT IDENTITY</small>
          <h2>Your agent is registered</h2>
          <p>
            Applicant agents resolve this name, check the certificate against the domain, and only
            then send anything. Verification runs both ways.
          </p>
          <div>
            <BadgeCheck aria-hidden="true" /> <code>ans://v1.0.0.employer.&lt;domain&gt;</code>
          </div>
          <div>
            <ShieldCheck aria-hidden="true" /> Inbound applicants verified <span>On</span>
          </div>
        </aside>
      </section>

      <section className="panel">
        <header>
          <div>
            <small>VERIFIED APPLICANTS</small>
            <h2>Who has applied</h2>
          </div>
          <Users aria-hidden="true" />
        </header>
        {verifiedApplicants.map(([name, role, status]) => (
          <article className="job" key={name}>
            <div>
              <h3>{name}</h3>
              <p>{role}</p>
            </div>
            <span className="verified">
              <ShieldCheck size={15} aria-hidden="true" /> {status}
            </span>
            <strong>Review</strong>
            <ArrowRight size={17} aria-hidden="true" />
          </article>
        ))}
      </section>

      <footer>
        <ShieldCheck aria-hidden="true" />
        <strong>No unverified agent reaches your inbox.</strong>
        <span>Every handshake is logged, including the ones we refused.</span>
      </footer>
    </main>
  );
}

import { ArrowRight, BriefcaseBusiness, FileCheck2, Mic, ShieldCheck } from 'lucide-react';

const jobs = [
  ['Data & AI Engineer', 'Northstar Labs', '92%'],
  ['Product Data Analyst', 'Brightworks', '86%'],
  ['Machine Learning Engineer', 'Canopy Systems', '78%'],
];

export default function Home() {
  return (
    <main>
      <nav><strong>Application Workspace</strong><span>Overview</span><span>Jobs</span><span>Materials</span><button><Mic size={17} /> Voice navigation</button></nav>
      <section className="hero">
        <p className="eyebrow">APPLICATION COMMAND CENTER</p>
        <h1>Find the right role.<br />Stay in control.</h1>
        <p>Evaluate opportunities, create evidence-backed materials, and approve every external action.</p>
        <button className="primary">Review best match <ArrowRight size={18} /></button>
      </section>
      <section className="metrics">
        {[['Discovered','24'],['Reviewing','8'],['Approved','5'],['Responses','3']].map(([label,value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}
      </section>
      <section className="grid">
        <div className="panel">
          <header><div><small>MATCH QUEUE</small><h2>Jobs worth your attention</h2></div><BriefcaseBusiness /></header>
          {jobs.map(([role,company,match]) => <article className="job" key={role}><div><h3>{role}</h3><p>{company}</p></div><span className="verified"><ShieldCheck size={15} /> Verified</span><strong>{match}</strong><ArrowRight size={17} /></article>)}
        </div>
        <aside className="panel approval">
          <small>APPROVAL REQUIRED</small><h2>Your materials are ready</h2><p>Resume and cover letter are prepared for your strongest match.</p>
          <div><FileCheck2 /> Resume.pdf <span>Ready</span></div><div><FileCheck2 /> Cover-letter.pdf <span>Ready</span></div>
          <button className="primary">Review materials <ArrowRight size={18} /></button>
        </aside>
      </section>
      <footer><ShieldCheck /><strong>Human approval is always required.</strong><span>The system recommends; you control every external action.</span></footer>
    </main>
  );
}

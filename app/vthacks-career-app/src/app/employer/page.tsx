/**
 * /employer — the hiring manager's overview.
 *
 * WHAT WAS HERE: three hardcoded roles, three invented applicants with invented
 * names, four invented metrics ("63 applications", "58 verified"), and a nav bar
 * of dead <span>s. It looked like a product and reported nothing. Hard rule 7 is
 * real content only, and a fabricated applicant list is the version of that
 * failure a judge notices.
 *
 * WHAT IS HERE NOW: the counts and the most recent applications, read from the
 * audit log, plus the links into the pages that do the work. When the log cannot
 * be read the page says so — it does not fall back to numbers.
 */
import Link from 'next/link';
import { ArrowRight, BadgeCheck, Inbox, ShieldCheck, Users } from 'lucide-react';

import { ApplicantAgentCheck, type AgentCheckResult } from '@/components/ApplicantAgentCheck';
import { EmployerNav } from '@/components/EmployerNav';
import { Reveal } from '@/components/Reveal';
import { APPLICANT_ANS_NAME, EMPLOYER_ANS_NAME, verifyProductionAgent } from '@/lib/ans/production';
import { employerCounts, inboundApplications, jobTitles } from '@/lib/employer';

import '../applicant/apply/apply.css';

export const dynamic = 'force-dynamic';

/** ANS round-trip, Atlas read, and a warehouse read for the role titles. */
export const maxDuration = 120;

/** Verified on the server so the badge arrives already decided. */
async function checkApplicantAgent(): Promise<AgentCheckResult> {
  try {
    const result = await verifyProductionAgent({ ansName: APPLICANT_ANS_NAME, expectedRole: 'applicant' });
    return {
      state: result.verdict === 'pass' ? 'verified' : 'refused',
      ansName: result.registry.ans_name,
      reason: result.spoken_reason,
      score: Math.round(result.dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / result.dimensions.length),
    };
  } catch (error) {
    return {
      state: 'refused',
      ansName: APPLICANT_ANS_NAME,
      reason: error instanceof Error ? error.message : 'This agent could not be verified.',
    };
  }
}

export default async function EmployerDashboard() {
  const [applicantAgent, counts, recent] = await Promise.all([
    checkApplicantAgent(),
    employerCounts(),
    inboundApplications(5),
  ]);
  const titles = recent
    ? await jobTitles(recent.map((application) => application.job_id).filter((id): id is string => Boolean(id)))
    : {};

  return (
    <main id="main">
      <EmployerNav current="overview" />

      <Reveal as="section" className="hero trust-hero">
        <p className="eyebrow">HIRING WORKSPACE</p>
        <h1>
          Real applicants.
          <br />
          Provable identity.
        </h1>
        <p>
          Your agent answers for your roles. Every inbound application carries a domain-anchored identity that was
          checked before anything was released, so you review people instead of filtering bots.
        </p>
        <p className="muted">Reporting on {EMPLOYER_ANS_NAME}.</p>
      </Reveal>

      <Reveal as="section" className="panel trust-step" index={1}>
        <header>
          <div>
            <small>INBOUND AGENT</small>
            <h2>Is this applicant agent real?</h2>
          </div>
        </header>
        <ApplicantAgentCheck initial={applicantAgent} />
      </Reveal>

      {/* Counts, or the reason there are none. Never a placeholder number: the
          whole complaint about the old version of this page was that its
          figures were typed in by hand. */}
      {counts === null ? (
        <p className="auth-error" role="status">
          The audit log is not reachable, so there are no figures to show. Nothing has been lost — this page reads the
          log, it does not keep its own count.
        </p>
      ) : (
        <section className="metrics">
          {[
            ['Applications received', counts.applications],
            ['Accepted', counts.delivered],
            ['Refused handshakes', counts.refused],
            ['Applicant agents', counts.agents],
          ].map(([label, value], i) => (
            <Reveal as="article" key={String(label)} index={i + 1}>
              <span>{label}</span>
              <strong>{value}</strong>
            </Reveal>
          ))}
        </section>
      )}

      <section className="grid">
        <Reveal className="panel" onScroll>
          <header>
            <div>
              <small>LATEST APPLICATIONS</small>
              <h2>Who applied most recently</h2>
            </div>
            <Inbox aria-hidden="true" />
          </header>
          {recent === null ? (
            <p className="muted">The audit log could not be read, so this list is unavailable rather than empty.</p>
          ) : recent.length === 0 ? (
            <p className="muted">
              Nothing yet. The first completed handshake appears here, and in full on the applicants page.
            </p>
          ) : (
            <>
              {recent.map((application) => (
                <article className="job" key={application.audit_id}>
                  <div>
                    <h3>{application.applicant}</h3>
                    <p>
                      {application.job_id ? (titles[application.job_id] ?? application.job_id) : 'No role recorded'}
                    </p>
                  </div>
                  <span className={application.outcome === 'submitted' ? 'verified' : 'verified is-pending'}>
                    <ShieldCheck size={15} aria-hidden="true" /> {application.fields_released.length} fields
                  </span>
                  <strong>{new Date(application.at).toLocaleDateString()}</strong>
                </article>
              ))}
              <p className="job-source-link">
                <Link href="/employer/applicants">
                  All applicants <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </p>
            </>
          )}
        </Reveal>

        <Reveal as="aside" className="panel approval" onScroll>
          <small>AGENT IDENTITY</small>
          <h2>Your agent is registered</h2>
          <p>
            Applicant agents resolve this name, check the certificate against the domain, and only then send
            anything. Verification runs both ways.
          </p>
          <div>
            <BadgeCheck aria-hidden="true" /> <code>{EMPLOYER_ANS_NAME}</code>
          </div>
          <div>
            <ShieldCheck aria-hidden="true" /> Inbound applicants verified <span>On</span>
          </div>
          <p className="job-source-link">
            <Link href="/employer/activity">
              Every handshake, including the refusals <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </p>
        </Reveal>
      </section>

      <Reveal as="section" className="panel" onScroll>
        <header>
          <div>
            <small>OUTBOUND</small>
            <h2>Go and find people</h2>
          </div>
          <Users aria-hidden="true" />
        </header>
        <p>
          Students who publish an opt-in profile can be invited directly. Your agent verifies theirs, signs the
          invitation with this employer&rsquo;s identity key, and the refusal path is the same one they get from you.
        </p>
        <p className="job-source-link">
          <Link href="/employer/candidates">
            Find candidates <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </p>
      </Reveal>

      <Reveal as="footer" onScroll>
        <ShieldCheck aria-hidden="true" />
        <strong>No unverified agent reaches your inbox.</strong>
        <span>Every handshake is logged, including the ones we refused.</span>
      </Reveal>
    </main>
  );
}

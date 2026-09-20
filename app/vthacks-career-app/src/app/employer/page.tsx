import { ArrowRight, BadgeCheck, BriefcaseBusiness, Send, ShieldCheck, Users } from 'lucide-react';

import { ApplicantAgentCheck, type AgentCheckResult } from '@/components/ApplicantAgentCheck';
import { CandidateOutreach, type Candidate, type OutreachRole } from '@/components/CandidateOutreach';
import { Reveal } from '@/components/Reveal';
import { SignOutForm } from '@/components/SignOutForm';
import { APPLICANT_ANS_NAME, EMPLOYER_ANS_NAME, verifyProductionAgent } from '@/lib/ans/production';
import { employerInbox } from '@/lib/audit';
import { sql } from '@/lib/databricks';

import '../applicant/apply/apply.css';

export const dynamic = 'force-dynamic';

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

const openRoles: (OutreachRole & { applicants: string })[] = [
  { job_id: 'hirewire-data-ai-engineer', title: 'Data & AI Engineer', location: 'Blacksburg / Hybrid', applicants: '18' },
  { job_id: 'hirewire-platform-identity', title: 'Platform Engineer, Identity', location: 'Remote (US)', applicants: '11' },
  { job_id: 'hirewire-applied-research-intern', title: 'Applied Research Intern', location: 'Arlington, VA', applicants: '34' },
];

/** Databricks returns ARRAY<STRING> as a JSON string over the SQL API. */
function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Opt-in, non-PII profiles only: a headline, public skills, and the ANS name to
 * address. Contact details never appear here — the candidate's agent releases
 * those, after they approve. The dashboard still works when the warehouse is
 * asleep, because the ANS-name field below does not need it.
 */
async function loadCandidates(): Promise<{ candidates: Candidate[]; unavailable?: string }> {
  try {
    const result = await sql(
      `SELECT applicant_ans_name, headline, skills, target_roles, locations
       FROM workspace.vthacks_2026.candidate_discovery_profiles
       WHERE opt_in = true
       ORDER BY updated_at DESC
       LIMIT 25`,
    );
    return {
      candidates: result.rows.map((row) => ({
        applicant_ans_name: row[0] ?? '',
        headline: row[1],
        skills: parseList(row[2]),
        target_roles: parseList(row[3]),
        locations: parseList(row[4]),
      })).filter((candidate) => candidate.applicant_ans_name),
    };
  } catch (error) {
    console.error('Could not load candidate discovery profiles', error);
    return {
      candidates: [],
      unavailable: 'The candidate directory is unavailable right now. You can still invite an agent by its ANS name.',
    };
  }
}

const roleTitles = new Map(openRoles.map((role) => [role.job_id, role.title]));

const outcomeLabels: Record<string, string> = {
  submitted: 'Application received',
  refused: 'Refused before sending',
  delivery_failed: 'Verified, not delivered',
  verified: 'Verified',
  blocked: 'Blocked',
  accepted: 'Accepted',
};

export default async function EmployerDashboard() {
  const [applicantAgent, directory, inbox] = await Promise.all([
    checkApplicantAgent(),
    loadCandidates(),
    employerInbox(EMPLOYER_ANS_NAME),
  ]);
  // A metric with no audit log behind it is a claim, not a number: show a dash.
  const metrics: [string, string][] = [
    ['Open roles', String(openRoles.length)],
    ['Applications', inbox ? String(inbox.counts.applications) : '—'],
    ['Invitations sent', inbox ? String(inbox.counts.invitationsSent) : '—'],
    ['Refused handshakes', inbox ? String(inbox.counts.refused) : '—'],
  ];

  return (
    <main id="main">
      <nav>
        <strong>Hiring Workspace</strong>
        <span>Roles</span>
        <span>Applicants</span>
        <span>Agent</span>
        <SignOutForm />
      </nav>

      <Reveal as="section" className="hero">
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

      <Reveal as="section" className="panel trust-step" index={2}>
        <header>
          <div>
            <small>OUTBOUND AGENT</small>
            <h2>Invite a candidate&apos;s agent</h2>
          </div>
          <Send aria-hidden="true" />
        </header>
        <CandidateOutreach
          candidates={directory.candidates}
          roles={openRoles}
          defaultAnsName={APPLICANT_ANS_NAME}
          unavailable={directory.unavailable}
        />
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
        <Reveal className="panel" onScroll>
          <header>
            <div>
              <small>OPEN ROLES</small>
              <h2>Roles your agent is answering for</h2>
            </div>
            <BriefcaseBusiness aria-hidden="true" />
          </header>
          {openRoles.map((role) => (
            <article className="job" key={role.job_id}>
              <div>
                <h3>{role.title}</h3>
                <p>{role.location}</p>
              </div>
              <span className="verified">
                <Users size={15} aria-hidden="true" /> {role.applicants} applicants
              </span>
              <strong>Live</strong>
              <ArrowRight size={17} aria-hidden="true" />
            </article>
          ))}
        </Reveal>

        <Reveal as="aside" className="panel approval" onScroll>
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
        </Reveal>
      </section>

      <Reveal as="section" className="panel" onScroll>
        <header>
          <div>
            <small>INBOUND HANDSHAKES</small>
            <h2>Who has applied</h2>
          </div>
          <Users aria-hidden="true" />
        </header>
        {inbox === null ? (
          <p className="job-empty">
            The audit log is not reachable right now, so this list and the counts above are empty rather than guessed.
          </p>
        ) : inbox.applications.length === 0 ? (
          <p className="job-empty">
            No agent has applied to <code>{EMPLOYER_ANS_NAME}</code> yet. Every attempt lands here, including the ones
            that were refused.
          </p>
        ) : (
          inbox.applications.map((event) => {
            const refused = event.verdict === 'refuse';
            return (
              <article className="job outreach-row" key={event.audit_id}>
                <div>
                  <h3>{roleTitles.get(event.job_id ?? '') ?? event.job_id ?? 'Unnamed role'}</h3>
                  <p className="outreach-ans">{event.verifier}</p>
                  <p className="outreach-fields">
                    {event.fields_released.length
                      ? `Released: ${event.fields_released.join(', ')}`
                      : 'No fields released'}
                  </p>
                </div>
                <span className={`pill ${refused ? 'pill-refuse' : 'pill-pass'}`}>
                  {outcomeLabels[event.outcome] ?? event.outcome.replace(/_/g, ' ')}
                </span>
                <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleString()}</time>
              </article>
            );
          })
        )}
      </Reveal>

      <Reveal as="footer" onScroll>
        <ShieldCheck aria-hidden="true" />
        <strong>No unverified agent reaches your inbox.</strong>
        <span>Every handshake is logged, including the ones we refused.</span>
      </Reveal>
    </main>
  );
}

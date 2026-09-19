/**
 * /applicant/profile — resume intake and the profile the agent has built.
 *
 * Two halves:
 *  - the intake card (client, handles upload/skip and renders what it just read)
 *  - everything the agent already remembers, read from append-only profile memory
 *
 * The second half is the point of the whole feature: the profile is a memory that
 * grows, so it survives a reload and shows where each fact came from and when we
 * learned it. A form would not do that.
 *
 * NOTE: the applicant nav here is local to this page. Once feat/auth-template
 * merges, the shared nav and the requireRole('applicant') guard come from
 * src/app/applicant/layout.tsx and this duplicate header goes away.
 */
import { Brain, Mic } from 'lucide-react';
import { ResumeIntake } from '@/components/ResumeIntake';
import { getCurrentUserId } from '@/lib/current-user';
import { currentFacts, readFacts, type ProfileFact } from '@/lib/profile-memory';
import './profile.css';

export const dynamic = 'force-dynamic';

export default async function ApplicantProfilePage() {
  const userId = getCurrentUserId();
  const { facts, backend } = await readFacts(userId);
  const known = currentFacts(facts);

  return (
    <main>
      <nav>
        <strong>Application Workspace</strong>
        <span>Overview</span>
        <span>Profile</span>
        <span>Jobs</span>
        <button type="button">
          <Mic size={17} aria-hidden="true" /> Voice navigation
        </button>
      </nav>

      <section className="hero rp-hero">
        <p className="eyebrow">YOUR PROFILE</p>
        <h1>What the agent knows about you.</h1>
        <p>
          Everything here came from something you gave it, and it will tell you which. Correct
          anything that is wrong — the agent applies on your behalf, so it only claims what you can
          back up.
        </p>
      </section>

      <ResumeIntake />

      <section className="panel rp-memory" aria-labelledby="memory-heading">
        <header>
          <div>
            <small>PROFILE MEMORY · {known.length} FACTS</small>
            <h2 id="memory-heading">Everything learned so far</h2>
          </div>
          <Brain aria-hidden="true" />
        </header>

        {known.length === 0 ? (
          <div className="rp-empty">
            <p className="rp-empty-title">Nothing remembered yet.</p>
            <p>
              Upload a resume above and the agent fills this in, fact by fact, with a source and a
              confidence against each one. Skip instead and it asks you by voice — either way this
              panel is how you check its work.
            </p>
            <p className="rp-meta">
              Facts are append-only: a correction is recorded as something newly learned, never as an
              overwrite. Nothing you tell it gets silently lost.
            </p>
          </div>
        ) : (
          <>
            <table className="rp-table">
              <caption className="rp-caption">
                Latest value for each field, with where it came from and when it was learned.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Value</th>
                  <th scope="col">Source</th>
                  <th scope="col">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {known.map((fact) => (
                  <tr key={fact.factId}>
                    <th scope="row">{fact.key}</th>
                    <td>{fact.value}</td>
                    <td>
                      <span className="rp-source">{describeSource(fact)}</span>
                    </td>
                    <td>{Math.round(fact.confidence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="rp-provenance">
              Stored in {backend === 'databricks' ? 'Databricks (workspace.vthacks_2026.profile_memory)' : 'the local dev store'} ·{' '}
              {facts.length} total facts across all revisions
            </p>
          </>
        )}
      </section>
    </main>
  );
}

/** "resume:gemini:gemini-2.5-flash" -> "resume, read by gemini-2.5-flash" */
function describeSource(fact: ProfileFact): string {
  const [origin, , model] = fact.source.split(':');
  const when = fact.observedAt.slice(0, 10);
  return model ? `${origin} · ${model} · ${when}` : `${fact.source} · ${when}`;
}

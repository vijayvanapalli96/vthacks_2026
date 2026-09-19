'use client';

/**
 * ResumeIntake — upload a resume (or skip), then render what the agent extracted.
 *
 * Visual metaphor, held consistently: the agent hands you cards. Each panel is
 * something it learned, and every panel carries its provenance — which model read
 * it and how confident it is. Evidence, not claims.
 *
 * The skip control is deliberately as prominent as the upload. Skipping is a
 * designed path: it hands the voice agent a full agenda of questions.
 */
import { useActionState } from 'react';
import { FileUp, ShieldCheck, SkipForward, TriangleAlert } from 'lucide-react';
import { uploadResumeAction, type ResumeFormState } from '@/app/actions/resume';
import type { IntakeSuccess } from '@/lib/resume-intake';

export function ResumeIntake() {
  const [state, submit, pending] = useActionState<ResumeFormState, FormData>(uploadResumeAction, null);

  const failed = state && !state.ok ? state.error : null;
  const result = state && state.ok ? state : null;

  return (
    <>
      <section className="panel rp-upload" aria-labelledby="upload-heading">
        <header>
          <div>
            <small>STEP ONE</small>
            <h2 id="upload-heading">Start with your resume</h2>
          </div>
          <FileUp aria-hidden="true" />
        </header>

        <div className="rp-upload-body">
          <p className="rp-lede">
            Upload a PDF and the agent reads it into a profile you can correct. Prefer to talk it
            through instead? Skip — it will ask you directly.
          </p>

          <form action={submit} aria-busy={pending}>
            <div className="rp-field">
              <label htmlFor="resume">Resume PDF</label>
              <input
                id="resume"
                name="resume"
                type="file"
                accept="application/pdf"
                required
                aria-describedby={failed ? 'resume-error' : 'resume-hint'}
                aria-invalid={failed ? true : undefined}
              />
              <p className="rp-hint" id="resume-hint">
                PDF, up to 10 MB. A text-based export reads far better than a scan.
              </p>
            </div>

            <div className="rp-actions">
              <button type="submit" className="primary" disabled={pending}>
                {pending ? 'Reading your resume…' : 'Read my resume'}
              </button>
              {/* formNoValidate so skipping is not blocked by the required file input. */}
              <button
                type="submit"
                name="intent"
                value="skip"
                formNoValidate
                className="rp-skip"
                disabled={pending}
              >
                <SkipForward size={16} aria-hidden="true" /> Skip for now
              </button>
            </div>
          </form>

          <p className="rp-status" role="status" aria-live="polite">
            {pending
              ? 'Extracting your profile. This can take up to 30 seconds if the warehouse is waking up.'
              : result
                ? result.provider
                  ? `Done. Read by ${result.providerLabel} and saved ${result.factsAppended} facts.`
                  : 'Skipped. The agent will ask you for these details instead.'
                : ''}
          </p>

          {failed ? (
            <p className="rp-error" id="resume-error" role="alert">
              <TriangleAlert size={16} aria-hidden="true" /> {failed}
            </p>
          ) : null}
        </div>
      </section>

      {result ? <ExtractedPanels result={result} /> : null}
    </>
  );
}

function ExtractedPanels({ result }: { result: IntakeSuccess }) {
  const { profile } = result;
  const provenance = result.provider
    ? `${result.providerLabel} · ${result.model}`
    : 'Not yet read — nothing extracted';

  const hasAnything =
    profile.name ||
    profile.email ||
    profile.education.length > 0 ||
    profile.experience.length > 0 ||
    profile.skills.length > 0;

  return (
    <>
      {result.warnings.length > 0 ? (
        <section className="panel rp-warnings" aria-labelledby="warnings-heading">
          <header>
            <div>
              <small>WORTH KNOWING</small>
              <h2 id="warnings-heading">Notes from the extraction</h2>
            </div>
            <TriangleAlert aria-hidden="true" />
          </header>
          <ul className="rp-list">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {hasAnything ? (
        <div className="rp-grid">
          <Panel title="Contact" eyebrow="WHO YOU ARE" provenance={provenance}>
            <dl className="rp-pairs">
              <Pair label="Name" value={profile.name} />
              <Pair label="Email" value={profile.email} />
              <Pair label="Phone" value={profile.phone} />
              <Pair label="Location" value={profile.location} />
            </dl>
            {profile.links.length > 0 ? (
              <ul className="rp-list">
                {profile.links.map((link, i) => (
                  <li key={`${link.url ?? link.label ?? i}`}>{link.url ?? link.label}</li>
                ))}
              </ul>
            ) : null}
          </Panel>

          {profile.education.length > 0 ? (
            <Panel title="Education" eyebrow="COURSEWORK ANCHOR" provenance={provenance}>
              {profile.education.map((entry, i) => (
                <article className="rp-entry" key={`${entry.school ?? 'school'}-${i}`}>
                  <h3>{entry.school ?? 'Unnamed institution'}</h3>
                  <p>{[entry.degree, entry.field].filter(Boolean).join(', ') || 'Programme not stated'}</p>
                  <p className="rp-meta">
                    {[joinDates(entry.startDate, entry.endDate), entry.gpa ? `GPA ${entry.gpa}` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </article>
              ))}
            </Panel>
          ) : null}

          {profile.experience.length > 0 ? (
            <Panel title="Experience" eyebrow="WHAT YOU HAVE DONE" provenance={provenance}>
              {profile.experience.map((entry, i) => (
                <article className="rp-entry" key={`${entry.company ?? 'role'}-${i}`}>
                  <h3>{entry.title ?? 'Role'}</h3>
                  <p>{[entry.company, entry.location].filter(Boolean).join(' · ') || 'Employer not stated'}</p>
                  <p className="rp-meta">{joinDates(entry.startDate, entry.endDate)}</p>
                  {entry.bullets.length > 0 ? (
                    <ul className="rp-list">
                      {entry.bullets.map((bullet, b) => (
                        <li key={b}>{bullet}</li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              ))}
            </Panel>
          ) : null}

          {profile.skills.length > 0 ? (
            <Panel title="Skills" eyebrow="WHAT WE MATCH ON" provenance={provenance}>
              <ul className="rp-tags">
                {profile.skills.map((skill) => (
                  <li key={skill}>{skill}</li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {profile.courses.length > 0 ? (
            <Panel title="Coursework" eyebrow="UNLOCKS ROLES" provenance={provenance}>
              <ul className="rp-tags">
                {profile.courses.map((course, i) => (
                  <li key={`${course.code ?? course.title ?? i}`}>
                    {[course.code, course.title].filter(Boolean).join(' ')}
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {profile.projects.length > 0 ? (
            <Panel title="Projects" eyebrow="EVIDENCE" provenance={provenance}>
              {profile.projects.map((project, i) => (
                <article className="rp-entry" key={`${project.name ?? 'project'}-${i}`}>
                  <h3>{project.name ?? 'Project'}</h3>
                  {project.description ? <p>{project.description}</p> : null}
                  {project.tech.length > 0 ? <p className="rp-meta">{project.tech.join(' · ')}</p> : null}
                </article>
              ))}
            </Panel>
          ) : null}
        </div>
      ) : null}

      {result.gaps.length > 0 ? (
        <section className="panel rp-gaps" aria-labelledby="gaps-heading">
          <header>
            <div>
              <small>NEXT, BY VOICE</small>
              <h2 id="gaps-heading">What I still need to ask you</h2>
            </div>
            <ShieldCheck aria-hidden="true" />
          </header>
          <ol className="rp-questions">
            {result.gaps.map((gap) => (
              <li key={gap.key}>{gap.question}</li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}

function Panel({
  title,
  eyebrow,
  provenance,
  children,
}: {
  title: string;
  eyebrow: string;
  provenance: string;
  children: React.ReactNode;
}) {
  const id = `panel-${title.toLowerCase()}`;
  return (
    <section className="panel rp-panel" aria-labelledby={id}>
      <header>
        <div>
          <small>{eyebrow}</small>
          <h2 id={id}>{title}</h2>
        </div>
      </header>
      <div className="rp-panel-body">{children}</div>
      <p className="rp-provenance">Read by {provenance}</p>
    </section>
  );
}

function Pair({ label, value }: { label: string; value?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value ?? <span className="rp-absent">Not on your resume</span>}</dd>
    </>
  );
}

function joinDates(start?: string, end?: string): string {
  if (!start && !end) return 'Dates not stated';
  return `${start ?? '?'} – ${end ?? 'present'}`;
}

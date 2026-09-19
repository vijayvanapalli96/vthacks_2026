import type { Metadata } from 'next';
import Link from 'next/link';

import { describeSource, loadProfile, type SourceRow } from '@/lib/profile-repo';
import { requireRole } from '@/lib/session';

import './profile.css';

export const metadata: Metadata = {
  title: 'Your profile · HireWire',
};

// Every load reads Databricks, and the warehouse may be cold. Never cache a page
// whose whole job is to reflect what we just learned about you.
export const dynamic = 'force-dynamic';

function Provenance({ sources, documentId }: { sources: SourceRow[]; documentId?: string }) {
  return <p className="provenance">From {describeSource(sources, documentId)}</p>;
}

/** The sources onboarding asks for, so the page can show the ones still missing. */
const INTAKE_SOURCES = [
  { kind: 'resume_pdf', label: 'Resume', href: '/applicant/intake/resume' },
  { kind: 'linkedin_url', label: 'LinkedIn', href: '/applicant/intake/linkedin' },
] as const;

export default async function ProfilePage() {
  const user = await requireRole('applicant');
  const profile = await loadProfile(user.id);

  const { header, experience, education, skills, projects, certifications, courses, gaps, sources } =
    profile;

  const nothingYet =
    !header && experience.length === 0 && education.length === 0 && skills.length === 0;

  return (
    <main>
      <nav>
        <strong>Application Workspace</strong>
        <Link href="/applicant">Overview</Link>
        <Link href="/applicant/intake/resume">Add resume</Link>
        <Link href="/applicant/intake/linkedin">Add LinkedIn</Link>
      </nav>

      <div className="profile-shell">
        <header className="profile-head">
          <p className="eyebrow">YOUR PROFILE</p>
          <h1>{header?.fullName ?? user.email ?? 'Your profile'}</h1>
          {header?.headline && <p className="muted">{header.headline}</p>}
          <ul className="profile-contact">
            {header?.email && <li>{header.email}</li>}
            {header?.phone && <li>{header.phone}</li>}
            {header?.location && <li>{header.location}</li>}
            {header?.linkedinUrl && (
              <li>
                <a href={header.linkedinUrl}>LinkedIn</a>
              </li>
            )}
            {header?.githubUrl && (
              <li>
                <a href={header.githubUrl}>GitHub</a>
              </li>
            )}
            {header?.portfolioUrl && (
              <li>
                <a href={header.portfolioUrl}>Portfolio</a>
              </li>
            )}
          </ul>
          <p className="provenance">
            {profile.factCount} {profile.factCount === 1 ? 'fact' : 'facts'} remembered across{' '}
            {sources.length} {sources.length === 1 ? 'source' : 'sources'}
          </p>
        </header>

        {nothingYet ? (
          <div className="profile-empty">
            <h2>Nothing here yet</h2>
            <p>
              Add a resume and I will fill this in — experience, skills, coursework — and keep a note
              of where each line came from. If you skipped it, you can still add it here; otherwise I
              will ask you out loud instead.
            </p>
            <p className="outcome-next">
              <Link href="/applicant/intake/resume">Add your resume</Link>
              <span aria-hidden="true"> · </span>
              <Link href="/applicant/intake/linkedin">Add your LinkedIn</Link>
            </p>
          </div>
        ) : (
          <div className="profile-grid">
            <div className="profile-shell" style={{ padding: 0, gap: 20 }}>
              {header?.summary && (
                <section className="profile-section" aria-labelledby="summary-h">
                  <h2 id="summary-h">Summary</h2>
                  <p className="gap-question">{header.summary}</p>
                </section>
              )}

              {experience.length > 0 && (
                <section className="profile-section" aria-labelledby="experience-h">
                  <h2 id="experience-h">Experience</h2>
                  {experience.map((entry, i) => (
                    <article className="entry" key={`${entry.company ?? 'role'}-${i}`}>
                      <h3>
                        {entry.title ?? 'Role'}
                        {entry.company ? ` · ${entry.company}` : ''}
                      </h3>
                      <p className="meta">
                        {[entry.location, [entry.startDate, entry.endDate].filter(Boolean).join(' – ')]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      {entry.bullets.length > 0 && (
                        <ul>
                          {entry.bullets.map((bullet) => (
                            <li key={bullet}>{bullet}</li>
                          ))}
                        </ul>
                      )}
                      <Provenance sources={sources} documentId={entry.sourceDocumentId} />
                    </article>
                  ))}
                </section>
              )}

              {education.length > 0 && (
                <section className="profile-section" aria-labelledby="education-h">
                  <h2 id="education-h">Education</h2>
                  {education.map((entry, i) => (
                    <article className="entry" key={`${entry.school ?? 'school'}-${i}`}>
                      <h3>{entry.school ?? 'School'}</h3>
                      <p className="meta">
                        {[
                          [entry.degree, entry.field].filter(Boolean).join(', '),
                          [entry.startDate, entry.endDate].filter(Boolean).join(' – '),
                          entry.gpa ? `GPA ${entry.gpa}` : undefined,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      <Provenance sources={sources} documentId={entry.sourceDocumentId} />
                    </article>
                  ))}
                </section>
              )}

              {projects.length > 0 && (
                <section className="profile-section" aria-labelledby="projects-h">
                  <h2 id="projects-h">Projects</h2>
                  {projects.map((entry, i) => (
                    <article className="entry" key={`${entry.name ?? 'project'}-${i}`}>
                      <h3>{entry.name ?? 'Project'}</h3>
                      {entry.description && <p className="meta">{entry.description}</p>}
                      {entry.tech.length > 0 && (
                        <ul className="chips">
                          {entry.tech.map((tech) => (
                            <li key={tech}>{tech}</li>
                          ))}
                        </ul>
                      )}
                      <Provenance sources={sources} documentId={entry.sourceDocumentId} />
                    </article>
                  ))}
                </section>
              )}
            </div>

            <div className="profile-shell" style={{ padding: 0, gap: 20 }}>
              <section className="profile-section" aria-labelledby="gaps-h">
                <h2 id="gaps-h">What I still need to ask you</h2>
                {gaps.length === 0 ? (
                  <p className="meta">Nothing outstanding — I have everything I need to start matching.</p>
                ) : (
                  <>
                    <ol className="gap-list">
                      {gaps.map((gap) => (
                        <li key={gap.field}>
                          <p className="gap-field">{gap.field.replace(/_/g, ' ')}</p>
                          <p className="gap-question">{gap.question ?? 'Tell me more about this.'}</p>
                        </li>
                      ))}
                    </ol>
                    <p className="provenance">
                      The voice agent works down this list in order, basics first.
                    </p>
                  </>
                )}
              </section>

              {skills.length > 0 && (
                <section className="profile-section" aria-labelledby="skills-h">
                  <h2 id="skills-h">Skills</h2>
                  <ul className="chips">
                    {skills.map((entry) => (
                      <li key={entry.skill}>{entry.skill}</li>
                    ))}
                  </ul>
                  <Provenance sources={sources} documentId={skills[0]?.sourceDocumentId} />
                </section>
              )}

              {courses.length > 0 && (
                <section className="profile-section" aria-labelledby="courses-h">
                  <h2 id="courses-h">Coursework</h2>
                  <ul className="chips">
                    {courses.map((course) => (
                      <li key={course.code}>{course.title ? `${course.code} ${course.title}` : course.code}</li>
                    ))}
                  </ul>
                  <p className="provenance">Coursework unlocks roles a resume alone does not show.</p>
                </section>
              )}

              {certifications.length > 0 && (
                <section className="profile-section" aria-labelledby="certs-h">
                  <h2 id="certs-h">Certifications</h2>
                  <ul className="chips">
                    {certifications.map((entry, i) => (
                      <li key={`${entry.name ?? 'cert'}-${i}`}>{entry.name}</li>
                    ))}
                  </ul>
                  <Provenance sources={sources} documentId={certifications[0]?.sourceDocumentId} />
                </section>
              )}

              {/* Missing and skipped sources are shown, not hidden. We only ask once
                  during onboarding, so this list is the ONLY way back for someone who
                  skipped a step — hiding it would make the skip irreversible. */}
              <section className="profile-section" aria-labelledby="sources-h">
                <h2 id="sources-h">Where this came from</h2>
                <ul className="sources">
                  {INTAKE_SOURCES.map(({ kind, label, href }) => {
                    const row = sources.find((candidate) => candidate.kind === kind);
                    const usable = row && row.status !== 'skipped' && row.status !== 'failed';
                    // 'received' means we hold it but have not read it — the analysis
                    // step was interrupted or never finished. That is a different
                    // problem from "never given", and it has a different fix, so it
                    // gets its own label and sends you to the reading step.
                    const pending = row?.status === 'received';
                    const suffix = pending
                      ? ' — waiting to be read'
                      : usable
                        ? ''
                        : row?.status === 'skipped'
                          ? ' — skipped'
                          : row?.status === 'failed'
                            ? ' — could not be read'
                            : ' — not added yet';
                    return (
                      <li key={kind}>
                        <strong>
                          {label}
                          {suffix}
                        </strong>
                        {usable ? (
                          <>
                            <span className="provenance">
                              {row?.fileName ?? row?.externalUrl ?? row?.status}
                              {row?.model ? ` · ${row.model}` : ''}
                            </span>
                            {row?.storagePath && <code>{row.storagePath}</code>}
                            {pending && <Link href="/applicant">Read it now</Link>}
                          </>
                        ) : (
                          <Link href={href}>
                            {row?.status === 'failed' ? 'Try another file' : 'Add it now'}
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

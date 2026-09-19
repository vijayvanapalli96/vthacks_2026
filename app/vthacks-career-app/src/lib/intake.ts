/**
 * intake.ts — the path from "user handed us something" to "the profile knows it".
 *
 * TWO PHASES, ON PURPOSE.
 *
 *   stage    stageDocument / stageLinkedInUrl / skipIntake
 *            Make it durable and record a 'received' row. No model call. Fast, so
 *            the upload pages are just "choose, next, choose, next".
 *
 *   analyse  analyzeIntake
 *            Read everything staged, COMBINE it, write the structured profile,
 *            append to memory, recompute the gaps. This is where the 30-to-60
 *            seconds goes, and it streams a progress log while it runs.
 *
 * Doing it in one blocking step was worse twice over: the user waited on a dead
 * submit button, and each source was read in isolation, so the resume pass could
 * not see anything the LinkedIn step provided and vice versa. Reading them together
 * means a field missing from one source can be supplied by another BEFORE we decide
 * what is still an open question.
 *
 * IDEMPOTENCY IS A FEATURE, NOT A NICETY. profile_memory is append-only, so a
 * second upload of the same file would permanently double every fact and the profile
 * page would show each skill twice. A demo operator re-uploading during rehearsal is
 * the likeliest way to trigger it. Two things prevent it: the (user_id,
 * content_hash) check when staging, and marking each document 'parsed' the moment
 * its facts land, so an interrupted analysis resumes instead of re-appending.
 *
 * Nothing here throws at its caller. A failed parse is a 'failed' row and a warning
 * in the log, not a 500 — one unreadable resume must not cost the whole profile.
 */
import { randomUUID } from 'node:crypto';

import { sql, type SqlParam } from '@/lib/databricks';
import { detectGaps, emptyProfile, type ExtractedProfile } from '@/lib/extract/types';
import {
  extractLinkedInExport,
  extractProfile,
  providerLabel,
  type LinkedInExportOutcome,
} from '@/lib/extract';
import {
  canEnrich,
  describeFindings,
  enrichFromPublicWeb,
  isEmptyProfile,
  WEB_CONFIDENCE_SCALE,
} from '@/lib/enrich/linkedin-web';
import { appendFacts, singleFact, toFacts } from '@/lib/profile-memory';
import { getUpload, putUpload } from '@/lib/uploads';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const DOCS = 'workspace.vthacks_2026.intake_documents';

export type IntakeKind = 'resume_pdf' | 'linkedin_url' | 'linkedin_export_pdf' | 'transcript_pdf';

/**
 * The `source` prefix each kind writes into profile_memory.
 *
 * This is the string a user sees next to a fact when they ask where it came from, so
 * it names the ACTUAL origin. 'linkedin_export' is distinct from 'linkedin' on
 * purpose: one is an archive LinkedIn generated for its owner, the other is a URL
 * somebody typed, and the difference is the entire subject of docs/DATA_MODEL.md §4.
 */
const SOURCE_KINDS: Record<IntakeKind, string> = {
  resume_pdf: 'resume',
  transcript_pdf: 'transcript',
  linkedin_export_pdf: 'linkedin_export',
  linkedin_url: 'linkedin',
};

/* -------------------------------------------------------------- onboarding */

/**
 * Where an applicant should be sent next, or null when onboarding is finished.
 *
 * There is deliberately NO "onboarding_complete" flag. intake_documents already
 * records one row per (user_id, kind) INCLUDING skips — status='skipped' is a real
 * row — so the presence of a row IS the answer. A separate flag would be a second
 * source of truth that can disagree with the documents themselves.
 *
 * This is what makes "ask at most once" true: a skip writes a row, so the step
 * never comes back.
 */
export type IntakeGate = {
  /** Where to send them to COLLECT something, or null when collecting is done. */
  nextStep: string | null;
  /** True when something has been collected but not yet read. */
  needsAnalysis: boolean;
};

/**
 * Collecting and reading are separate questions, so they are separate answers.
 *
 * The reading step deliberately has NO url of its own. It used to live at
 * /applicant/intake/processing, which put an implementation detail in the address
 * bar of the page the user lands on after signing up. The dashboard IS the landing
 * page; when analysis is outstanding it renders the progress log in place, and
 * `needsAnalysis` is what tells it to.
 */
export async function intakeGate(userId: string): Promise<IntakeGate> {
  const result = await sql(
    `SELECT
       max(CASE WHEN kind = 'resume_pdf'   THEN 1 ELSE 0 END) AS has_resume,
       max(CASE WHEN kind = 'linkedin_url' THEN 1 ELSE 0 END) AS has_linkedin,
       max(CASE WHEN status = 'received'   THEN 1 ELSE 0 END) AS has_pending,
       (SELECT count(*) FROM workspace.vthacks_2026.profile_gaps WHERE user_id = :user) AS gaps
     FROM ${DOCS} WHERE user_id = :user`,
    [{ name: 'user', value: userId }],
  );
  const row = result.rows[0] ?? [];
  const truthy = (value: unknown) => String(value ?? '0') === '1';

  if (!truthy(row[0])) return { nextStep: '/applicant/intake/resume', needsAnalysis: false };
  if (!truthy(row[1])) return { nextStep: '/applicant/intake/linkedin', needsAnalysis: false };

  // Something is staged and unread. Analysis is separate from collecting precisely
  // so the two upload pages stay fast: the model call is the slow part, and it should
  // happen once, over everything at once, with the user watching progress rather than
  // a frozen submit button.
  //
  // Gap rows are the OUTPUT of analysis, so none existing also means analysis has
  // never run — that is the both-steps-skipped case, where there is nothing to read
  // but the voice agent still needs its question queue built.
  const needsAnalysis = truthy(row[2]) || Number(row[3] ?? 0) === 0;
  return { nextStep: null, needsAnalysis };
}

/** Sources that have been collected but not yet read. */
export type PendingDocument = {
  documentId: string;
  kind: IntakeKind;
  storagePath: string | null;
  externalUrl: string | null;
  fileName: string | null;
};

export async function pendingIntake(userId: string): Promise<PendingDocument[]> {
  const result = await sql(
    `SELECT document_id, kind, storage_path, external_url, file_name
       FROM ${DOCS}
      WHERE user_id = :user AND status = 'received'
      ORDER BY uploaded_at`,
    [{ name: 'user', value: userId }],
  );
  return result.rows.map((row) => ({
    documentId: String(row[0]),
    kind: String(row[1]) as IntakeKind,
    storagePath: row[2] == null ? null : String(row[2]),
    externalUrl: row[3] == null ? null : String(row[3]),
    fileName: row[4] == null ? null : String(row[4]),
  }));
}

/** How many of this user's sources have been read. Distinguishes "skipped" from "done". */
async function parsedCount(userId: string): Promise<number> {
  const result = await sql(
    `SELECT count(*) FROM ${DOCS} WHERE user_id = :user AND status = 'parsed'`,
    [{ name: 'user', value: userId }],
  );
  return Number(result.rows[0]?.[0] ?? 0);
}

/**
 * What the profile ALREADY holds, rebuilt into an ExtractedProfile.
 *
 * WHY A SECOND RUN NEEDS THIS. Analysis only reads documents still marked 'received',
 * which is what keeps it idempotent — but it means a second pass sees an EMPTY
 * profile in memory, because the documents that filled it are 'parsed' and are
 * deliberately not re-read. Two things then go wrong, and both were measured:
 *
 *   - recomputeGaps decides from that empty profile, so it re-opens the nine
 *     questions the LinkedIn export had already answered (6 open gaps became 15).
 *   - web enrichment has no name, employer or school to seed with, so the one run
 *     that most needs disambiguation is the one that gets none.
 *
 * Reading it back from the structured tables fixes both, and it is the right source:
 * profiles/* is written by this module as a page-shaped copy of the same truth, with
 * COALESCE already applied, so the values here are the ones that previously won.
 *
 * Only called when something has actually been parsed, and issued as ONE parallel
 * burst — the warehouse is billed by the second while awake.
 */
async function knownProfile(userId: string): Promise<ExtractedProfile> {
  const user = [{ name: 'user', value: userId }];
  const [header, experience, education, skills, projects, courses, certifications] =
    await Promise.all([
      sql(
        `SELECT full_name, email, phone, location, summary, linkedin_url, github_url, portfolio_url
           FROM workspace.vthacks_2026.profiles WHERE user_id = :user LIMIT 1`,
        user,
      ),
      sql(
        `SELECT company, title, location, start_date, end_date
           FROM workspace.vthacks_2026.profile_experience WHERE user_id = :user ORDER BY ordinal`,
        user,
      ),
      sql(
        `SELECT school, degree, field, start_date, end_date, gpa
           FROM workspace.vthacks_2026.profile_education WHERE user_id = :user`,
        user,
      ),
      sql(`SELECT skill FROM workspace.vthacks_2026.profile_skills WHERE user_id = :user`, user),
      sql(
        `SELECT name, description FROM workspace.vthacks_2026.profile_projects WHERE user_id = :user`,
        user,
      ),
      sql(
        `SELECT course_code, title FROM workspace.vthacks_2026.courses WHERE user_id = :user`,
        user,
      ),
      sql(
        `SELECT name FROM workspace.vthacks_2026.profile_certifications WHERE user_id = :user`,
        user,
      ),
    ]);

  const text = (value: string | null | undefined) => (value == null || value === '' ? undefined : value);
  const row = header.rows[0] ?? [];
  const links = [row[5], row[6], row[7]]
    .filter((url): url is string => Boolean(url))
    .map((url) => ({ label: undefined, url }));

  return {
    name: text(row[0]),
    email: text(row[1]),
    phone: text(row[2]),
    location: text(row[3]),
    summary: text(row[4]),
    links,
    experience: experience.rows.map((r) => ({
      company: text(r[0]),
      title: text(r[1]),
      location: text(r[2]),
      startDate: text(r[3]),
      endDate: text(r[4]),
      // Bullets are intentionally left empty: they are not used for gap detection or
      // for de-duplication (which keys on company|title), and pulling an ARRAY<STRING>
      // back through the Statement Execution API to ignore it is a waste of the wire.
      bullets: [],
    })),
    education: education.rows.map((r) => ({
      school: text(r[0]),
      degree: text(r[1]),
      field: text(r[2]),
      startDate: text(r[3]),
      endDate: text(r[4]),
      gpa: text(r[5]),
    })),
    skills: skills.rows.map((r) => String(r[0] ?? '')).filter(Boolean),
    projects: projects.rows.map((r) => ({
      name: text(r[0]),
      description: text(r[1]),
      tech: [],
    })),
    courses: courses.rows.map((r) => ({ code: text(r[0]), title: text(r[1]) })),
    certifications: certifications.rows.map((r) => String(r[0] ?? '')).filter(Boolean),
  };
}

/* ------------------------------------------------------------------- gaps */

/**
 * Every field the agent can ask about, in ask order.
 *
 * Priority is the ask order, and the split matters: the BASICS can be answered by
 * a document, so extraction closes them. The DECISIONS cannot — no resume states
 * the salary you would accept or whether you need visa sponsorship — so they stay
 * open until someone asks out loud. That is the handoff to the voice agent.
 */
const GAP_FIELDS: ReadonlyArray<{
  field: string;
  priority: number;
  question: string;
  /** Decision gaps are never satisfied by a document. */
  fromDocument: boolean;
}> = [
  { field: 'name', priority: 10, question: 'What name should I use on your applications?', fromDocument: true },
  { field: 'email', priority: 20, question: 'What email should employers reply to?', fromDocument: true },
  { field: 'phone', priority: 30, question: 'Is there a phone number you want on applications?', fromDocument: true },
  { field: 'location', priority: 40, question: 'Where are you based, and are you open to relocating?', fromDocument: true },
  { field: 'education', priority: 50, question: 'Where are you studying, and what is your major?', fromDocument: true },
  { field: 'courses', priority: 60, question: 'Which courses have you taken? Coursework unlocks roles your resume does not show.', fromDocument: true },
  { field: 'skills', priority: 70, question: 'Which tools and languages do you want me to match you on?', fromDocument: true },
  { field: 'experience', priority: 80, question: 'Tell me about your most recent role or internship.', fromDocument: true },
  { field: 'projects', priority: 90, question: 'Any projects you would want an employer to see?', fromDocument: true },
  { field: 'links', priority: 100, question: 'Do you have a GitHub or portfolio link?', fromDocument: true },

  { field: 'target_role', priority: 200, question: 'What kind of role are you looking for?', fromDocument: false },
  { field: 'sponsorship', priority: 210, question: 'Will you need visa sponsorship?', fromDocument: false },
  { field: 'comp_floor', priority: 220, question: 'Is there a salary below which you would rather not be contacted?', fromDocument: false },
  { field: 'start_date', priority: 230, question: 'When could you start?', fromDocument: false },
  { field: 'accommodations', priority: 240, question: 'Any accommodations I should request on your behalf?', fromDocument: false },
];

/**
 * Reconcile gaps against what we now know.
 *
 * One MERGE, not one per field: fifteen round trips to a warehouse that may be
 * cold-starting is the difference between a snappy upload and one that looks hung.
 *
 * An 'answered' gap is NEVER reopened. Someone who told the voice agent their
 * salary floor must not be asked again because a later resume upload happens not
 * to mention it.
 *
 * WHICH IS WHY EVERY FIELD GETS A ROW, answered ones included, even though an
 * answered row is not a question and nothing reads it. Inserting only the OPEN ones
 * left the answered fields with no row at all, so "never reopened" was only true for
 * a field that had been open once: a second analysis pass — the "Try again" button,
 * or an upload added later — recomputes against whatever is pending THAT time, finds
 * nothing, and re-inserts all fifteen as open. Measured: 6 open gaps after one pass
 * over a LinkedIn export, 15 after running it again, with nine of them already
 * answered by the export. The row is the memory that the question was settled.
 */
async function recomputeGaps(userId: string, profile: ExtractedProfile): Promise<number> {
  // An empty profile — every step skipped, or every parse failed — makes every
  // document-derived field missing, which is exactly right: all of them become
  // questions. No separate "open everything" mode is needed.
  const missingFromDoc = new Set(detectGaps(profile).map((gap) => gap.key));

  const rows = GAP_FIELDS.map((gap) => {
    const open = !gap.fromDocument || missingFromDoc.has(gap.field);
    return { ...gap, desired: open ? 'open' : 'answered' };
  });

  const parameters: SqlParam[] = [{ name: 'user', value: userId }];
  const tuples = rows.map((row, i) => {
    parameters.push(
      { name: `f${i}`, value: row.field },
      { name: `d${i}`, value: row.desired },
      { name: `p${i}`, value: String(row.priority), type: 'INT' },
      { name: `q${i}`, value: row.question },
    );
    return `(:f${i}, :d${i}, :p${i}, :q${i})`;
  });

  await sql(
    `MERGE INTO workspace.vthacks_2026.profile_gaps AS t
     USING (SELECT * FROM VALUES ${tuples.join(', ')} AS v(field_key, desired, priority, question)) AS s
        ON t.user_id = :user AND t.field_key = s.field_key
      WHEN MATCHED AND t.status <> 'answered' AND s.desired = 'answered'
        THEN UPDATE SET status = 'answered', answer_source = 'document',
                        answered_at = current_timestamp(), updated_at = current_timestamp()
      WHEN NOT MATCHED
        THEN INSERT (user_id, field_key, status, priority, question,
                     answer_source, answered_at, updated_at)
             VALUES (:user, s.field_key, s.desired, s.priority, s.question,
                     CASE WHEN s.desired = 'answered' THEN 'document' END,
                     CASE WHEN s.desired = 'answered' THEN current_timestamp() END,
                     current_timestamp())`,
    parameters,
  );

  return Number(
    (
      await sql(
        `SELECT count(*) FROM workspace.vthacks_2026.profile_gaps
          WHERE user_id = :user AND status = 'open'`,
        [{ name: 'user', value: userId }],
      )
    ).rows[0]?.[0] ?? 0,
  );
}

/* -------------------------------------------------- structured profile write */

function arrayLiteral(values: string[]): string {
  // Values are model output, so they are escaped rather than trusted. Delta has no
  // array parameter type, so an array() literal is the only way in.
  const escaped = values.map((value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
  return escaped.length ? `array(${escaped.join(', ')})` : 'array()';
}

async function writeStructuredProfile(
  userId: string,
  documentId: string,
  profile: ExtractedProfile,
  extras: { linkedinUrl?: string },
): Promise<void> {
  const github = profile.links.find((link) => /github\.com/i.test(link.url ?? ''))?.url;
  const portfolio = profile.links.find(
    (link) => link.url && !/github\.com|linkedin\.com/i.test(link.url),
  )?.url;
  const linkedin =
    extras.linkedinUrl ?? profile.links.find((link) => /linkedin\.com/i.test(link.url ?? ''))?.url;

  // COALESCE on update: a LinkedIn URL submitted on its own page must not wipe the
  // name and email a resume already established.
  await sql(
    `MERGE INTO workspace.vthacks_2026.profiles AS t
     USING (SELECT :user AS user_id) AS s
        ON t.user_id = s.user_id
      WHEN MATCHED THEN UPDATE SET
        full_name     = coalesce(:full_name, t.full_name),
        email         = coalesce(:email, t.email),
        phone         = coalesce(:phone, t.phone),
        location      = coalesce(:location, t.location),
        summary       = coalesce(:summary, t.summary),
        linkedin_url  = coalesce(:linkedin, t.linkedin_url),
        github_url    = coalesce(:github, t.github_url),
        portfolio_url = coalesce(:portfolio, t.portfolio_url),
        updated_at    = current_timestamp()
      WHEN NOT MATCHED THEN INSERT
        (user_id, full_name, email, phone, location, summary, linkedin_url, github_url, portfolio_url, updated_at)
        VALUES (:user, :full_name, :email, :phone, :location, :summary, :linkedin, :github, :portfolio, current_timestamp())`,
    [
      { name: 'user', value: userId },
      { name: 'full_name', value: profile.name ?? null },
      { name: 'email', value: profile.email ?? null },
      { name: 'phone', value: profile.phone ?? null },
      { name: 'location', value: profile.location ?? null },
      { name: 'summary', value: profile.summary ?? null },
      { name: 'linkedin', value: linkedin ?? null },
      { name: 'github', value: github ?? null },
      { name: 'portfolio', value: portfolio ?? null },
    ],
  );

  // Child rows are owned by the document that produced them: clear this document's
  // previous contribution, then re-insert. Re-extracting a file therefore replaces
  // its rows instead of stacking duplicates, and other documents are untouched.
  for (const table of [
    'profile_experience',
    'profile_education',
    'profile_projects',
    'profile_certifications',
  ]) {
    await sql(
      `DELETE FROM workspace.vthacks_2026.${table}
        WHERE user_id = :user AND source_document_id = :doc`,
      [
        { name: 'user', value: userId },
        { name: 'doc', value: documentId },
      ],
    );
  }

  if (profile.experience.length) {
    const parameters: SqlParam[] = [];
    const tuples = profile.experience.map((entry, i) => {
      parameters.push(
        { name: `id${i}`, value: randomUUID() },
        { name: `user${i}`, value: userId },
        { name: `company${i}`, value: entry.company ?? null },
        { name: `title${i}`, value: entry.title ?? null },
        { name: `loc${i}`, value: entry.location ?? null },
        { name: `start${i}`, value: entry.startDate ?? null },
        { name: `end${i}`, value: entry.endDate ?? null },
        { name: `ord${i}`, value: String(i), type: 'INT' },
        { name: `doc${i}`, value: documentId },
      );
      const current = !entry.endDate || /present|current/i.test(entry.endDate);
      return `(:id${i}, :user${i}, :company${i}, :title${i}, :loc${i}, :start${i}, :end${i}, ${current}, NULL, ${arrayLiteral(entry.bullets)}, :ord${i}, :doc${i}, current_timestamp())`;
    });
    await sql(
      `INSERT INTO workspace.vthacks_2026.profile_experience
         (experience_id, user_id, company, title, location, start_date, end_date, is_current, description, bullets, ordinal, source_document_id, created_at)
       VALUES ${tuples.join(', ')}`,
      parameters,
    );
  }

  if (profile.education.length) {
    const parameters: SqlParam[] = [];
    const tuples = profile.education.map((entry, i) => {
      parameters.push(
        { name: `id${i}`, value: randomUUID() },
        { name: `user${i}`, value: userId },
        { name: `school${i}`, value: entry.school ?? null },
        { name: `degree${i}`, value: entry.degree ?? null },
        { name: `field${i}`, value: entry.field ?? null },
        { name: `start${i}`, value: entry.startDate ?? null },
        { name: `end${i}`, value: entry.endDate ?? null },
        { name: `gpa${i}`, value: entry.gpa ?? null },
        { name: `doc${i}`, value: documentId },
      );
      return `(:id${i}, :user${i}, :school${i}, :degree${i}, :field${i}, :start${i}, :end${i}, :gpa${i}, :doc${i}, current_timestamp())`;
    });
    await sql(
      `INSERT INTO workspace.vthacks_2026.profile_education
         (education_id, user_id, school, degree, field, start_date, end_date, gpa, source_document_id, created_at)
       VALUES ${tuples.join(', ')}`,
      parameters,
    );
  }

  if (profile.projects.length) {
    const parameters: SqlParam[] = [];
    const tuples = profile.projects.map((entry, i) => {
      parameters.push(
        { name: `id${i}`, value: randomUUID() },
        { name: `user${i}`, value: userId },
        { name: `name${i}`, value: entry.name ?? null },
        { name: `desc${i}`, value: entry.description ?? null },
        { name: `doc${i}`, value: documentId },
      );
      return `(:id${i}, :user${i}, :name${i}, :desc${i}, ${arrayLiteral(entry.tech)}, NULL, :doc${i}, current_timestamp())`;
    });
    await sql(
      `INSERT INTO workspace.vthacks_2026.profile_projects
         (project_id, user_id, name, description, tech, url, source_document_id, created_at)
       VALUES ${tuples.join(', ')}`,
      parameters,
    );
  }

  if (profile.certifications.length) {
    const parameters: SqlParam[] = [];
    const tuples = profile.certifications.map((name, i) => {
      parameters.push(
        { name: `id${i}`, value: randomUUID() },
        { name: `user${i}`, value: userId },
        { name: `name${i}`, value: name },
        { name: `doc${i}`, value: documentId },
      );
      return `(:id${i}, :user${i}, :name${i}, NULL, NULL, :doc${i}, current_timestamp())`;
    });
    await sql(
      `INSERT INTO workspace.vthacks_2026.profile_certifications
         (certification_id, user_id, name, issuer, issued_date, source_document_id, created_at)
       VALUES ${tuples.join(', ')}`,
      parameters,
    );
  }

  // Skills and courses MERGE on their natural key instead of delete-then-insert:
  // two documents legitimately mention Python, and Delta would not stop us storing
  // it twice.
  if (profile.skills.length) {
    const parameters: SqlParam[] = [{ name: 'user', value: userId }, { name: 'doc', value: documentId }];
    const tuples = profile.skills.map((skill, i) => {
      parameters.push({ name: `s${i}`, value: skill });
      return `(:s${i})`;
    });
    await sql(
      `MERGE INTO workspace.vthacks_2026.profile_skills AS t
       USING (SELECT * FROM VALUES ${tuples.join(', ')} AS v(skill)) AS s
          ON t.user_id = :user AND lower(t.skill) = lower(s.skill)
        WHEN NOT MATCHED THEN INSERT (user_id, skill, raw_skill, category, source_document_id, created_at)
             VALUES (:user, s.skill, s.skill, NULL, :doc, current_timestamp())`,
      parameters,
    );
  }

  const namedCourses = profile.courses.filter((course) => course.code || course.title);
  if (namedCourses.length) {
    const parameters: SqlParam[] = [{ name: 'user', value: userId }];
    const tuples = namedCourses.map((course, i) => {
      parameters.push(
        { name: `c${i}`, value: course.code ?? course.title ?? '' },
        { name: `t${i}`, value: course.title ?? null },
      );
      return `(:c${i}, :t${i})`;
    });
    await sql(
      `MERGE INTO workspace.vthacks_2026.courses AS t
       USING (SELECT * FROM VALUES ${tuples.join(', ')} AS v(course_code, title)) AS s
          ON t.user_id = :user AND t.course_code = s.course_code
        WHEN NOT MATCHED THEN INSERT (user_id, course_code, title, term, grade, skills)
             VALUES (:user, s.course_code, s.title, NULL, NULL, array())`,
      parameters,
    );
  }
}

/* ------------------------------------------------------------------ documents */

async function findParsedByHash(userId: string, contentHash: string): Promise<string | null> {
  const result = await sql(
    `SELECT document_id FROM ${DOCS}
      WHERE user_id = :user AND content_hash = :hash AND status = 'parsed'
      ORDER BY parsed_at DESC LIMIT 1`,
    [
      { name: 'user', value: userId },
      { name: 'hash', value: contentHash },
    ],
  );
  return result.rows[0]?.[0] ?? null;
}

async function insertDocument(row: {
  documentId: string;
  userId: string;
  kind: IntakeKind;
  status: string;
  storagePath?: string;
  externalUrl?: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  contentHash?: string;
}): Promise<void> {
  await sql(
    `INSERT INTO ${DOCS}
       (document_id, user_id, kind, status, storage_path, external_url, file_name, mime_type, byte_size, content_hash, uploaded_at)
     VALUES (:id, :user, :kind, :status, :path, :url, :file, :mime, :size, :hash, current_timestamp())`,
    [
      { name: 'id', value: row.documentId },
      { name: 'user', value: row.userId },
      { name: 'kind', value: row.kind },
      { name: 'status', value: row.status },
      { name: 'path', value: row.storagePath ?? null },
      { name: 'url', value: row.externalUrl ?? null },
      { name: 'file', value: row.fileName ?? null },
      { name: 'mime', value: row.mimeType ?? null },
      { name: 'size', value: row.byteSize == null ? null : String(row.byteSize), type: 'BIGINT' },
      { name: 'hash', value: row.contentHash ?? null },
    ],
  );
}

async function markDocument(
  documentId: string,
  patch: { status: string; provider?: string; model?: string; warnings?: string[]; error?: string },
): Promise<void> {
  await sql(
    `UPDATE ${DOCS} SET
       status = :status,
       parsed_at = current_timestamp(),
       extract_provider = :provider,
       extract_model = :model,
       warnings = ${arrayLiteral(patch.warnings ?? [])},
       error_message = :error
     WHERE document_id = :id`,
    [
      { name: 'status', value: patch.status },
      { name: 'provider', value: patch.provider ?? null },
      { name: 'model', value: patch.model ?? null },
      { name: 'error', value: patch.error ?? null },
      { name: 'id', value: documentId },
    ],
  );
}

/* --------------------------------------------------------------------- API */

export function validateUpload(file: File | null): string | null {
  if (!file || file.size === 0) return 'Choose a PDF to upload.';
  if (file.size > MAX_UPLOAD_BYTES) return 'That file is larger than 10 MB.';
  const looksPdf =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!looksPdf) return 'That does not look like a PDF.';
  return null;
}

/**
 * The LinkedIn data export is not a PDF, so it needs its own gate.
 *
 * *Settings → Get a copy of your data* hands over a ZIP of CSVs; "Save to PDF" on
 * the profile page hands over a PDF; and people routinely unzip the archive and
 * upload one sheet. All three are legitimate, so all three are accepted. Extension
 * only — the real decision is made from the file's own magic bytes at parse time
 * (looksLikeZip / looksLikePdf), because a browser's `file.type` for a .zip is
 * anything from application/zip to application/x-zip-compressed to empty.
 */
export const EXPORT_EXTENSIONS = ['.zip', '.csv', '.pdf'] as const;

export function validateExportUpload(file: File | null): string | null {
  if (!file || file.size === 0) return 'Choose your LinkedIn export to upload.';
  if (file.size > MAX_UPLOAD_BYTES) return 'That file is larger than 10 MB.';
  const name = file.name.toLowerCase();
  if (!EXPORT_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return 'That needs to be the .zip LinkedIn emailed you, one of its .csv files, or your profile saved as a PDF.';
  }
  return null;
}

/* ------------------------------------------------------------------ staging */

/**
 * Collecting is separated from reading.
 *
 * The two intake pages only STAGE: they make the bytes (or the URL) durable, write
 * a 'received' row, and return. Nothing calls a model. That is what makes "upload,
 * next, upload, next" feel instant — the 30-to-60-second part happens once,
 * afterwards, over everything at once, on a page built to show progress.
 *
 * It is also better analysis. Reading each source the moment it arrives means the
 * resume pass cannot see the LinkedIn URL and vice versa; reading them together
 * lets one source cover what the other omits.
 */
export type StageResult =
  | { ok: true; documentId: string; reused: boolean }
  | { ok: false; error: string };

/** Skipping is a recorded outcome, not the absence of one. */
export async function skipIntake(userId: string, kind: IntakeKind): Promise<StageResult> {
  try {
    const documentId = randomUUID();
    await clearUnread(userId, kind);
    await insertDocument({ documentId, userId, kind, status: 'skipped' });
    return { ok: true, documentId, reused: false };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Drop a previous, never-read row for this slot.
 *
 * Someone who goes back and uploads a different resume should replace what they
 * staged, not queue a second document. Only 'received' rows are removed: nothing
 * downstream can reference them yet, because being referenced is what 'parsed'
 * means. A parsed document is never touched.
 */
async function clearUnread(userId: string, kind: IntakeKind): Promise<void> {
  await sql(
    `DELETE FROM ${DOCS} WHERE user_id = :user AND kind = :kind AND status IN ('received', 'skipped')`,
    [
      { name: 'user', value: userId },
      { name: 'kind', value: kind },
    ],
  );
}

/** Store the bytes and record the source. Does NOT read the document. */
export async function stageDocument(args: {
  userId: string;
  kind: Extract<IntakeKind, 'resume_pdf' | 'linkedin_export_pdf' | 'transcript_pdf'>;
  file: File;
}): Promise<StageResult> {
  const { userId, kind, file } = args;

  // The LinkedIn export is a ZIP or a CSV as often as it is a PDF, so the gate is
  // per-kind. A resume is still PDF-only.
  const invalid =
    kind === 'linkedin_export_pdf' ? validateExportUpload(file) : validateUpload(file);
  if (invalid) return { ok: false, error: invalid };

  const mimeType = file.type || guessMimeType(file.name);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored = await putUpload({
      userId,
      kind,
      bytes,
      fileName: file.name,
      mimeType,
    });

    // Already read these exact bytes. Staging it again would make analysis append
    // every fact a second time, and profile_memory is append-only — there is no
    // undo. Report it as reused and stage nothing.
    const existing = await findParsedByHash(userId, stored.contentHash);
    if (existing) {
      await clearUnread(userId, kind);
      return { ok: true, documentId: existing, reused: true };
    }

    const documentId = randomUUID();
    await clearUnread(userId, kind);
    await insertDocument({
      documentId,
      userId,
      kind,
      status: 'received',
      storagePath: stored.storagePath,
      fileName: file.name,
      mimeType,
      byteSize: stored.byteSize,
      contentHash: stored.contentHash,
    });
    return { ok: true, documentId, reused: false };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Browsers omit file.type for .csv and disagree about .zip; the extension does not. */
function guessMimeType(fileName: string): string {
  const name = fileName.toLowerCase();
  if (name.endsWith('.zip')) return 'application/zip';
  if (name.endsWith('.csv')) return 'text/csv';
  return 'application/pdf';
}

/**
 * Save a LinkedIn profile URL.
 *
 * Still no parse HERE — staging never calls a model. What changed is what happens
 * to it afterwards: analyzeIntake() now treats a URL-only LinkedIn document as a
 * seed for best-effort public-web enrichment (src/lib/enrich/linkedin-web.ts)
 * rather than a dead end. The page is still never fetched. LinkedIn has no public
 * profile API and blocks anonymous requests, so the enrichment looks at what the
 * rest of the public web says about the person the resume already identified, and
 * labels every fact it finds accordingly.
 *
 * The reliable path is the one next to it on the same page: kind
 * 'linkedin_export_pdf', the archive the user owns.
 */
export async function stageLinkedInUrl(userId: string, url: string): Promise<StageResult> {
  try {
    const documentId = randomUUID();
    await clearUnread(userId, 'linkedin_url');
    await insertDocument({
      documentId,
      userId,
      kind: 'linkedin_url',
      status: 'received',
      externalUrl: url,
    });
    return { ok: true, documentId, reused: false };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/* ----------------------------------------------------------------- combining */

function firstOf(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value !== '');
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Fold several extracted profiles into one.
 *
 * Order matters: earlier sources win on the single-value fields, so callers pass
 * the more authoritative document first. Collections are unioned rather than
 * overwritten, which is the whole point of combining — a resume that lists no
 * coursework and a transcript that lists nothing else should produce a profile
 * holding both, not whichever was read last.
 *
 * De-duplication is by a case-insensitive key, so "Python" from one source and
 * "python" from another are one skill.
 */
export function mergeProfiles(profiles: ExtractedProfile[]): ExtractedProfile {
  if (profiles.length === 0) return emptyProfile();
  if (profiles.length === 1) return profiles[0];

  return {
    name: firstOf(profiles.map((p) => p.name)),
    email: firstOf(profiles.map((p) => p.email)),
    phone: firstOf(profiles.map((p) => p.phone)),
    location: firstOf(profiles.map((p) => p.location)),
    summary: firstOf(profiles.map((p) => p.summary)),
    links: dedupeBy(profiles.flatMap((p) => p.links), (link) => link.url ?? link.label ?? ''),
    education: dedupeBy(
      profiles.flatMap((p) => p.education),
      (entry) => `${entry.school ?? ''}|${entry.degree ?? ''}`,
    ),
    experience: dedupeBy(
      profiles.flatMap((p) => p.experience),
      (entry) => `${entry.company ?? ''}|${entry.title ?? ''}`,
    ),
    projects: dedupeBy(profiles.flatMap((p) => p.projects), (entry) => entry.name ?? ''),
    skills: dedupe(profiles.flatMap((p) => p.skills)),
    courses: dedupeBy(
      profiles.flatMap((p) => p.courses),
      (entry) => entry.code ?? entry.title ?? '',
    ),
    certifications: dedupe(profiles.flatMap((p) => p.certifications)),
  };
}

/**
 * Everything in `candidate` that `known` does not already contain.
 *
 * Needed because writeStructuredProfile() is called PER DOCUMENT with that
 * document's own profile, and the child tables are keyed by source_document_id — so
 * two sources that both mention the same internship produce two rows and the profile
 * page shows the job twice. mergeProfiles() de-duplicates for the in-memory view;
 * this de-duplicates for the write.
 *
 * It is also the teeth on "never overwrite a resume-derived value" for web
 * enrichment: a search result that merely repeats what the resume said contributes
 * nothing, so it appends nothing and the fact count stays honest about what was
 * actually learned. Single-value fields are dropped whenever `known` has one at all
 * — the resume wins outright, it is not compared.
 */
export function subtractProfile(
  candidate: ExtractedProfile,
  known: ExtractedProfile,
): ExtractedProfile {
  const seen = (values: string[]) => new Set(values.map((value) => value.trim().toLowerCase()));

  const knownExperience = seen(
    known.experience.map((entry) => `${entry.company ?? ''}|${entry.title ?? ''}`),
  );
  const knownEducation = seen(
    known.education.map((entry) => `${entry.school ?? ''}|${entry.degree ?? ''}`),
  );
  const knownProjects = seen(known.projects.map((entry) => entry.name ?? ''));
  const knownSkills = seen(known.skills);
  const knownCerts = seen(known.certifications);
  const knownLinks = seen(known.links.map((link) => link.url ?? link.label ?? ''));
  const knownCourses = seen(known.courses.map((entry) => entry.code ?? entry.title ?? ''));

  const fresh = (set: Set<string>, key: string) => !set.has(key.trim().toLowerCase());

  return {
    name: known.name ? undefined : candidate.name,
    email: known.email ? undefined : candidate.email,
    phone: known.phone ? undefined : candidate.phone,
    location: known.location ? undefined : candidate.location,
    summary: known.summary ? undefined : candidate.summary,
    links: candidate.links.filter((link) => fresh(knownLinks, link.url ?? link.label ?? '')),
    education: candidate.education.filter((entry) =>
      fresh(knownEducation, `${entry.school ?? ''}|${entry.degree ?? ''}`),
    ),
    experience: candidate.experience.filter((entry) =>
      fresh(knownExperience, `${entry.company ?? ''}|${entry.title ?? ''}`),
    ),
    projects: candidate.projects.filter((entry) => fresh(knownProjects, entry.name ?? '')),
    skills: candidate.skills.filter((skill) => fresh(knownSkills, skill)),
    courses: candidate.courses.filter((entry) =>
      fresh(knownCourses, entry.code ?? entry.title ?? ''),
    ),
    certifications: candidate.certifications.filter((cert) => fresh(knownCerts, cert)),
  };
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item).trim().toLowerCase();
    if (k === '') return true; // Keep unkeyable entries rather than collapsing them all into one.
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------------------ analysis */

/**
 * One line of the progress log the user watches.
 *
 * `state` drives the UI: 'start' renders a spinner, and a later event with the same
 * `id` settles it. The log is deliberately specific about what is happening to whose
 * data and which model is being called — a progress bar that just says "Processing"
 * teaches the user nothing about a system whose entire pitch is that it explains
 * itself.
 */
export type IntakeProgress =
  | {
      type: 'log';
      id: string;
      label: string;
      detail?: string;
      state: 'start' | 'ok' | 'warn' | 'skip';
      ms?: number;
    }
  | { type: 'complete'; factsAppended: number; openGaps: number; next: string; ms: number }
  | { type: 'error'; message: string };

/**
 * The two sentences every URL-only outcome has to contain, written once.
 *
 * They are constants because they are the POINT of this module's honesty: the first
 * refuses to imply we read the page, the second turns the gap into something the
 * user can act on. Copy-pasting them into five log branches is how one of them
 * eventually drifts into a claim we cannot back.
 */
const NOT_READ =
  'I did not read your LinkedIn page: LinkedIn has no public profile API and serves a login wall to anonymous requests, so the only honest options are the public web or a file you export yourself.';

const EXPORT_FIX =
  'To make this certain, go to LinkedIn → Settings → Data privacy → Get a copy of your data, then upload the archive on the LinkedIn step — that file is yours and it produces real roles, skills and schools.';

export type AnalysisSummary = {
  factsAppended: number;
  openGaps: number;
  logs: IntakeProgress[];
  error?: string;
};

/**
 * Read everything staged, combine it, and write the profile — yielding a log line
 * at every step so the caller can stream it.
 *
 * An async generator rather than a callback so the SSE route stays a dumb pipe and
 * this file keeps the entire sequence in one readable list. Each document is marked
 * 'parsed' as it completes, so an interrupted run resumes instead of redoing work
 * (and, more importantly, instead of appending its facts twice).
 *
 * Never throws. A failure yields an 'error' event and marks that document 'failed';
 * one unreadable resume must not cost the user the rest of their profile.
 */
export async function* analyzeIntake(userId: string): AsyncGenerator<IntakeProgress> {
  const startedAll = Date.now();
  let factsAppended = 0;
  let openGaps = 0;

  const step = (id: string, label: string, detail?: string): IntakeProgress => ({
    type: 'log',
    id,
    label,
    detail,
    state: 'start',
  });
  const settle = (
    id: string,
    label: string,
    at: number,
    state: 'ok' | 'warn' | 'skip',
    detail?: string,
  ): IntakeProgress => ({ type: 'log', id, label, detail, state, ms: Date.now() - at });

  try {
    let at = Date.now();
    yield step('collect', 'Checking what you gave me');
    const pending = await pendingIntake(userId);
    // Most authoritative first, explicitly, because mergeProfiles() resolves every
    // single-value conflict in exactly this order and uploaded_at does not encode
    // authority — someone who goes back and adds their LinkedIn export after the
    // resume must not have it outrank the resume just for arriving later.
    //
    //   resume            the document the user curated for employers
    //   transcript        the registrar's own record of coursework
    //   linkedin export   accurate, but a profile people maintain less carefully
    //   (web enrichment)  appended last of all, below — inference, not a document
    const AUTHORITY: IntakeKind[] = ['resume_pdf', 'transcript_pdf', 'linkedin_export_pdf'];
    const documents = pending
      .filter((doc) => doc.kind !== 'linkedin_url')
      .sort((a, b) => AUTHORITY.indexOf(a.kind) - AUTHORITY.indexOf(b.kind));
    const links = pending.filter((doc) => doc.kind === 'linkedin_url');
    const alreadyRead = await parsedCount(userId);
    yield settle(
      'collect',
      'Checking what you gave me',
      at,
      'ok',
      [
        pending.length > 0
          ? `${documents.length} document(s) and ${links.length} link(s) waiting.`
          : // "Nothing pending" has two causes and they are not the same sentence. It
            // used to say "you skipped both steps" either way, which on a re-run told a
            // user whose export we had just read that they had given us nothing.
            alreadyRead > 0
            ? 'Nothing new to read — everything you gave me has already been read, so this pass only re-checks what is still an open question.'
            : 'Nothing new to read — you skipped both steps, so everything becomes a question instead.',
        alreadyRead > 0
          ? `${alreadyRead} source(s) were already read on an earlier pass; I load what they established rather than reading them again.`
          : undefined,
      ]
        .filter(Boolean)
        .join(' '),
    );

    /**
     * Most authoritative first. The BASELINE goes first of all: it is the union of
     * everything earlier passes established, already resolved by the COALESCE in
     * writeStructuredProfile, so it holds the values that previously won. Without it
     * a second pass would see an empty profile, re-open questions its own documents
     * had answered, and hand web enrichment nobody to disambiguate against.
     */
    const extracted: ExtractedProfile[] = [];
    if (alreadyRead > 0) extracted.push(await knownProfile(userId));
    let linkedinUrl: string | undefined;
    // Sources actually READ on this pass, which is not extracted.length: that array
    // also carries the baseline and the link-only contribution below.
    let sourcesRead = 0;

    for (const doc of documents) {
      const what = doc.fileName ?? 'your document';
      if (!doc.storagePath) {
        yield settle(`doc:${doc.documentId}`, `Reading ${what}`, Date.now(), 'warn', 'No stored file to read.');
        await markDocument(doc.documentId, { status: 'failed', error: 'No storage_path on a received document.' });
        continue;
      }

      try {
        at = Date.now();
        yield step(`fetch:${doc.documentId}`, `Fetching ${what} back from secure storage`);
        const bytes = await getUpload(doc.storagePath);
        yield settle(
          `fetch:${doc.documentId}`,
          `Fetching ${what} back from secure storage`,
          at,
          'ok',
          `${(bytes.byteLength / 1024).toFixed(0)} KB from the Unity Catalog volume.`,
        );

        const isExport = doc.kind === 'linkedin_export_pdf';
        at = Date.now();
        yield step(
          `read:${doc.documentId}`,
          `Reading ${what}`,
          isExport
            ? 'Your LinkedIn data export has a fixed shape, so this is parsed directly — no model, nothing to invent.'
            : 'Extracting text, then asking the model for structured fields. This is the slow part.',
        );
        // Typed as the wider outcome so `outcome.export` is reachable without an `in`
        // narrowing, which TypeScript cannot do through an optional property.
        const outcome: LinkedInExportOutcome = isExport
          ? await extractLinkedInExport(bytes, doc.fileName ?? undefined)
          : await extractProfile(bytes);

        // What the higher-authority documents already established, captured BEFORE
        // this one joins the list. Used below so this document writes only its own
        // new contribution: the child tables are keyed by source_document_id, so a
        // resume and a LinkedIn export that both list the same internship would
        // otherwise put it on the profile page twice.
        const known = mergeProfiles(extracted);
        extracted.push(outcome.profile);
        sourcesRead += 1;

        // The export path can name exactly which sheets it understood, which is a far
        // better answer than a count — "Positions, Skills, Education" tells the user
        // both that we read their file and what it contained.
        const exported = outcome.export;
        yield settle(
          `read:${doc.documentId}`,
          `Reading ${what}`,
          at,
          outcome.warnings.length || (exported && exported.sections.length === 0) ? 'warn' : 'ok',
          [
            `${providerLabel(outcome.provider)} · ${outcome.model}`,
            exported?.sections.length
              ? `Understood ${exported.sections.join(', ')}.`
              : undefined,
            `${outcome.profile.skills.length} skills, ${outcome.profile.experience.length} roles, ${outcome.profile.education.length} schools, ${outcome.profile.courses.length} courses.`,
            // Said out loud because a user who exported everything WILL wonder where
            // their connections went, and "we chose not to keep other people's data"
            // is a better answer than silence.
            exported?.connectionsSeen
              ? `Saw ${exported.connectionsSeen} connections and stored none of them — those are other people's details, not your profile.`
              : undefined,
            exported?.unrecognised.length
              ? `Did not recognise ${exported.unrecognised.slice(0, 4).join(', ')}.`
              : undefined,
            ...outcome.warnings,
          ]
            .filter(Boolean)
            .join(' — '),
        );

        at = Date.now();
        yield step(`save:${doc.documentId}`, `Filing what ${what} told me`);
        const contribution = subtractProfile(outcome.profile, known);
        await writeStructuredProfile(userId, doc.documentId, contribution, {});
        const appended = await appendFacts(
          toFacts(contribution, {
            userId,
            provider: outcome.provider,
            model: outcome.model,
            sourceRef: doc.documentId,
            sourceKind: SOURCE_KINDS[doc.kind],
            // The export gets its own fact_key namespace so its contact.name cannot
            // become the current value over the resume's just by being appended a
            // second later — see the keyPrefix note in profile-memory.ts.
            keyPrefix: isExport ? 'linkedin.' : undefined,
          }),
        );
        factsAppended += appended;
        await markDocument(doc.documentId, {
          status: 'parsed',
          provider: outcome.provider,
          model: outcome.model,
          warnings: outcome.warnings,
        });
        yield settle(
          `save:${doc.documentId}`,
          `Filing what ${what} told me`,
          at,
          'ok',
          `${appended} facts recorded, each with where it came from.` +
            (appended === 0
              ? ' Everything it said was already on file from a more authoritative source, so nothing was duplicated.'
              : ''),
        );
      } catch (error) {
        const message = (error as Error).message;
        yield settle(`read:${doc.documentId}`, `Reading ${what}`, Date.now(), 'warn', message);
        try {
          await markDocument(doc.documentId, { status: 'failed', error: message });
        } catch {
          // Bookkeeping only. The yielded warning above is the report that matters.
        }
      }
    }

    /**
     * A LinkedIn URL on its own.
     *
     * THE URL IS SAVED FIRST AND UNCONDITIONALLY. It is the thing the user actually
     * typed; nothing about enrichment is allowed to put it at risk.
     *
     * Then we try to learn something, WITHOUT touching linkedin.com. There is no
     * public profile API and an anonymous request gets a login wall, so the attempt
     * is aimed at the rest of the public web — and it is seeded with what the
     * resume already established, because "Alex Nguyen" alone would enrich a
     * stranger. Everything it produces is marked as inference: source 'web:gemini:…',
     * confidence halved, appended under its own fact_key namespace, ordered last in
     * the merge, and filtered against what the documents already said.
     *
     * Every failure mode — no key, no network, a refusal, the wrong person, nothing
     * found — lands in the same honest branch, which names the export upload as the
     * fix. That is an actionable gap rather than a dead end, and it is the line this
     * whole change exists to replace.
     */
    for (const doc of links) {
      linkedinUrl = doc.externalUrl ?? undefined;
      at = Date.now();
      yield step('linkedin', 'Recording your LinkedIn');
      try {
        await writeStructuredProfile(userId, doc.documentId, emptyProfile(), { linkedinUrl });
        if (linkedinUrl) {
          factsAppended += await appendFacts([
            singleFact({
              userId,
              kind: 'contact',
              key: 'contact.linkedin',
              value: linkedinUrl,
              // 1.0 is right here and nowhere else in this block: the user typed it.
              confidence: 1,
              source: 'linkedin:user:typed',
              sourceRef: doc.documentId,
            }),
          ]);
        }
        // Marked parsed HERE, before enrichment runs — not after.
        //
        // profile_memory is append-only and contact.linkedin has just landed, so if
        // anything below failed with the document still 'received', the next run
        // would append the URL fact a second time. Enrichment is an optional upgrade
        // and must not be able to cost us idempotency; 'parsed' therefore means "the
        // URL is recorded", and a failed enrichment is reported in the log rather
        // than retried into a duplicate.
        await markDocument(doc.documentId, { status: 'parsed', provider: 'none' });

        // A saved LinkedIn URL IS a link, so the merged profile has to know about it
        // before gap detection runs. Without this the very first pass saved the URL
        // and then queued "Do you have a GitHub or portfolio link?" for the voice
        // agent to ask — which a second pass silently corrected, because
        // knownProfile() reads profiles.linkedin_url back. Answering it on the pass
        // that saved it is the honest ordering.
        if (linkedinUrl) {
          extracted.push({ ...emptyProfile(), links: [{ label: 'LinkedIn', url: linkedinUrl }] });
        }

        yield settle(
          'linkedin',
          'Recording your LinkedIn',
          at,
          'ok',
          'Saved and attached to your profile.',
        );

        // --- best-effort enrichment, clearly labelled as such ------------------
        const known = mergeProfiles(extracted);
        at = Date.now();

        if (!linkedinUrl) {
          // Nothing to seed with. Should not happen, but a silent skip would be the
          // same defect as the log line this replaces.
          yield settle(
            'linkedin:web',
            'Looking for anything public about you',
            at,
            'skip',
            'No URL was stored on that document, so there was nothing to search from.',
          );
        } else if (!canEnrich()) {
          yield settle(
            'linkedin:web',
            'Looking for anything public about you',
            at,
            'skip',
            `${NOT_READ} Nor did I search for you: GOOGLE_GENERATIVE_AI_API_KEY is not configured, so the public-web enrichment had no way to run. ${EXPORT_FIX}`,
          );
        } else {
          yield step(
            'linkedin:web',
            'Looking for anything public about you',
            'Searching the public web — not LinkedIn itself, which blocks anonymous requests. Seeded with your name, employer and school so I do not describe someone else.',
          );

          const enriched = await enrichFromPublicWeb({
            linkedinUrl,
            name: known.name,
            location: known.location,
            employers: known.experience
              .map((entry) => entry.company)
              .filter((company): company is string => Boolean(company))
              .slice(0, 4),
            schools: known.education
              .map((entry) => entry.school)
              .filter((school): school is string => Boolean(school))
              .slice(0, 3),
          });

          // Only what the documents did not already say. A search result that merely
          // repeats the resume teaches us nothing and must not append a second,
          // lower-confidence copy of it — so "found something" and "found something
          // NEW" are different questions, and this is the second one.
          const novel = enriched ? subtractProfile(enriched.profile, known) : null;

          if (!enriched) {
            yield settle(
              'linkedin:web',
              'Looking for anything public about you',
              at,
              'warn',
              `${NOT_READ} A public web search turned up nothing I could confidently tie to you — the model either found no pages about you or would not vouch that they were about the right person, and I would rather record nothing than guess. ${EXPORT_FIX}`,
            );
          } else if (!novel || isEmptyProfile(novel)) {
            yield settle(
              'linkedin:web',
              'Looking for anything public about you',
              at,
              'warn',
              `${NOT_READ} A public web search did find pages about you (${enriched.evidence}), but everything on them was already on file from the documents you gave me, so I recorded nothing new rather than a second, less certain copy. ${EXPORT_FIX}`,
            );
          } else {
            // Ordered LAST, after every document, so mergeProfiles can never let an
            // inferred value beat one the user handed us.
            extracted.push(novel);
            await writeStructuredProfile(userId, doc.documentId, novel, { linkedinUrl });
            const appended = await appendFacts(
              toFacts(novel, {
                userId,
                provider: 'gemini',
                model: enriched.model,
                sourceRef: doc.documentId,
                // Distinct from 'resume' on purpose: this is what the UI shows when
                // someone asks why we believe a thing.
                sourceKind: 'web',
                keyPrefix: 'web.',
                confidenceScale: WEB_CONFIDENCE_SCALE,
              }),
            );
            factsAppended += appended;

            yield settle(
              'linkedin:web',
              'Looking for anything public about you',
              at,
              // 'warn', not 'ok'. Rendered with a "!" so a reader cannot mistake
              // inference for a document we read.
              'warn',
              [
                NOT_READ,
                `Instead I searched the public web and found ${describeFindings(novel)}, recorded as ${appended} new fact(s).`,
                `Why I believe it is you: ${enriched.evidence}.`,
                enriched.sources.length
                  ? `Sources: ${enriched.sources.slice(0, 3).join(', ')}${enriched.sources.length > 3 ? ` and ${enriched.sources.length - 3} more` : ''}.`
                  : 'No grounding sources were reported, which makes this weaker still.',
                `This is inference from search results, not a document you handed me, so it is stored at ${Math.round(WEB_CONFIDENCE_SCALE * 100)}% of normal confidence, under its own web.* keys, and can never override your resume.`,
                EXPORT_FIX,
                ...enriched.warnings,
              ].join(' '),
            );
          }
        }
      } catch (error) {
        const message = (error as Error).message;
        // Settle BOTH lines. Whichever phase was in flight, the log must not be left
        // with a spinner that never resolves — that is how the processing page used
        // to hang silently.
        yield settle('linkedin', 'Recording your LinkedIn', at, 'warn', message);
        yield settle(
          'linkedin:web',
          'Looking for anything public about you',
          at,
          'warn',
          `That did not finish: ${message} ${EXPORT_FIX}`,
        );
      }
    }

    at = Date.now();
    yield step('combine', 'Combining every source into one profile');
    const merged = mergeProfiles(extracted);
    // Counted separately from the baseline, because "3 sources" when two of them are
    // last pass's work read back out of Delta would overstate what just happened.
    const freshSources = sourcesRead;
    yield settle(
      'combine',
      'Combining every source into one profile',
      at,
      'ok',
      [
        `Union of ${freshSources || 'no'} new source(s)${alreadyRead > 0 ? ' plus what your profile already held' : ''}:`,
        `${merged.skills.length} skills, ${merged.experience.length} roles, ${merged.education.length} schools, ${merged.courses.length} courses.`,
        'A gap in one source is filled by another before I decide what to ask you.',
      ].join(' '),
    );

    at = Date.now();
    yield step('gaps', 'Working out what I still need to ask');
    openGaps = await recomputeGaps(userId, merged);
    yield settle(
      'gaps',
      'Working out what I still need to ask',
      at,
      'ok',
      `${openGaps} open question(s) queued for the voice agent.`,
    );

    yield {
      type: 'complete',
      factsAppended,
      openGaps,
      next: '/applicant',
      ms: Date.now() - startedAll,
    };
  } catch (error) {
    yield { type: 'error', message: (error as Error).message };
  }
}

/** Drain the generator. For callers that want the outcome, not the narration. */
export async function runIntakeAnalysis(userId: string): Promise<AnalysisSummary> {
  const logs: IntakeProgress[] = [];
  let factsAppended = 0;
  let openGaps = 0;
  let error: string | undefined;

  for await (const event of analyzeIntake(userId)) {
    logs.push(event);
    if (event.type === 'complete') {
      factsAppended = event.factsAppended;
      openGaps = event.openGaps;
    }
    if (event.type === 'error') error = event.message;
  }

  return { factsAppended, openGaps, logs, error };
}

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
import { extractProfile } from '@/lib/extract';
import { appendFacts, singleFact, toFacts } from '@/lib/profile-memory';
import { getUpload, putUpload } from '@/lib/uploads';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const DOCS = 'workspace.vthacks_2026.intake_documents';

export type IntakeKind = 'resume_pdf' | 'linkedin_url' | 'linkedin_export_pdf' | 'transcript_pdf';

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
      WHEN NOT MATCHED AND s.desired = 'open'
        THEN INSERT (user_id, field_key, status, priority, question, updated_at)
             VALUES (:user, s.field_key, 'open', s.priority, s.question, current_timestamp())`,
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

  const invalid = validateUpload(file);
  if (invalid) return { ok: false, error: invalid };

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored = await putUpload({
      userId,
      kind,
      bytes,
      fileName: file.name,
      mimeType: file.type || 'application/pdf',
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
      mimeType: file.type || 'application/pdf',
      byteSize: stored.byteSize,
      contentHash: stored.contentHash,
    });
    return { ok: true, documentId, reused: false };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Save a LinkedIn profile URL.
 *
 * NOTE FOR WHOEVER PICKS THIS UP: nothing parses this URL yet. We store it, show
 * it, and hand it on; the structured profile stays thin until something downstream
 * actually fetches the page. The gap fields it would fill are left open on purpose.
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
    const resumes = pending.filter((doc) => doc.kind !== 'linkedin_url');
    const links = pending.filter((doc) => doc.kind === 'linkedin_url');
    yield settle(
      'collect',
      'Checking what you gave me',
      at,
      'ok',
      pending.length === 0
        ? 'Nothing new to read — you skipped both steps, so everything becomes a question instead.'
        : `${resumes.length} document(s) and ${links.length} link(s) waiting.`,
    );

    // Most authoritative first: a resume the user chose to upload beats a link we
    // could not fetch. mergeProfiles resolves single-value conflicts in this order.
    const extracted: ExtractedProfile[] = [];
    let linkedinUrl: string | undefined;

    for (const doc of resumes) {
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

        at = Date.now();
        yield step(
          `read:${doc.documentId}`,
          `Reading ${what}`,
          'Extracting text, then asking the model for structured fields. This is the slow part.',
        );
        const outcome = await extractProfile(bytes);
        extracted.push(outcome.profile);
        yield settle(
          `read:${doc.documentId}`,
          `Reading ${what}`,
          at,
          outcome.warnings.length ? 'warn' : 'ok',
          [
            `${outcome.provider} · ${outcome.model}`,
            `${outcome.profile.skills.length} skills, ${outcome.profile.experience.length} roles, ${outcome.profile.education.length} schools, ${outcome.profile.courses.length} courses.`,
            ...outcome.warnings,
          ].join(' — '),
        );

        at = Date.now();
        yield step(`save:${doc.documentId}`, `Filing what ${what} told me`);
        await writeStructuredProfile(userId, doc.documentId, outcome.profile, {});
        const appended = await appendFacts(
          toFacts(outcome.profile, {
            userId,
            provider: outcome.provider,
            model: outcome.model,
            sourceRef: doc.documentId,
            sourceKind: doc.kind === 'transcript_pdf' ? 'transcript' : 'resume',
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
          `${appended} facts recorded, each with where it came from.`,
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
              confidence: 1,
              source: 'linkedin:user:typed',
              sourceRef: doc.documentId,
            }),
          ]);
        }
        await markDocument(doc.documentId, { status: 'parsed', provider: 'none' });
        // Stated plainly rather than dressed up as a read. LinkedIn has no public
        // profile API and blocks unauthenticated fetches, so claiming to have read
        // the page would be a lie the profile page would immediately contradict.
        yield settle(
          'linkedin',
          'Recording your LinkedIn',
          at,
          'warn',
          'Saved and attached to your profile. I have not read the page: LinkedIn has no public profile API and blocks anonymous fetches, so an agent has to collect it separately.',
        );
      } catch (error) {
        yield settle('linkedin', 'Recording your LinkedIn', at, 'warn', (error as Error).message);
      }
    }

    at = Date.now();
    yield step('combine', 'Combining every source into one profile');
    const merged = mergeProfiles(extracted);
    yield settle(
      'combine',
      'Combining every source into one profile',
      at,
      'ok',
      `Union of ${extracted.length || 'no'} source(s): ${merged.skills.length} skills, ${merged.experience.length} roles, ${merged.education.length} schools, ${merged.courses.length} courses. A gap in one source is filled by another before I decide what to ask you.`,
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

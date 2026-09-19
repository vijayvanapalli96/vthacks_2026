/**
 * intake.ts — the one path from "user handed us something" to "the profile knows it".
 *
 * Every source goes through ingest(): a resume PDF, a LinkedIn URL, later a
 * transcript. The steps are always the same, which is why they live in one place
 * rather than in each route:
 *
 *   hash -> idempotency check -> store bytes -> record the source
 *        -> extract -> structured profile -> append memory -> recompute gaps
 *
 * IDEMPOTENCY IS A FEATURE, NOT A NICETY. profile_memory is append-only, so a
 * second upload of the same file would permanently double every fact and the
 * profile page would show each skill twice. A demo operator re-uploading during
 * rehearsal is the likeliest way to trigger it. The (user_id, content_hash) check
 * in step 2 is what prevents that.
 *
 * ingest() never throws at its caller. A failed parse is a rendered error and a
 * 'failed' row, not a 500.
 */
import { randomUUID } from 'node:crypto';

import { sql, type SqlParam } from '@/lib/databricks';
import {
  detectGaps,
  emptyProfile,
  type ExtractedProfile,
  type ExtractProvider,
} from '@/lib/extract/types';
import { extractProfile } from '@/lib/extract';
import { appendFacts, singleFact, toFacts } from '@/lib/profile-memory';
import { putUpload } from '@/lib/uploads';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const DOCS = 'workspace.vthacks_2026.intake_documents';

export type IntakeKind = 'resume_pdf' | 'linkedin_url' | 'linkedin_export_pdf' | 'transcript_pdf';

export type IntakeOk = {
  ok: true;
  documentId: string;
  /** True when we recognised the bytes and did no work. */
  reused: boolean;
  skipped: boolean;
  profile: ExtractedProfile;
  provider: ExtractProvider | null;
  model: string | null;
  factsAppended: number;
  openGaps: number;
  warnings: string[];
};

export type IntakeErr = { ok: false; error: string };
export type IntakeResult = IntakeOk | IntakeErr;

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
export async function nextIntakeStep(userId: string): Promise<string | null> {
  const result = await sql(
    `SELECT kind FROM ${DOCS} WHERE user_id = :user AND kind IN ('resume_pdf', 'linkedin_url') GROUP BY kind`,
    [{ name: 'user', value: userId }],
  );
  const seen = new Set(result.rows.map((row) => row[0]));
  if (!seen.has('resume_pdf')) return '/applicant/intake/resume';
  if (!seen.has('linkedin_url')) return '/applicant/intake/linkedin';
  return null;
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
async function recomputeGaps(userId: string, profile: ExtractedProfile, everything: boolean): Promise<number> {
  const missingFromDoc = new Set(detectGaps(profile).map((gap) => gap.key));

  const rows = GAP_FIELDS.map((gap) => {
    const open = everything || !gap.fromDocument || missingFromDoc.has(gap.field);
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

/** Skipping is a recorded outcome: it opens every gap so the agent knows what to ask. */
export async function skipIntake(userId: string, kind: IntakeKind): Promise<IntakeResult> {
  try {
    const documentId = randomUUID();
    await insertDocument({ documentId, userId, kind, status: 'skipped' });
    const openGaps = await recomputeGaps(userId, emptyProfile(), true);
    return {
      ok: true,
      documentId,
      reused: false,
      skipped: true,
      profile: emptyProfile(),
      provider: null,
      model: null,
      factsAppended: 0,
      openGaps,
      warnings: [],
    };
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
export async function ingestLinkedInUrl(userId: string, url: string): Promise<IntakeResult> {
  try {
    const documentId = randomUUID();
    await insertDocument({
      documentId,
      userId,
      kind: 'linkedin_url',
      status: 'parsed',
      externalUrl: url,
    });
    await writeStructuredProfile(userId, documentId, emptyProfile(), { linkedinUrl: url });
    const factsAppended = await appendFacts([
      singleFact({
        userId,
        kind: 'contact',
        key: 'contact.linkedin',
        value: url,
        confidence: 1,
        source: 'linkedin:user:typed',
        sourceRef: documentId,
      }),
    ]);
    await markDocument(documentId, { status: 'parsed', provider: 'none' });
    const openGaps = await recomputeGaps(userId, emptyProfile(), false);
    return {
      ok: true,
      documentId,
      reused: false,
      skipped: false,
      profile: emptyProfile(),
      provider: null,
      model: null,
      factsAppended,
      openGaps,
      warnings: [],
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Ingest a document: store the bytes, extract, and fold the result into the profile. */
export async function ingestDocument(args: {
  userId: string;
  kind: Extract<IntakeKind, 'resume_pdf' | 'linkedin_export_pdf' | 'transcript_pdf'>;
  file: File;
}): Promise<IntakeResult> {
  const { userId, kind, file } = args;

  const invalid = validateUpload(file);
  if (invalid) return { ok: false, error: invalid };

  const documentId: string = randomUUID();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());

    // Store first, then dedupe on the hash the upload computed: the bytes are
    // content-addressed, so re-storing an identical file is a no-op overwrite.
    const stored = await putUpload({
      userId,
      kind,
      bytes,
      fileName: file.name,
      mimeType: file.type || 'application/pdf',
    });

    const existing = await findParsedByHash(userId, stored.contentHash);
    if (existing) {
      // Already parsed. Appending again would duplicate every fact forever.
      const openGaps = Number(
        (
          await sql(
            `SELECT count(*) FROM workspace.vthacks_2026.profile_gaps
              WHERE user_id = :user AND status = 'open'`,
            [{ name: 'user', value: userId }],
          )
        ).rows[0]?.[0] ?? 0,
      );
      return {
        ok: true,
        documentId: existing,
        reused: true,
        skipped: false,
        profile: emptyProfile(),
        provider: null,
        model: null,
        factsAppended: 0,
        openGaps,
        warnings: ['We already read this exact file, so nothing was added twice.'],
      };
    }

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

    const outcome = await extractProfile(bytes);

    await writeStructuredProfile(userId, documentId, outcome.profile, {});
    const factsAppended = await appendFacts(
      toFacts(outcome.profile, {
        userId,
        provider: outcome.provider,
        model: outcome.model,
        sourceRef: documentId,
        sourceKind: kind === 'transcript_pdf' ? 'transcript' : 'resume',
      }),
    );
    await markDocument(documentId, {
      status: 'parsed',
      provider: outcome.provider,
      model: outcome.model,
      warnings: outcome.warnings,
    });
    const openGaps = await recomputeGaps(userId, outcome.profile, false);

    return {
      ok: true,
      documentId,
      reused: false,
      skipped: false,
      profile: outcome.profile,
      provider: outcome.provider,
      model: outcome.model,
      factsAppended,
      openGaps,
      warnings: outcome.warnings,
    };
  } catch (error) {
    const message = (error as Error).message;
    // Best-effort. The row may not exist yet — the failure could have been the
    // upload itself — and a failed bookkeeping write must not mask the real error.
    try {
      await markDocument(documentId, { status: 'failed', error: message });
    } catch {
      // Swallowed deliberately: `message` below is the one worth reporting.
    }
    return { ok: false, error: message };
  }
}

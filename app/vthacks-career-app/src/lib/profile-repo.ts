/**
 * profile-repo.ts — reads for the profile page.
 *
 * Writes live in intake.ts; this file only selects. Keeping them apart means the
 * page cannot accidentally mutate the profile while rendering it.
 *
 * Every child row carries its source document, and the document carries which
 * model read it. That chain is what lets each section say where it came from —
 * evidence rather than assertion, which is also what makes a generated resume
 * defensible later.
 */
import { sql } from '@/lib/databricks';

export type ProfileHeader = {
  fullName?: string;
  email?: string;
  phone?: string;
  location?: string;
  headline?: string;
  summary?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  updatedAt?: string;
};

export type ExperienceRow = {
  company?: string;
  title?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  bullets: string[];
  sourceDocumentId?: string;
};

export type EducationRow = {
  school?: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
  gpa?: string;
  sourceDocumentId?: string;
};

export type SkillRow = { skill: string; sourceDocumentId?: string };
export type ProjectRow = { name?: string; description?: string; tech: string[]; sourceDocumentId?: string };
export type CertificationRow = { name?: string; issuer?: string; sourceDocumentId?: string };
export type CourseRow = { code: string; title?: string };

export type GapRow = { field: string; question?: string; priority: number };

export type SourceRow = {
  documentId: string;
  kind: string;
  status: string;
  fileName?: string;
  externalUrl?: string;
  storagePath?: string;
  provider?: string;
  model?: string;
  uploadedAt?: string;
};

export type FullProfile = {
  header: ProfileHeader | null;
  experience: ExperienceRow[];
  education: EducationRow[];
  skills: SkillRow[];
  projects: ProjectRow[];
  certifications: CertificationRow[];
  courses: CourseRow[];
  gaps: GapRow[];
  sources: SourceRow[];
  factCount: number;
};

const blank = (value: string | null): string | undefined => value ?? undefined;

/**
 * Delta returns ARRAY columns as JSON text over the SQL API, so they need parsing
 * rather than splitting.
 */
function parseArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * One call, nine queries. They are independent, so they go out together — against a
 * warehouse where each round trip costs real time, serialising them would be the
 * difference between a page that loads and a page that feels broken.
 */
export async function loadProfile(userId: string): Promise<FullProfile> {
  const user = [{ name: 'user', value: userId }];

  const [
    header,
    experience,
    education,
    skills,
    projects,
    certifications,
    courses,
    gaps,
    sources,
    facts,
  ] = await Promise.all([
    sql(
      `SELECT full_name, email, phone, location, headline, summary, linkedin_url, github_url, portfolio_url, updated_at
         FROM workspace.vthacks_2026.profiles WHERE user_id = :user LIMIT 1`,
      user,
    ),
    sql(
      `SELECT company, title, location, start_date, end_date, bullets, source_document_id
         FROM workspace.vthacks_2026.profile_experience WHERE user_id = :user ORDER BY ordinal`,
      user,
    ),
    sql(
      `SELECT school, degree, field, start_date, end_date, gpa, source_document_id
         FROM workspace.vthacks_2026.profile_education WHERE user_id = :user`,
      user,
    ),
    sql(
      `SELECT skill, source_document_id FROM workspace.vthacks_2026.profile_skills
        WHERE user_id = :user ORDER BY skill`,
      user,
    ),
    sql(
      `SELECT name, description, tech, source_document_id
         FROM workspace.vthacks_2026.profile_projects WHERE user_id = :user`,
      user,
    ),
    sql(
      `SELECT name, issuer, source_document_id
         FROM workspace.vthacks_2026.profile_certifications WHERE user_id = :user`,
      user,
    ),
    sql(
      `SELECT course_code, title FROM workspace.vthacks_2026.courses
        WHERE user_id = :user ORDER BY course_code`,
      user,
    ),
    sql(
      `SELECT field_key, question, priority FROM workspace.vthacks_2026.profile_gaps
        WHERE user_id = :user AND status = 'open' ORDER BY priority`,
      user,
    ),
    sql(
      `SELECT document_id, kind, status, file_name, external_url, storage_path, extract_provider, extract_model, uploaded_at
         FROM workspace.vthacks_2026.intake_documents
        WHERE user_id = :user ORDER BY uploaded_at DESC`,
      user,
    ),
    sql(`SELECT count(*) FROM workspace.vthacks_2026.profile_memory WHERE user_id = :user`, user),
  ]);

  const headerRow = header.rows[0];

  return {
    header: headerRow
      ? {
          fullName: blank(headerRow[0]),
          email: blank(headerRow[1]),
          phone: blank(headerRow[2]),
          location: blank(headerRow[3]),
          headline: blank(headerRow[4]),
          summary: blank(headerRow[5]),
          linkedinUrl: blank(headerRow[6]),
          githubUrl: blank(headerRow[7]),
          portfolioUrl: blank(headerRow[8]),
          updatedAt: blank(headerRow[9]),
        }
      : null,
    experience: experience.rows.map((row) => ({
      company: blank(row[0]),
      title: blank(row[1]),
      location: blank(row[2]),
      startDate: blank(row[3]),
      endDate: blank(row[4]),
      bullets: parseArray(row[5]),
      sourceDocumentId: blank(row[6]),
    })),
    education: education.rows.map((row) => ({
      school: blank(row[0]),
      degree: blank(row[1]),
      field: blank(row[2]),
      startDate: blank(row[3]),
      endDate: blank(row[4]),
      gpa: blank(row[5]),
      sourceDocumentId: blank(row[6]),
    })),
    skills: skills.rows.map((row) => ({ skill: row[0] ?? '', sourceDocumentId: blank(row[1]) })),
    projects: projects.rows.map((row) => ({
      name: blank(row[0]),
      description: blank(row[1]),
      tech: parseArray(row[2]),
      sourceDocumentId: blank(row[3]),
    })),
    certifications: certifications.rows.map((row) => ({
      name: blank(row[0]),
      issuer: blank(row[1]),
      sourceDocumentId: blank(row[2]),
    })),
    courses: courses.rows.map((row) => ({ code: row[0] ?? '', title: blank(row[1]) })),
    gaps: gaps.rows.map((row) => ({
      field: row[0] ?? '',
      question: blank(row[1]),
      priority: Number(row[2] ?? 0),
    })),
    sources: sources.rows.map((row) => ({
      documentId: row[0] ?? '',
      kind: row[1] ?? '',
      status: row[2] ?? '',
      fileName: blank(row[3]),
      externalUrl: blank(row[4]),
      storagePath: blank(row[5]),
      provider: blank(row[6]),
      model: blank(row[7]),
      uploadedAt: blank(row[8]),
    })),
    factCount: Number(facts.rows[0]?.[0] ?? 0),
  };
}

/** Human label for a source document, used in the provenance line of each section. */
export function describeSource(sources: SourceRow[], documentId: string | undefined): string {
  if (!documentId) return 'unknown source';
  const source = sources.find((candidate) => candidate.documentId === documentId);
  if (!source) return 'a source that has since been removed';
  const name =
    source.fileName ?? source.externalUrl ?? (source.kind === 'linkedin_url' ? 'LinkedIn URL' : source.kind);
  return source.model ? `${name} · read by ${source.model}` : name;
}

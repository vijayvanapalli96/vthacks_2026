/**
 * types.ts — the shape of an extracted candidate profile.
 *
 * Every field is optional or defaults to an empty collection, on purpose. Real
 * resumes are messy: no phone number, a degree with no end date, a two-column
 * layout that loses the location line. A parse must never hard-fail because one
 * field is missing — a missing field is a GAP, and gaps are product surface (the
 * voice agent asks about them), not errors.
 *
 * This schema is also the contract handed to the model as its output spec, so
 * keep field names self-describing: the model reads them as instructions.
 */
import { z } from 'zod';

const BLANKISH = new Set(['', 'n/a', 'na', 'none', 'null', 'undefined', 'unknown', '-', '--']);

function isBlankish(value: string): boolean {
  return BLANKISH.has(value.toLowerCase());
}

/**
 * A trimmed, non-empty string, or undefined.
 *
 * MUST accept null. OUTPUT_SPEC below tells the model to emit `string|null` for
 * every absent field, so null is the documented happy path, not an edge case — a
 * schema that rejects it fails on any resume missing a phone number. Also scrubs
 * the placeholder junk models emit instead of null ("N/A", "unknown", "").
 */
const looseString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null || value === undefined) return undefined;
    const trimmed = value.trim();
    return isBlankish(trimmed) ? undefined : trimmed;
  });

/**
 * An array that tolerates null and a missing key alike — models return `null`
 * for "no projects" about as often as they return `[]`.
 */
function looseArray<T extends z.ZodTypeAny>(item: T) {
  return z
    .union([z.array(item), z.null()])
    .optional()
    .transform((value) => value ?? []);
}

/** Drops blankish entries from a string array and de-duplicates case-insensitively. */
const stringList = looseArray(z.union([z.string(), z.null()])).transform((values) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (raw === null) continue;
    const value = raw.trim();
    if (isBlankish(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
});

export const linkSchema = z.object({
  label: looseString,
  url: looseString,
});

export const educationSchema = z.object({
  school: looseString,
  degree: looseString,
  field: looseString,
  startDate: looseString,
  endDate: looseString,
  gpa: looseString,
});

export const experienceSchema = z.object({
  company: looseString,
  title: looseString,
  startDate: looseString,
  endDate: looseString,
  location: looseString,
  bullets: stringList,
});

export const projectSchema = z.object({
  name: looseString,
  description: looseString,
  tech: stringList,
});

export const courseSchema = z.object({
  code: looseString,
  title: looseString,
});

export const extractedProfileSchema = z.object({
  name: looseString,
  email: looseString,
  phone: looseString,
  location: looseString,
  summary: looseString,
  links: looseArray(linkSchema),
  education: looseArray(educationSchema),
  experience: looseArray(experienceSchema),
  projects: looseArray(projectSchema),
  skills: stringList,
  courses: looseArray(courseSchema),
  certifications: stringList,
});

export type ExtractedProfile = z.infer<typeof extractedProfileSchema>;
export type Education = z.infer<typeof educationSchema>;
export type Experience = z.infer<typeof experienceSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Course = z.infer<typeof courseSchema>;
export type ProfileLink = z.infer<typeof linkSchema>;

export type ExtractProvider = 'databricks' | 'gemini';

export type ExtractionResult = {
  profile: ExtractedProfile;
  /** Which sponsor path produced this. Mirrors match_evaluations.model_provider. */
  provider: ExtractProvider;
  /** Mirrors match_evaluations.model_name. */
  model: string;
  /** Non-fatal problems: provider fallbacks, cold starts, dropped fields. */
  warnings: string[];
};

/** An empty profile — used when every provider fails and we still want to render. */
export function emptyProfile(): ExtractedProfile {
  return extractedProfileSchema.parse({});
}

/**
 * The JSON shape we ask models to emit, as a compact literal embedded in prompts.
 * Written by hand rather than generated from the zod schema because models follow
 * a terse example far more reliably than they follow a JSON Schema dump.
 */
export const OUTPUT_SPEC = `{
  "name": string|null,
  "email": string|null,
  "phone": string|null,
  "location": string|null,
  "summary": string|null,
  "links": [{ "label": string|null, "url": string|null }],
  "education": [{ "school": string|null, "degree": string|null, "field": string|null, "startDate": string|null, "endDate": string|null, "gpa": string|null }],
  "experience": [{ "company": string|null, "title": string|null, "startDate": string|null, "endDate": string|null, "location": string|null, "bullets": [string] }],
  "projects": [{ "name": string|null, "description": string|null, "tech": [string] }],
  "skills": [string],
  "courses": [{ "code": string|null, "title": string|null }],
  "certifications": [string]
}`;

/**
 * Field-by-field gap detection, in the order the voice agent should ask about
 * them. Ordering is deliberate: identity first (cheap, builds rapport), then the
 * things that change which jobs we can match (skills, coursework), then nice-to-have.
 */
const GAP_CHECKS: ReadonlyArray<{
  key: string;
  question: string;
  isMissing: (profile: ExtractedProfile) => boolean;
}> = [
  { key: 'name', question: 'What name should I use on your applications?', isMissing: (p) => !p.name },
  { key: 'email', question: 'What email should employers reply to?', isMissing: (p) => !p.email },
  { key: 'location', question: 'Where are you based, and are you open to relocating?', isMissing: (p) => !p.location },
  { key: 'skills', question: 'Which tools and languages do you want me to match you on?', isMissing: (p) => p.skills.length === 0 },
  { key: 'education', question: 'Where are you studying, and what is your major?', isMissing: (p) => p.education.length === 0 },
  { key: 'courses', question: 'Which courses have you taken? Coursework unlocks roles your resume does not show.', isMissing: (p) => p.courses.length === 0 },
  { key: 'experience', question: 'Tell me about your most recent role or internship.', isMissing: (p) => p.experience.length === 0 },
  { key: 'projects', question: 'Any projects you would want an employer to see?', isMissing: (p) => p.projects.length === 0 },
  { key: 'phone', question: 'Is there a phone number you want on applications?', isMissing: (p) => !p.phone },
  { key: 'links', question: 'Do you have a GitHub or portfolio link?', isMissing: (p) => p.links.length === 0 },
];

export type ProfileGap = { key: string; question: string };

/**
 * What the agent still needs to ask. This is a real output of extraction, not a
 * diagnostic: it is the input to the ElevenLabs questioning flow, and it is what
 * makes "upload or skip" work — skipping just means every gap is open.
 */
export function detectGaps(profile: ExtractedProfile): ProfileGap[] {
  return GAP_CHECKS.filter((check) => check.isMissing(profile)).map(({ key, question }) => ({ key, question }));
}

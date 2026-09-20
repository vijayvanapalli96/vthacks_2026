/**
 * linkedin-api.ts — reading the actual LinkedIn profile, through a resolver.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT. LinkedIn has no public profile API: the official
 * OAuth product ("Sign In with LinkedIn", OpenID Connect) returns a name, a headline, a
 * photo and an email and NOTHING about work history, education or skills — those live
 * behind Partner Program approval, which is a business review measured in weeks. An
 * anonymous GET of a profile gets a login wall. So `linkedin-web.ts` asked a
 * search-grounded model what the PUBLIC web said about a person and labelled the answer
 * as inference, because inference was the best available.
 *
 * This module is the other option: a third-party resolver (Proxycurl) that takes the
 * profile URL and returns the profile as structured JSON. It is a REAL READ, not a
 * guess, and that is the whole reason it is worth a separate module and a separate
 * confidence.
 *
 * THE HONEST CAVEAT, IN THE CODE AND NOT ONLY IN A COMMIT MESSAGE. Proxycurl obtains
 * this data by crawling LinkedIn. That is contrary to LinkedIn's User Agreement, even
 * though *hiQ v. LinkedIn* established that scraping public data is not a CFAA
 * violation in the United States. We are not the crawler and we hold no LinkedIn
 * credential, cookie, or session — but the data reaches us because someone crawled, and
 * anything the UI says about provenance has to be able to say that. Hence
 * `source: 'linkedin:proxycurl'` on every fact rather than a bare 'linkedin', which
 * would imply LinkedIn handed it over.
 *
 * NOT 1.0 CONFIDENCE. This is the profile as a third party last saw and cached it, not
 * a document the user handed us, and a stale employer on a live application is a real
 * harm. It sits above the web-inference path and below anything read off an uploaded
 * file, and it is still merged AFTER the resume so it cannot win a single-value
 * conflict against what the student wrote themselves.
 *
 * NO CONTACT DETAILS ARE KEPT. Proxycurl can return `personal_emails` and
 * `personal_numbers`, harvested from elsewhere. We drop both on the floor: the resume
 * is the right source for an email, and a phone number sourced from a crawler and then
 * printed on a job application is exactly the harm the hard rules exist to prevent.
 *
 * NEVER THROWS. No key, a 401, a 404, an out-of-credit 402, a rate limit, malformed
 * JSON — all return null after recording why, and the caller falls back to the
 * public-web path or degrades to its honest message. An optional upgrade to a profile
 * must not be able to fail the analysis that produced it.
 */
import { extractedProfileSchema, type ExtractedProfile } from '@/lib/extract/types';

/**
 * Person Profile Endpoint, v2. The `url` parameter takes the public profile URL.
 *
 * `use_cache=if-present` is deliberate: it returns a cached crawl when Proxycurl has
 * one, which is both cheaper and much faster than forcing a live fetch, and a profile
 * that changed in the last hour is not a risk this feature needs to carry.
 */
const ENDPOINT = 'https://nubela.co/proxycurl/api/v2/linkedin';

/** Fail fast rather than hold the analysis open on a resolver having a bad day. */
const TIMEOUT_MS = 12_000;

/**
 * Confidence CEILING for anything this module produces. See the header: a real read of
 * a cached profile, so well above the 0.5 the search-inference path gets, and still
 * short of a document the user uploaded.
 */
export const LINKEDIN_API_CONFIDENCE = 0.85;

/** What the UI shows when someone asks why we believe a thing. */
export const LINKEDIN_API_SOURCE = 'linkedin:proxycurl';

export type LinkedInApiResult = {
  profile: ExtractedProfile;
  /** Goes into the fact's model column, so provenance is legible in SQL. */
  source: typeof LINKEDIN_API_SOURCE;
  /** Non-fatal notes — a missing section, a field the plan does not include. */
  warnings: string[];
};

/** Injected so the caller can exercise this without a key or a network. */
export type LinkedInApiTransport = (url: string, key: string) => Promise<unknown>;

export function getResolverKey(): string | null {
  return process.env.PROXYCURL_API_KEY?.trim() || null;
}

/**
 * Is the direct read even available? Absent is a normal, supported state — the caller
 * falls back to the public-web path.
 */
export function canReadLinkedIn(): boolean {
  return getResolverKey() !== null;
}

/* ------------------------------------------------------- the resolver's shape */

/** Proxycurl dates arrive as parts, any of which may be missing. */
type ApiDate = { day?: number | null; month?: number | null; year?: number | null } | null;

type ApiExperience = {
  company?: string | null;
  title?: string | null;
  description?: string | null;
  location?: string | null;
  starts_at?: ApiDate;
  ends_at?: ApiDate;
};

type ApiEducation = {
  school?: string | null;
  degree_name?: string | null;
  field_of_study?: string | null;
  starts_at?: ApiDate;
  ends_at?: ApiDate;
};

type ApiProject = { title?: string | null; description?: string | null; url?: string | null };
type ApiCertification = { name?: string | null; authority?: string | null };

type ApiProfile = {
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  headline?: string | null;
  summary?: string | null;
  occupation?: string | null;
  city?: string | null;
  state?: string | null;
  country_full_name?: string | null;
  experiences?: ApiExperience[] | null;
  education?: ApiEducation[] | null;
  accomplishment_projects?: ApiProject[] | null;
  certifications?: ApiCertification[] | null;
  skills?: string[] | null;
  public_identifier?: string | null;
};

/* --------------------------------------------------------------- conversion */

/** "2021-06", or "2021" when the month is missing, or null. Never a fake month. */
function toMonth(date: ApiDate): string | null {
  if (!date?.year) return null;
  if (!date.month) return String(date.year);
  return `${date.year}-${String(date.month).padStart(2, '0')}`;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

/** City, state, country — whichever of them came back, in that order. */
function toLocation(api: ApiProfile): string | null {
  const parts = [clean(api.city), clean(api.state), clean(api.country_full_name)];
  const present = parts.filter((part): part is string => part !== null);
  return present.length > 0 ? present.join(', ') : null;
}

/**
 * Resolver JSON → the same ExtractedProfile every other extractor produces, parsed
 * through the same zod schema. Exported for tests: this is where the mapping bugs
 * would live, and it needs to be checkable without a key.
 */
export function toProfile(api: ApiProfile): ExtractedProfile {
  const experience = (api.experiences ?? []).map((entry) => ({
    company: clean(entry.company),
    title: clean(entry.title),
    startDate: toMonth(entry.starts_at ?? null),
    endDate: toMonth(entry.ends_at ?? null),
    location: clean(entry.location),
    // One description becomes one bullet. Splitting on newlines would invent
    // structure the profile did not have.
    bullets: clean(entry.description) ? [clean(entry.description) as string] : [],
  }));

  const education = (api.education ?? []).map((entry) => ({
    school: clean(entry.school),
    degree: clean(entry.degree_name),
    field: clean(entry.field_of_study),
    startDate: toMonth(entry.starts_at ?? null),
    endDate: toMonth(entry.ends_at ?? null),
    // LinkedIn has a GPA field but the resolver does not surface it. Null, not '' —
    // "we were not told" and "it is empty" are different facts.
    gpa: null,
  }));

  const projects = (api.accomplishment_projects ?? []).map((entry) => ({
    name: clean(entry.title),
    description: clean(entry.description),
    tech: [],
  }));

  return extractedProfileSchema.parse({
    name: clean(api.full_name) ?? clean([api.first_name, api.last_name].filter(Boolean).join(' ')),
    // Dropped on purpose — see the header. The resolver may well have offered both.
    email: null,
    phone: null,
    location: toLocation(api),
    summary: clean(api.summary) ?? clean(api.headline) ?? clean(api.occupation),
    links: api.public_identifier
      ? [{ label: 'LinkedIn', url: `https://www.linkedin.com/in/${api.public_identifier}` }]
      : [],
    education,
    experience,
    projects,
    skills: api.skills ?? [],
    // Coursework is not on a LinkedIn profile. Left empty rather than inferred from
    // a degree title.
    courses: [],
    certifications: (api.certifications ?? [])
      .map((entry) => clean(entry.name))
      .filter((name): name is string => name !== null),
  });
}

/* ------------------------------------------------------------- the transport */

const defaultTransport: LinkedInApiTransport = async (profileUrl, key) => {
  const query = new URLSearchParams({
    url: profileUrl,
    use_cache: 'if-present',
    // Documented optional include. NOT VERIFIED against a live key — if the plan or
    // the API rejects it the request fails and the caller falls back, which is why
    // this is not the only thing the feature depends on.
    skills: 'include',
  });

  const response = await fetch(`${ENDPOINT}?${query.toString()}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });

  if (!response.ok) {
    // The body carries the useful part ("Person not found", "out of credits"), and the
    // status alone would send someone hunting through docs.
    const detail = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${detail ? ` — ${detail.slice(0, 180)}` : ''}`);
  }

  return response.json();
};

/**
 * Why the last call produced nothing, when the reason was that it never ran.
 *
 * Module-scoped for the same reason as in linkedin-web.ts: `null` already means
 * "nothing usable" at several early returns, and threading a discriminated union
 * through all of them to serve one log line is a bigger change than the problem
 * deserves. Read it with takeApiUnavailableReason() immediately after a null, which
 * clears it so a later null cannot inherit a stale explanation.
 */
let lastUnavailableReason: string | null = null;

export function takeApiUnavailableReason(): string | null {
  const reason = lastUnavailableReason;
  lastUnavailableReason = null;
  return reason;
}

/**
 * Read the profile at `profileUrl`. Never throws; null means "nothing usable", and
 * takeApiUnavailableReason() says whether that was because the call could not be made.
 */
export async function readLinkedInProfile(
  profileUrl: string,
  transport: LinkedInApiTransport = defaultTransport,
): Promise<LinkedInApiResult | null> {
  lastUnavailableReason = null;

  const key = getResolverKey();
  if (!key) return null;

  let payload: ApiProfile;
  try {
    payload = (await transport(profileUrl, key)) as ApiProfile;
  } catch (error) {
    lastUnavailableReason = (error as Error).message.slice(0, 200);
    return null;
  }

  if (!payload || typeof payload !== 'object') {
    lastUnavailableReason = 'the resolver returned something that was not a profile object';
    return null;
  }

  const profile = toProfile(payload);
  const warnings: string[] = [];

  // A 200 with an empty body is a real outcome for a private or renamed profile, and
  // it must not be reported as a successful read of nothing.
  if (!profile.name && profile.experience.length === 0 && profile.education.length === 0) {
    lastUnavailableReason =
      'the resolver answered but the profile was empty — it is usually a private profile or a URL that no longer resolves';
    return null;
  }

  if (profile.skills.length === 0) {
    warnings.push('No skills came back, so skill matching still rests on your resume.');
  }

  return { profile, source: LINKEDIN_API_SOURCE, warnings };
}

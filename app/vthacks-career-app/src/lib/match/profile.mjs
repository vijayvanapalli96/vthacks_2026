/**
 * profile.mjs — read the one thing stage 1 needs: what we know about the student.
 *
 * Reads only. `profile_memory` is APPEND-ONLY (hard rule 1) and nothing here
 * writes at all — not an INSERT, not an UPDATE. Matching is a recommendation,
 * never an action (hard rule 3).
 *
 * Six sources, and each is here for a different reason:
 *   profiles          the summary, which is what gets EMBEDDED
 *   profile_skills    the CLAIMED skills -> the `existing` bucket
 *   experience+       the prose evidence -> the `supportedByResume` bucket
 *   courses           -> `courses_matched`
 *   goals             the preferences the hard filters and the gate read
 *   profile_education the highest degree -> whether a PhD-only posting is reachable
 *
 * The `sql` client is INJECTED rather than imported. There are two of them in
 * this repo — the app's `src/lib/databricks.ts` and the scripts' longer-polling
 * `scripts/lib/dbsql.mjs` — and this module has to run under both: the Next
 * route needs the first, the live end-to-end CLI run needs the second. Injection
 * is what keeps the API route and the CLI on ONE code path instead of two that
 * drift.
 */

/**
 * The injected SQL client.
 *
 * `type` is the SAME closed union `src/lib/databricks.ts` declares, not a bare
 * `string`. Function parameters are contravariant, so a WIDENED parameter type
 * here is not assignable from the app's narrower `sql` — `type?: string` fails
 * `npm run typecheck` at the route, which is the type system correctly refusing to
 * let this module claim it accepts clients the app cannot supply.
 *
 * @typedef {'STRING'|'TIMESTAMP'|'INT'|'BIGINT'|'DOUBLE'|'BOOLEAN'} SqlParamType
 * @typedef {{name: string, value: string|null, type?: SqlParamType}} SqlParam
 * @typedef {(statement: string, parameters?: SqlParam[])
 *           => Promise<{columns: string[], rows: (string|null)[][]}>} SqlFn
 */

import { highestDegreeOf } from './title-match.mjs';

const FQ = 'workspace.vthacks_2026';

function rowObjects(result) {
  return result.rows.map((row) => {
    const out = {};
    result.columns.forEach((name, i) => {
      out[name] = row[i];
    });
    return out;
  });
}

/**
 * Databricks JSON_ARRAY results render an ARRAY<STRING> column as a JSON string.
 * Parse defensively: a malformed array must yield [] rather than throw and lose
 * the whole run.
 */
function parseArray(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Load everything stage 1 reads, in FOUR statements rather than eight.
 *
 * Batched deliberately: the warehouse costs ~$2.80/hour whenever awake and each
 * statement is a round trip that keeps it that way. Four is the floor without
 * cross-joining unrelated tables into a cartesian product.
 *
 * @param {SqlFn} sql
 * @param {string} userId
 * @returns {Promise<{
 *   userId: string, email: string|null, fullName: string|null, location: string|null,
 *   summary: string, claimedSkills: string[], proseText: string,
 *   courses: {course_code: string, title: string|null, skills: string[]}[],
 *   goals: Record<string, unknown>|null, embedText: string
 * }>}
 */
export async function loadProfile(sql, userId) {
  const p = { name: 'user_id', value: userId };

  const [head, skills, courses, goals, education] = await Promise.all([
    sql(
      `SELECT p.full_name, p.location, p.headline, p.summary, p.years_experience, u.email
         FROM ${FQ}.users u
         LEFT JOIN ${FQ}.profiles p ON p.user_id = u.user_id
        WHERE u.user_id = :user_id`,
      [p],
    ),
    sql(
      `SELECT CONCAT_WS('\u001f', COLLECT_LIST(skill))     AS claimed,
              CONCAT_WS('\u001f', COLLECT_LIST(raw_skill)) AS raw
         FROM ${FQ}.profile_skills WHERE user_id = :user_id`,
      [p],
    ),
    sql(
      `SELECT course_code, title, skills FROM ${FQ}.courses
        WHERE user_id = :user_id ORDER BY course_code`,
      [p],
    ),
    sql(
      `SELECT target_roles, locations, sponsorship_required, comp_floor, start_date,
              employment_type, work_location_pref, work_authorization, graduation_date,
              clearance, industries_avoid, company_size
         FROM ${FQ}.goals WHERE user_id = :user_id
        ORDER BY updated_at DESC LIMIT 1`,
      [p],
    ),
    // Degrees only. A PhD-only internship is entry-level on every experience signal
    // and still unreachable for a bachelor's student, so the matcher needs to know
    // which degrees the student actually holds or is enrolled in. One more parallel
    // read, so it costs no extra wall-clock on a warehouse that is already awake.
    sql(
      `SELECT CONCAT_WS('\u001f', COLLECT_LIST(degree)) AS degrees
         FROM ${FQ}.profile_education WHERE user_id = :user_id`,
      [p],
    ),
  ]);

  const h = rowObjects(head)[0] ?? {};
  if (!h.email && head.rows.length === 0) {
    throw new Error(`no users row for user_id ${userId}`);
  }

  // \u001f (ASCII unit separator) as the join character, not a comma: a skill
  // legitimately contains commas ("CSS3(Grid/Flexbox)", "C++, C#") and splitting
  // a comma-joined list would shred them into fragments that match nothing.
  const claimedSkills = [
    ...new Set(
      [...String(skills.rows[0]?.[0] ?? '').split('\u001f'), ...String(skills.rows[0]?.[1] ?? '').split('\u001f')]
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];

  // The PROSE side of the three-way classification: everything the student has
  // written that is evidence rather than a claim. Assembled from profile_memory
  // through profile_current, because the structured child tables and the memory
  // hold the same facts and the memory is the one guaranteed to be populated for
  // any account that ever ran intake.
  const prose = await sql(
    `SELECT CONCAT_WS('\n', COLLECT_LIST(fact_value)) AS prose
       FROM ${FQ}.profile_current
      WHERE user_id = :user_id
        AND fact_value IS NOT NULL
        AND (fact_key LIKE 'experience.%' OR fact_key LIKE 'project%'
             OR fact_key LIKE 'skill%' OR fact_key IN ('summary', 'headline'))`,
    [p],
  );

  const summary = String(h.summary ?? '').trim();
  const proseText = [summary, String(h.headline ?? ''), String(prose.rows[0]?.[0] ?? '')]
    .filter(Boolean)
    .join('\n');

  const g = rowObjects(goals)[0] ?? null;
  const normalizedGoals = g
    ? {
        ...g,
        target_roles: parseArray(g.target_roles),
        locations: parseArray(g.locations),
        industries_avoid: parseArray(g.industries_avoid),
      }
    : null;

  return {
    userId,
    email: h.email ?? null,
    fullName: h.full_name ?? null,
    location: h.location ?? null,
    // WAS SELECTED AND DROPPED. `years_experience` has been in the query above since
    // this file was written and never reached the returned object, so nothing
    // downstream — not the stage-1 blend, not the reranker prompt — knew whether it
    // was scoring for a sophomore or a VP. That is why a graduating senior's top ten
    // was mostly Senior/Staff/Manager roles. Number() rather than a bare pass-through
    // because the warehouse returns this column as a string over the SQL API.
    yearsExperience: Number.isFinite(Number(h.years_experience))
      ? Number(h.years_experience)
      : null,
    // Same unit-separator idiom as claimedSkills above, for the same reason: a degree
    // string legitimately contains commas ("Bachelor of Science, Computer Science").
    highestDegree: highestDegreeOf(
      String(education.rows[0]?.[0] ?? '')
        .split('\u001f')
        .map((d) => d.trim())
        .filter(Boolean),
    ),
    summary,
    claimedSkills,
    proseText,
    courses: rowObjects(courses).map((c) => ({
      course_code: c.course_code,
      title: c.title ?? null,
      skills: parseArray(c.skills),
    })),
    goals: normalizedGoals,
    embedText: buildEmbedText({
      summary,
      headline: h.headline ?? null,
      location: h.location ?? null,
      claimedSkills,
      targetRoles: normalizedGoals?.target_roles ?? [],
    }),
  };
}

/**
 * The text whose embedding is compared against every job embedding.
 *
 * Skills and target roles are included, not just the summary. The summary alone
 * is 279 characters for the richest real profile in the workspace and reads as
 * career narrative ("5+ years building systems at scale"), which embeds close to
 * every engineering-manager posting and far from the specific stacks the student
 * actually knows. Adding the skill list and the target titles is what moves the
 * nearest neighbours from "sounds like this person" to "asks for what this person
 * can do".
 *
 * Both sides of the comparison are then symmetric by construction: job
 * embeddings are built from title + company + location + description
 * (scripts/embed-jobs.mjs), and this is title-ish + location + skills +
 * narrative.
 *
 * @returns {string}
 */
export function buildEmbedText({ summary, headline, location, claimedSkills, targetRoles }) {
  const parts = [];
  if (targetRoles?.length) parts.push(`Target roles: ${targetRoles.join(', ')}`);
  if (headline) parts.push(String(headline));
  if (location) parts.push(`Location: ${location}`);
  if (summary) parts.push(String(summary));
  if (claimedSkills?.length) parts.push(`Skills: ${claimedSkills.join(', ')}`);
  return parts.join('\n');
}

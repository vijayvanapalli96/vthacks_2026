/**
 * retrieve.mjs — STAGE 1. Hard filters, then ranking. ZERO LLM SCORING CALLS.
 *
 * This stage is the entire reason the design is affordable. 16,207 postings times
 * one model call each is absurd on both cost and time; filtering by rules to a few
 * hundred and ranking by embedding to ~20 means stage 2 spends 20 calls instead of
 * 16,207. career-ops caps its own re-ranker at 20 by default for exactly this
 * reason (`rank-pipeline.mjs`: "the whole reason the core scan is zero-token is
 * that people run it daily").
 *
 * EXACTLY ONE model call happens in this stage, and it is an EMBEDDING, not a
 * score: `ai_query('databricks-gte-large-en', <the student's profile text>)`. Its
 * cost is O(1) in the corpus size — one call whether there are 300 postings or
 * 300,000 — and the plan requires it ("cosine similarity between the job
 * embedding and an embedding of the user's profile summary"). Zero LLM scoring
 * calls, which is the property that matters.
 *
 * THE TWO NARROWINGS:
 *   1. SQL hard filters + cosine  -> RETRIEVAL_POOL (200) rows, on the warehouse
 *   2. eligibility gate + blend   -> RERANK_LIMIT (20) rows, in this process
 *
 * The eligibility gate runs in JavaScript rather than SQL because every `fail`
 * has to carry a REASON, and assembling "Posting requires TS/SCI clearance;
 * profile records no clearance" out of CASE expressions produces either a
 * uselessly generic string or an unmaintainable one. See eligibility.mjs.
 *
 * SQL INJECTION: `description_text` and `job_title` come from the open internet.
 * They are never interpolated. Everything variable in these statements is a named
 * bound parameter, including the integers — the `avoid_N` parameters are
 * generated in a loop, so the STRUCTURE of the WHERE clause varies, but not one
 * character of untrusted VALUE ever enters the statement text.
 */
import { classifySkillGaps, extractJdSkills, matchCourses, requirementsFor } from './jd-skills.mjs';
import { evaluateEligibility, FAIL } from './eligibility.mjs';
import { cosineSql } from './cosine.mjs';
// SUB_BASELINE_SENIORITY is deliberately NOT imported. It exists in
// title-match.mjs because career-ops' role-matcher needs it to tell two
// requisitions apart, and because a later pass may want to boost intern/new-grad
// roles for a student. Importing it here to "use it" would mean scoring seniority,
// and seniority is reported for the UI rather than scored — see the blend note
// below for why.
import { seniorityTokens, titleHits } from './title-match.mjs';

const FQ = 'workspace.vthacks_2026';
const EMBEDDING_MODEL = 'databricks-gte-large-en';

/**
 * How many rows the cosine cut keeps before the eligibility gate runs.
 *
 * Bigger than RERANK_LIMIT on purpose, and by a wide margin. The gate is applied
 * AFTER the cut, so a pool of 20 would return 6 matches to a student who needs
 * visa sponsorship — the depletion is worst exactly for the students the gate
 * exists to protect. 200 is career-ops' own `LIMIT_CEILING` and survives a pool
 * that is 90% ineligible.
 */
export const RETRIEVAL_POOL = 200;

/**
 * How many rows reach stage 2 — i.e. HOW MANY MODEL CALLS A RUN COSTS.
 *
 * 20, matching career-ops' `DEFAULT_LIMIT`. This is the cost constant of the
 * whole agent: one run is exactly this many `databricks-llama-4-maverick` calls,
 * plus one embedding. Raising it raises the bill linearly, which is why it is a
 * named constant with this comment rather than a literal in a query.
 */
export const RERANK_LIMIT = 20;

/**
 * Freshness window, in days. 3 matches the `open_us_jobs` view, which is the
 * denominator the pitch is allowed to claim (~358 fresh US roles from 74 boards
 * as of 2026-09-19 — NOT "all US jobs"; see CLAUDE.md hard rule 8).
 */
export const DEFAULT_FRESHNESS_DAYS = 3;

/** Weights for the stage-1 blend. See rankCandidates() for why these and not others. */
const W_SIMILARITY = 0.6;
const W_SKILL_COVERAGE = 0.3;
const W_TITLE = 0.1;

/**
 * Turn `goals.employment_type` into a SQL predicate over title and description.
 *
 * Returns null for "no constraint". `goals` is empty in the workspace today (the
 * voice lane owns it), so null is the common case and must mean "do not filter"
 * rather than "match nothing" — a filter that silently empties the result set is
 * the worst of the available failures.
 */
function employmentTypePredicate(employmentType) {
  const v = String(employmentType ?? '').trim().toLowerCase();
  if (!v || v === 'any') return null;
  const internish = `(LOWER(s.job_title) RLIKE '(intern|internship|co-?op|new ?grad|university|student)')`;
  if (/intern|co-?op|student/.test(v)) return internish;
  if (/part/.test(v)) return `(LOWER(s.job_title) RLIKE 'part[- ]time')`;
  if (/contract|freelance|temp/.test(v)) {
    return `(LOWER(s.job_title) RLIKE '(contract|contractor|freelance|temporary)')`;
  }
  if (/full/.test(v)) {
    // Full-time is expressed as "not one of the others". Most postings never say
    // "full time" at all, so a positive match on the phrase would discard the
    // majority of the corpus.
    return `(NOT ${internish} AND NOT (LOWER(s.job_title) RLIKE '(part[- ]time|contractor|freelance|temporary)'))`;
  }
  return null;
}

/** Turn `goals.work_location_pref` into a SQL predicate. Returns null for no constraint. */
function workLocationPredicate(pref) {
  const v = String(pref ?? '').trim().toLowerCase();
  if (!v || v === 'any' || v === 'no preference') return null;
  const remote = `(LOWER(COALESCE(s.location_text, '')) RLIKE 'remote' OR LOWER(COALESCE(s.description_text, '')) RLIKE '(fully remote|remote[- ]first|work from (home|anywhere))')`;
  if (/remote/.test(v)) return remote;
  if (/hybrid/.test(v)) {
    return `(LOWER(COALESCE(s.location_text, '')) RLIKE 'hybrid' OR LOWER(COALESCE(s.description_text, '')) RLIKE 'hybrid')`;
  }
  if (/onsite|on-site|in.?person|office/.test(v)) return `(NOT ${remote})`;
  return null;
}

/**
 * Stage 1a — the warehouse half. One statement.
 *
 * `COUNT(*) OVER ()` rides along so the post-filter total is exact without a
 * second COUNT statement: the window is evaluated over the whole filtered set
 * before LIMIT applies. That saves a round trip on a warehouse billed by the
 * hour, and it makes `match_runs.after_filters` a measurement rather than an
 * estimate.
 *
 * @param {import('./profile.mjs').SqlFn} sql
 * @param {{embedText: string, goals: Record<string, any>|null}} profile
 * @param {{freshnessDays?: number, pool?: number}} [options]
 */
export async function retrieveCandidates(sql, profile, options = {}) {
  const freshnessDays = options.freshnessDays ?? DEFAULT_FRESHNESS_DAYS;
  const pool = options.pool ?? RETRIEVAL_POOL;
  const goals = profile.goals ?? {};

  const params = [
    { name: 'profile_text', value: profile.embedText || 'software engineering student' },
    { name: 'freshness_days', value: String(freshnessDays), type: 'DOUBLE' },
    { name: 'pool', value: String(pool), type: 'INT' },
  ];

  const predicates = [
    's.is_us',
    // make_dt_interval rather than a literal INTERVAL: an INTERVAL literal cannot
    // take a parameter marker, and string-building the number would break the
    // bind-everything rule for no gain.
    's.posted_at >= current_timestamp() - make_dt_interval(:freshness_days, 0, 0, 0)',
    "s.description_text IS NOT NULL AND LENGTH(s.description_text) > 0",
  ];

  const employment = employmentTypePredicate(goals.employment_type);
  if (employment) predicates.push(employment);
  const location = workLocationPredicate(goals.work_location_pref);
  if (location) predicates.push(location);

  // industries_avoid: one bound parameter per entry. The STRUCTURE of the clause
  // is generated; the VALUES are bound. A company name from a scraped posting is
  // matched against a student-supplied string and neither reaches the SQL text.
  const avoid = Array.isArray(goals.industries_avoid) ? goals.industries_avoid : [];
  avoid.forEach((term, i) => {
    if (typeof term !== 'string' || !term.trim()) return;
    const name = `avoid_${i}`;
    params.push({ name, value: term.trim().toLowerCase() });
    predicates.push(
      `NOT (LOWER(s.company_name) LIKE CONCAT('%', :${name}, '%')
            OR LOWER(s.job_title) LIKE CONCAT('%', :${name}, '%'))`,
    );
  });

  const similarity = cosineSql('e.embedding', 'q.v');

  const statement = `
    WITH q AS (
      SELECT CAST(ai_query('${EMBEDDING_MODEL}', :profile_text) AS ARRAY<FLOAT>) AS v
    )
    SELECT s.job_id, s.company_name, s.job_title, s.location_text, s.source,
           s.source_url, CAST(s.posted_at AS STRING) AS posted_at,
           s.description_text,
           ${similarity} AS similarity,
           COUNT(*) OVER () AS after_filters
      FROM ${FQ}.job_embeddings e
      JOIN ${FQ}.job_snapshots s ON s.job_id = e.job_id
      CROSS JOIN q
     WHERE ${predicates.join('\n       AND ')}
     ORDER BY similarity DESC
     LIMIT :pool`;

  const result = await sql(statement, params);
  const index = Object.fromEntries(result.columns.map((c, i) => [c, i]));
  const rows = result.rows.map((row) => ({
    job_id: row[index.job_id],
    company_name: row[index.company_name],
    job_title: row[index.job_title],
    location_text: row[index.location_text],
    source: row[index.source],
    source_url: row[index.source_url],
    posted_at: row[index.posted_at],
    description_text: row[index.description_text] ?? '',
    similarity: Number(row[index.similarity] ?? 0),
  }));

  return {
    rows,
    afterFilters: Number(result.rows[0]?.[index.after_filters] ?? 0),
  };
}

/**
 * Stage 1b — annotate, GATE, and rank. Runs in this process; no network, no model.
 *
 * Every returned row carries the full stage-1 shape the plan specifies:
 * skills_matched, skills_missing, courses_matched, eligibility,
 * eligibility_reason, similarity, retrieval_rank.
 *
 * `skills_matched` is `existing` PLUS `supportedByResume`, because both mean "can
 * do it". `skills_missing` is `gap` ALONE — the middle bucket is evidence the
 * student has the skill and never listed it, and reporting that as missing tells
 * them to learn something their own resume proves they did.
 *
 * @param {{job_id: string, company_name: string, job_title: string, description_text: string, similarity: number}[]} rows
 * @param {Awaited<ReturnType<import('./profile.mjs').loadProfile>>} profile
 * @param {{limit?: number}} [options]
 */
export function rankCandidates(rows, profile, options = {}) {
  const limit = options.limit ?? RERANK_LIMIT;
  const goals = profile.goals ?? {};
  const targetRoles = Array.isArray(goals.target_roles) ? goals.target_roles : [];

  const annotated = [];
  /** @type {{job_id: string, company_name: string, job_title: string, eligibility: string, eligibility_reason: string}[]} */
  const ineligible = [];
  let unknownEligibility = 0;

  for (const row of rows) {
    const jd = String(row.description_text ?? '');
    // requirementsFor, NOT scanJd: on this corpus scanJd alone finds a
    // requirements section in 2 postings out of 60, because the descriptions are
    // flattened HTML with no lines and no bullets. See jd-skills.mjs.
    const scan = requirementsFor(jd);
    const jdSkills = scan.skills;
    const { existing, supportedByResume, gap } = classifySkillGaps(
      jdSkills,
      profile.claimedSkills,
      profile.proseText,
    );
    const { eligibility, reason } = evaluateEligibility({ jdText: jd }, goals);

    const record = {
      job_id: row.job_id,
      company_name: row.company_name,
      job_title: row.job_title,
      location_text: row.location_text ?? null,
      source: row.source ?? null,
      source_url: row.source_url ?? null,
      posted_at: row.posted_at ?? null,
      description_text: jd,
      similarity: row.similarity,
      requirements_found: jdSkills.length,
      saw_requirement_section: scan.sawRequirementSection,
      // Which extraction path produced the requirements. Carried so an empty
      // skills_missing can always be told apart from an unchecked one.
      requirements_source: scan.source,
      skills_matched: [...new Set([...existing, ...supportedByResume])],
      skills_missing: gap,
      skills_claimed: existing,
      skills_evidenced: supportedByResume,
      courses_matched: matchCourses(jdSkills, profile.courses),
      eligibility,
      eligibility_reason: reason,
      title_matched: titleHits(row.job_title, targetRoles).matched,
      seniority: seniorityTokens(row.job_title),
    };

    // THE HARD GATE. Not a penalty, not a low score — the row leaves the result
    // set. It is recorded with its reason, never silently dropped.
    if (eligibility === FAIL) {
      ineligible.push({
        job_id: record.job_id,
        company_name: record.company_name,
        job_title: record.job_title,
        eligibility,
        eligibility_reason: reason,
      });
      continue;
    }
    if (eligibility === 'unknown') unknownEligibility += 1;
    annotated.push(record);
  }

  // THE BLEND. Similarity dominates because it is the only signal that reads the
  // whole posting; skill coverage is next because it is the only one a student
  // can act on; a target-title hit is a light nudge because `target_roles` is
  // aspirational free text and over-weighting it would just re-rank by wording.
  // Deliberately NOT in this blend: eligibility, which is a gate above, and
  // seniority, which is reported for the UI but not scored — "Senior" in a title
  // is not evidence a student should be excluded, and career-ops' own
  // role-matcher notes that the token is routinely added and dropped on the same
  // requisition.
  for (const r of annotated) {
    const requirements = r.skills_matched.length + r.skills_missing.length;
    // No requirements extracted means coverage is UNKNOWN, not zero. Scoring it 0
    // would push every stub posting to the bottom for a reason that is a property
    // of the ATS, not of the job (plan §7.1). 0.5 keeps it mid-pack on similarity.
    r.skill_coverage = requirements === 0 ? 0.5 : r.skills_matched.length / requirements;
    r.retrieval_score =
      W_SIMILARITY * r.similarity +
      W_SKILL_COVERAGE * r.skill_coverage +
      W_TITLE * (r.title_matched.length > 0 ? 1 : 0);
  }

  annotated.sort((a, b) => b.retrieval_score - a.retrieval_score);
  const top = annotated.slice(0, limit);
  top.forEach((r, i) => {
    r.retrieval_rank = i + 1;
  });

  return {
    top,
    eligibleTotal: annotated.length,
    ineligible,
    unknownEligibility,
  };
}

export { extractJdSkills };

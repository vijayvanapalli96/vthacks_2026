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
// levelFit IS imported and IS scored, reversing an earlier decision in this file
// that said seniority should be reported and never scored. That decision was wrong
// in a specific, measurable way: for a graduating senior, eight of the top ten
// results were Senior/Staff/Manager roles needing five to eight years. The old
// reasoning ("'Senior' in a title is not evidence a student should be excluded")
// confused a GATE with a RANKING TERM. Nothing is excluded — see levelFit's header.
import {
  degreeFit,
  levelFit,
  levelFloor,
  requiredDegree,
  seniorityTokens,
  titleHits,
} from './title-match.mjs';

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
 * Freshness window, in days.
 *
 * WAS 3, TO MATCH THE `open_us_jobs` VIEW. That was measured wrong, and it was the
 * single largest cause of bad matches. 3 days is the right window for a corpus that
 * is rescanned hourly; ours was scanned ONCE (the Vultr cron is still
 * unprovisioned), so "posted in the last 3 days" meant "caught in one scrape",
 * which is a property of our infrastructure and not of the job market.
 *
 * Measured on the live corpus, US postings with a description and an embedding:
 *
 *      3 days ->   341 total,  18 intern-titled
 *      7 days ->   924 total,  75 intern-titled
 *     14 days ->  1645 total, 122 intern-titled
 *     30 days ->  3232 total, 163 intern-titled
 *     90 days ->  6789 total, 220 intern-titled
 *
 * At 3 days a student asking for an internship had EIGHTEEN candidates for twenty
 * slots, so every posting was returned regardless of score — seven Astranis
 * hardware roles, an MBA internship and a Workplace Events internship, to a
 * software engineer. The ranker was never the problem; the shelf was empty.
 *
 * 30 is the honest choice rather than the largest: a posting still open a month
 * after it appeared is ordinary, while one from six months ago usually is not, and
 * sending a student to a closed requisition wastes the only thing they cannot get
 * back. Recency still ranks (W_RECENCY) — it just no longer EXCLUDES.
 *
 * `open_us_jobs` keeps its 3-day definition and the pitch's "~358 fresh US roles"
 * claim stays true of that view. This constant is the matcher's reach, which is a
 * different number and is now stated separately.
 */
export const DEFAULT_FRESHNESS_DAYS = 30;

/**
 * Below this many post-filter rows, the window is widened once and the query is
 * re-run. Starvation is not hypothetical — it is the bug above — and it gets worse
 * exactly when a student adds preferences, because each one narrows further.
 *
 * 150 is a little under the 163 intern-titled rows a 30-day window yields, so the
 * common case does NOT escalate and still costs exactly one embedding call. A
 * starved pool costs one more, which is the correct trade: an embedding is O(1) in
 * corpus size and a student seeing eighteen irrelevant jobs is a lost user.
 */
export const MIN_VIABLE_POOL = 150;

/** The one widening step. 90 days triples the 30-day pool (3,232 -> 6,789). */
export const WIDENED_FRESHNESS_DAYS = 90;

/**
 * Weights for the stage-1 blend. See rankCandidates() for why these and not others.
 *
 * Similarity keeps the largest share: it is the only term that reads the whole
 * posting, and measured against the live corpus it is the ONLY term that reliably
 * separates a software posting from a manufacturing one.
 *
 * Skill coverage dropped from 0.30 to 0.15 because it was measured actively
 * harmful — see the MIN_REQUIREMENTS_FOR_COVERAGE note in rankCandidates().
 * Level is new and takes the difference.
 */
const W_SIMILARITY = 0.5;
const W_SKILL_COVERAGE = 0.15;
const W_TITLE = 0.1;
const W_LEVEL = 0.25;

/**
 * How many requirements must be extracted from a posting before its skill coverage
 * counts as a measurement rather than an artefact. Setting this to 1 reproduces the
 * original behaviour exactly (only a zero-requirement posting was "unknown").
 */
const MIN_REQUIREMENTS_FOR_COVERAGE = 3;

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
 * @param {{freshnessDays: number, pool: number}} options
 */
async function runRetrieval(sql, profile, options) {
  const freshnessDays = options.freshnessDays;
  const pool = options.pool;
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
    freshnessDays,
  };
}

/**
 * Stage 1a, with ONE widening retry when the pool is starved.
 *
 * The retry exists because every narrowing the student asks for multiplies: a
 * 3-day window and `employment_type: 'internship'` left EIGHTEEN candidates for
 * twenty slots, so the result set was "every intern posting we happened to
 * scrape" rather than "the best ones". Widening is strictly better than the
 * alternatives considered — dropping the student's stated preference (we would be
 * overriding an explicit answer) or returning eighteen rows and calling them
 * matches (what it did before).
 *
 * It widens AT MOST ONCE, and it keeps the narrower result if widening does not
 * actually find more rows, so a genuinely small corpus never pays for a second
 * embedding twice over.
 *
 * `widenedFrom` is returned so the caller can SAY SO in the UI. A student who
 * asked for fresh postings and is shown a five-week-old one is owed that sentence
 * — silently changing the window would be the dishonest version of this fix.
 *
 * @param {import('./profile.mjs').SqlFn} sql
 * @param {{embedText: string, goals: Record<string, any>|null}} profile
 * @param {{freshnessDays?: number, pool?: number}} [options]
 */
export async function retrieveCandidates(sql, profile, options = {}) {
  const requested = options.freshnessDays ?? DEFAULT_FRESHNESS_DAYS;
  const pool = options.pool ?? RETRIEVAL_POOL;

  const first = await runRetrieval(sql, profile, { freshnessDays: requested, pool });
  if (first.afterFilters >= MIN_VIABLE_POOL) return first;
  // An explicit request for a window at least as wide as the widening is honoured
  // as-is: the caller already asked for everything the retry would add.
  if (requested >= WIDENED_FRESHNESS_DAYS) return first;

  const widened = await runRetrieval(sql, profile, {
    freshnessDays: WIDENED_FRESHNESS_DAYS,
    pool,
  });
  if (widened.afterFilters <= first.afterFilters) return first;
  return { ...widened, widenedFrom: requested };
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
      // Carried onto the row, not just used and discarded, so the UI can say "this
      // one is a reach" instead of silently ranking it lower for reasons the
      // student cannot see.
      //
      // The two factors MULTIPLY because they are independent barriers: a PhD-only
      // internship is entry-level on experience and still out of reach, which is
      // exactly the case that kept surfacing three PhD computer-vision internships
      // to a bachelor's student. Adding them would have let a perfect experience
      // score paper over the degree wall.
      level_fit:
        levelFit(row.job_title, profile.yearsExperience) *
        degreeFit(row.job_title, profile.highestDegree),
      level_floor_years: levelFloor(row.job_title),
      degree_required: requiredDegree(row.job_title),
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
  // whole posting, and on this corpus it is the only one that separates domains.
  // Level fit is second: measured, it is what stops a graduating senior's top ten
  // from being eight roles that need five to eight years. A target-title hit stays
  // a light nudge because `target_roles` is aspirational free text and
  // over-weighting it would just re-rank by wording.
  //
  // Still deliberately NOT in this blend: eligibility, which is a hard gate above,
  // because "requires a clearance you do not have" is a fact rather than a
  // preference and must not be survivable by scoring well elsewhere.
  for (const r of annotated) {
    const requirements = r.skills_matched.length + r.skills_missing.length;
    // No requirements extracted means coverage is UNKNOWN, not zero. Scoring it 0
    // would push every stub posting to the bottom for a reason that is a property
    // of the ATS, not of the job (plan §7.1). 0.5 keeps it mid-pack on similarity.
    //
    // THE THRESHOLD IS THE FIX FOR A MEASURED INVERSION. With `requirements === 0`
    // as the only unknown case, a posting from which ONE generic requirement was
    // extracted and matched scored coverage 1.00, while a real software posting
    // matching eight of twelve scored 0.67. Off-domain postings were being ranked
    // ABOVE in-domain ones by the term meant to measure fit: "Production Quality
    // Intern" and "Network Planning Sales Engineer Intern" both scored 1.00 against
    // a Python/React student. One or two requirements is not evidence, it is an
    // extraction artefact, so it reads as unknown too.
    r.skill_coverage =
      requirements < MIN_REQUIREMENTS_FOR_COVERAGE
        ? 0.5
        : r.skills_matched.length / requirements;
    r.retrieval_score =
      W_SIMILARITY * r.similarity +
      W_SKILL_COVERAGE * r.skill_coverage +
      W_TITLE * (r.title_matched.length > 0 ? 1 : 0) +
      W_LEVEL * r.level_fit;
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

/**
 * analyze.mjs — TIER 1. Five tools, ZERO model calls, zero new dependencies.
 *
 * This is the tier that must work. A grid of five buttons where four are
 * instant and free and one costs a model call is only an honest control panel
 * if the free four actually return something, so everything in here is
 * deterministic: the same posting and the same profile produce the same answer
 * every time, and no part of it can fail because a model endpoint is busy.
 *
 * WHAT IS REUSED RATHER THAN RE-LIFTED. `jd-skills.mjs`, `skill-extract.mjs`
 * and `eligibility.mjs` are ALREADY in `src/lib/match/` — the match agent
 * lifted them on `feat/match-agent` (skill-extract verbatim with attribution,
 * jd-skill-gap's classifier only). Lifting them a second time into
 * `src/lib/artifacts/` would give the repo two copies of a canonical skill
 * vocabulary that will drift, and a drifted vocabulary means the job page and
 * the match list disagree about whether the student knows Kubernetes. So they
 * are imported across directories.
 *
 * NEW LIFTS, both from career-ops and both credited in their own files:
 *   `classify-tier.mjs`    the seniority read
 *   `jd-similarity.mjs`    the text-overlap read
 *
 * HARD RULE 4 IS THE DESIGN CONSTRAINT, not a decoration. Every one of the five
 * tools returns a `reason` string, and the reason is written here — next to the
 * computation that produced it — rather than in the component, because a reason
 * assembled in JSX drifts from the number it explains within a day.
 */

import { requirementsFor, classifySkillGaps, matchCourses, skillMentionedInText } from '../match/jd-skills.mjs';
import { extractSkills } from '../match/skill-extract.mjs';
import { evaluateEligibility } from '../match/eligibility.mjs';
import { tierRead } from './classify-tier.mjs';
import { textOverlapRead } from './jd-similarity.mjs';
import { allBullets, proseOf } from './facts.mjs';

/**
 * How the requirement list was obtained, in a sentence.
 *
 * `requirementsFor` returns its `source` rather than letting the caller infer
 * it, precisely so an empty result can be told apart from an unchecked one.
 * Throwing that away and printing "0 requirements" would be the bug the donor
 * wrote that field to prevent.
 */
const REQUIREMENT_SOURCE_REASON = {
  'requirements-section':
    'read from the posting’s own requirements section, so these are the things it actually asks for',
  'normalized-requirements-section':
    'read from the posting’s requirements section after re-flowing a run-together posting into lines',
  'whole-description-vocabulary':
    'this posting has no requirements section we could find, so these are technologies named anywhere in its text — mentioned, not necessarily required',
};

/** Skill-gap read: matched, missing, and which of your courses covers a gap. */
function skillGapTool(jd, profile) {
  const requirements = requirementsFor(jd.description_text);
  const gaps = classifySkillGaps(requirements.skills, profile.claimedSkills, profile.proseText);
  const courses = matchCourses(requirements.skills, profile.courses);

  const covered = gaps.existing.length + gaps.supportedByResume.length;
  const total = requirements.skills.length;

  let reason;
  if (total === 0) {
    reason =
      'No technology from our vocabulary appears in this posting at all. That is usually a ' +
      'non-technical posting or one whose description never loaded — it is not evidence that you ' +
      `match it. (${jd.description_chars} characters of description text were scanned.)`;
  } else {
    reason =
      `${covered} of ${total} requirements are covered by your profile, ${gaps.gap.length} are not. ` +
      `The requirement list was ${REQUIREMENT_SOURCE_REASON[requirements.source] ?? requirements.source}.` +
      (courses.length
        ? ` ${courses.length} of your courses cover a requirement your work history does not.`
        : '');
  }

  return {
    id: 'skill_gap',
    label: 'Skill gap for this job',
    requirement_count: total,
    requirement_source: requirements.source,
    saw_requirements_section: requirements.sawRequirementSection,
    // `existing` = you listed it. `supportedByResume` = your own bullets prove
    // it. Kept apart because they are different strengths of evidence and a
    // student knows the difference.
    claimed: gaps.existing,
    proven_by_your_bullets: gaps.supportedByResume,
    missing: gaps.gap,
    courses_covering_a_gap: courses,
    reason,
  };
}

/**
 * Resume optimizer — the HONEST version.
 *
 * It reorders and it flags. It does NOT invent experience, and that is not a
 * limitation to apologise for: a "resume optimizer" that writes a bullet you
 * never earned is a machine for failing a reference check. career-ops states
 * the same rule outright — "Keywords get reformulated, never fabricated" — and
 * it is hard rule 8 arriving from a different direction.
 *
 * Two outputs:
 *   1. YOUR OWN bullets, ranked by how many of this posting's requirements each
 *      one actually names. Lead with the top ones.
 *   2. The posting's requirements that appear NOWHERE in your bullets. Not a
 *      suggestion to add them — a warning that a keyword scanner reading your
 *      resume for this job will not find them.
 */
function resumeOptimizerTool(jd, profile, facts) {
  const requirements = requirementsFor(jd.description_text);
  const bullets = allBullets(facts.structured);

  const ranked = bullets
    .map((bullet) => {
      const hits = requirements.skills.filter((skill) => {
        const canon = extractSkills(bullet.text);
        return canon.has(skill) || skillMentionedInText(skill, bullet.text);
      });
      return {
        ...bullet,
        matched_requirements: hits,
        score: hits.length,
        reason: hits.length
          ? `Names ${hits.length} requirement${hits.length === 1 ? '' : 's'} this posting asks for: ${hits.join(', ')}.`
          : 'Names no requirement from this posting. Keep it — it is your history — but it should not lead.',
      };
    })
    // Stable within a score band: original resume order is the student's own
    // editorial judgement and there is no reason to scramble it.
    .sort((a, b) => b.score - a.score);

  // A requirement no bullet mentions. Compared against the BULLETS, not against
  // the claimed skill list, because this tool is about the document a human (or
  // a keyword scanner) reads, and a skills-section chip is not a bullet.
  const bulletText = bullets.map((b) => b.text).join('\n');
  const unmentioned = requirements.skills.filter(
    (skill) => !extractSkills(bulletText).has(skill) && !skillMentionedInText(skill, bulletText),
  );

  const leading = ranked.filter((b) => b.score > 0);
  const reason =
    bullets.length === 0
      ? 'Your profile has no experience bullets yet, so there is nothing to reorder. Run resume intake first.'
      : `${leading.length} of your ${bullets.length} existing bullets name at least one requirement from this posting; ` +
        `lead with the ${Math.min(3, leading.length)} at the top. ` +
        `${unmentioned.length} requirement${unmentioned.length === 1 ? '' : 's'} appear in none of your bullets ` +
        '— that is a keyword gap, not a reason to write a bullet you did not earn.';

  return {
    id: 'resume_optimizer',
    label: 'Resume optimizer',
    bullets: ranked,
    bullets_that_lead: leading.length,
    bullets_total: bullets.length,
    requirements_no_bullet_mentions: unmentioned,
    reason,
    honesty_note:
      'This tool reorders your existing bullets and flags missing keywords. It never writes a ' +
      'bullet for you. If a requirement is missing from your resume because you have not done it, ' +
      'the right fix is a different job or a new project, not a new sentence.',
  };
}

/** Seniority read: is this actually entry level, or "junior" with 5 years required. */
function tierTool(jd) {
  const read = tierRead(jd.job_title ?? '', jd.description_text);
  return {
    id: 'role_tier',
    label: 'Role tier / seniority read',
    tier: read.tier,
    tier_label: read.label,
    years_required: read.years_required,
    title_contradicts_body: read.mismatch,
    reason: read.reason,
  };
}

/** Fit similarity — text overlap, explicitly NOT the match score. */
function similarityTool(jd, facts, cachedMatch) {
  const read = textOverlapRead(jd.description_text, proseOf(facts.structured));
  return {
    id: 'text_similarity',
    label: 'Fit similarity (text overlap)',
    percent: read.percent,
    decision: read.decision,
    // Shown side by side ON PURPOSE. These are two different numbers measuring
    // two different things and a page that shows only one of them invites the
    // reader to assume they are the same number.
    stored_match_score: cachedMatch?.score ?? null,
    stored_cosine_similarity: cachedMatch ? Math.round(cachedMatch.similarity * 1000) / 1000 : null,
    reason:
      read.reason +
      (cachedMatch
        ? ` For contrast, your stored match score for this job is ${cachedMatch.score}% and its embedding` +
          ` cosine similarity is ${(Math.round(cachedMatch.similarity * 1000) / 1000).toFixed(3)}.` +
          ' Those come from a semantic model; this one is word counting.'
        : ' There is no stored match score for this job to compare against.'),
  };
}

/** Eligibility read: sponsorship / clearance / grad date, with its reason string. */
function eligibilityTool(jd, profile) {
  const verdict = evaluateEligibility({ jdText: jd.description_text }, profile.goals ?? {});
  return {
    id: 'eligibility',
    label: 'Eligibility read',
    eligibility: verdict.eligibility,
    // The gate's own reason, unmodified. It is already a sentence and rewriting
    // it here would mean the job page and the match list explain the same
    // verdict two different ways.
    reason:
      verdict.reason +
      (profile.goals
        ? ''
        : ' Note: you have no saved goals row, so work authorization and clearance could not be' +
          ' checked against anything — this is an unchecked result, not a clear one.'),
  };
}

/**
 * Run all of Tier 1.
 *
 * ONE function rather than five endpoints. The five tools share the requirement
 * extraction and the profile load, both of which are the expensive parts, and
 * five endpoints would run them five times over a warehouse that bills by the
 * second. The UI still presents five separate controls; each one scrolls to and
 * expands its own result.
 *
 * @param {{job: object, profile: object, facts: object, cachedMatch: object|null}} input
 */
export function analyze({ job, profile, facts, cachedMatch }) {
  const tools = [
    skillGapTool(job, profile),
    resumeOptimizerTool(job, profile, facts),
    tierTool(job),
    similarityTool(job, facts, cachedMatch),
    eligibilityTool(job, profile),
  ];

  return {
    tier: 1,
    model_calls: 0,
    cost_note: 'Zero model calls. Every number here is computed from text, so it is free and instant.',
    // Stated rather than implied: a caller that gets 5 tools back and an empty
    // description has been told nothing useful, and should say so on screen.
    description_available: job.has_description,
    description_chars: job.description_chars,
    tools,
  };
}

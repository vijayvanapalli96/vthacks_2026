#!/usr/bin/env node
/**
 * match.test.mjs — the match agent's unit suite. Runs with plain node:
 *
 *   node --test tests/match/            (or)   node tests/match/match.test.mjs
 *
 * No test framework, no npm install, no warehouse, no network. Everything under
 * test here is a PURE function, which is why stage 1 was built out of pure
 * functions in the first place.
 *
 * WHAT THIS SUITE IS FOR. Not coverage — the four things below are the things
 * that FAIL SILENTLY, where a bug produces plausible output in the right shape
 * and nobody notices until a student is shown a wrong answer:
 *
 *   1. Skill canonicalisation. "JS" not cancelling "JavaScript" does not throw;
 *      it just puts a skill the student has into `skills_missing`, which is the
 *      column the coursework lever will aggregate into a course recommendation.
 *   2. The three-way classification. Collapsing `supportedByResume` into `gap`
 *      does not throw either; it tells a student to go and learn something their
 *      own resume proves they did.
 *   3. The eligibility gate. A clearance-required role with no clearance must be
 *      `fail` WITH A REASON. If it came back `pass` the pipeline would still run
 *      and still return 20 matches — it would just be recommending roles the
 *      student legally cannot hold.
 *   4. Cosine arithmetic. A sum of products that forgets to normalise still
 *      returns numbers in roughly the right ORDER, so eyeballing the ranking does
 *      not catch it. Identical vectors must be exactly 1, orthogonal exactly 0.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const BASE = '../../app/vthacks-career-app/src/lib/match/';
const { canonicalizeSkill, extractSkillsExtended } = await import(`${BASE}skill-aliases.mjs`);
const { canonicalize: donorCanonicalize } = await import(`${BASE}skill-extract.mjs`);
const { classifySkillGaps, extractJdSkills, matchCourses, scanJd } = await import(
  `${BASE}jd-skills.mjs`
);
const {
  classifyClearance,
  classifyWorkAuthorization,
  evaluateEligibility,
} = await import(`${BASE}eligibility.mjs`);
const { cosine, cosineSql } = await import(`${BASE}cosine.mjs`);
const { seniorityTokens, titleHits } = await import(`${BASE}title-match.mjs`);
const { validateEvaluation } = await import(`${BASE}rerank.mjs`);
const { buildEmbedText } = await import(`${BASE}profile.mjs`);

// ── 1. Skill canonicalisation ───────────────────────────────────────────────

test('canonicalisation: "JS" and "JavaScript" are ONE skill', () => {
  assert.equal(canonicalizeSkill('JS'), 'JavaScript');
  assert.equal(canonicalizeSkill('js'), 'JavaScript');
  assert.equal(canonicalizeSkill('JavaScript'), 'JavaScript');
  assert.equal(canonicalizeSkill('javascript'), 'JavaScript');
  // The point of the alias: both spellings land on the SAME string, so a claimed
  // skill can cancel a JD requirement written the other way.
  assert.equal(canonicalizeSkill('JS'), canonicalizeSkill('JavaScript'));
});

test('canonicalisation: the donor aliases still work through our layer', () => {
  assert.equal(canonicalizeSkill('k8s'), 'Kubernetes');
  assert.equal(canonicalizeSkill('golang'), 'Go');
  assert.equal(canonicalizeSkill('postgres'), 'PostgreSQL');
  assert.equal(canonicalizeSkill('graphql'), 'GraphQL');
  assert.equal(canonicalizeSkill('nodejs'), 'Node.js');
  // Never title-case: "Graphql" is a key that misses the claimed-skills set, and
  // manufacturing it is the exact drift the shared vocabulary exists to prevent.
  assert.notEqual(canonicalizeSkill('graphql'), 'Graphql');
});

test('canonicalisation: an unknown token passes through UNCHANGED', () => {
  // No umbrella aliasing. "cloud" must never count as knowing AWS, because a
  // generous map silently suppresses real gaps.
  assert.equal(canonicalizeSkill('cloud'), 'cloud');
  assert.equal(canonicalizeSkill('Stakeholder'), 'Stakeholder');
  assert.notEqual(canonicalizeSkill('cloud'), 'AWS');
});

test('canonicalisation: "TS" is deliberately NOT TypeScript', () => {
  // TS/SCI is a clearance level and this corpus has cleared postings. Aliasing
  // "TS" would read "Top Secret clearance required" as "knows TypeScript".
  assert.equal(canonicalizeSkill('TS'), 'TS');
  // Spelled out, it is recognised — so the skill is never actually lost.
  assert.equal(canonicalizeSkill('TypeScript'), 'TypeScript');
  assert.equal(canonicalizeSkill('typescript'), 'TypeScript');
});

test('canonicalisation: our layer only ADDS to the donor vocabulary', () => {
  // The donor does not know "JS"; we do. Everything the donor does know must be
  // unchanged, or the verbatim copy has stopped being the source of truth.
  assert.equal(donorCanonicalize('JS'), 'JS');
  for (const token of ['k8s', 'graphql', 'pytorch', 'PMP', 'ITIL', 'cloud']) {
    assert.equal(canonicalizeSkill(token), donorCanonicalize(token), token);
  }
});

test('extraction: multi-word aliases are found in prose', () => {
  const found = extractSkillsExtended(
    'Built retrieval augmented generation pipelines on Amazon Web Services with JS and Node.',
  );
  assert.ok(found.has('RAG'), [...found].join(','));
  assert.ok(found.has('AWS'));
  assert.ok(found.has('JavaScript'));
  assert.ok(found.has('Node.js'));
});

test('extraction: "Java" does not match inside "JavaScript"', () => {
  const found = extractSkillsExtended('Strong JavaScript experience required.');
  assert.ok(found.has('JavaScript'));
  assert.ok(!found.has('Java'));
});

// ── 2. The three-way classification ─────────────────────────────────────────

const JD = [
  '## About the role',
  'We are building the next generation of developer tooling.',
  '',
  '## Requirements',
  '- 3+ years of experience with Python and Django',
  '- Strong JS skills',
  '- Experience with Kubernetes and Terraform',
  '- Familiarity with Snowflake',
  '',
  '## Benefits',
  '- 401k and Equity',
  '- Unlimited Carrot',
].join('\n');

test('extraction: only the requirements block is scanned', () => {
  const skills = extractJdSkills(JD);
  assert.ok(skills.includes('Python'), skills.join(','));
  assert.ok(skills.includes('Kubernetes'));
  // The benefits list must not become required skills — the failure the
  // non-requirement header patterns exist to stop.
  assert.ok(!skills.includes('Equity'), skills.join(','));
  assert.ok(!skills.includes('Carrot'), skills.join(','));
});

test('extraction: sawRequirementSection separates "nothing found" from "nothing checked"', () => {
  assert.equal(scanJd(JD).sawRequirementSection, true);
  // A posting with no requirements heading: zero skills, but for a completely
  // different reason, and an empty skills_missing must not read as "no gaps".
  const bare = scanJd('We are hiring an engineer. Apply on our site.');
  assert.equal(bare.sawRequirementSection, false);
  assert.equal(bare.skills.length, 0);
});

test('classification: three buckets, and the middle one is not a gap', () => {
  const claimed = ['JavaScript', 'Python'];
  const prose = 'Ran a Kubernetes cluster for the ingestion service and wrote the Django admin.';
  const { existing, supportedByResume, gap } = classifySkillGaps(
    extractJdSkills(JD),
    claimed,
    prose,
  );

  // Claimed outright.
  assert.ok(existing.includes('Python'), `existing=${existing.join(',')}`);
  // Claimed as "JavaScript", asked for as "JS" — the canonicalisation case, end
  // to end. Without the alias this lands in `gap`.
  assert.ok(existing.includes('JS'), `existing=${existing.join(',')}`);
  // NOT claimed, but the prose evidences it. This is the bucket whose whole
  // purpose is to not be a gap.
  assert.ok(supportedByResume.includes('Kubernetes'), `supported=${supportedByResume.join(',')}`);
  assert.ok(supportedByResume.includes('Django'), `supported=${supportedByResume.join(',')}`);
  // Genuinely absent.
  assert.ok(gap.includes('Terraform'), `gap=${gap.join(',')}`);
  assert.ok(gap.includes('Snowflake'), `gap=${gap.join(',')}`);

  // The buckets PARTITION the input: no token in two buckets, none lost.
  const all = [...existing, ...supportedByResume, ...gap];
  assert.equal(all.length, new Set(all).size, 'a token appeared in two buckets');
  assert.equal(all.length, extractJdSkills(JD).length, 'a token was lost');
});

test('classification: a claimed skill NEVER comes back as a gap', () => {
  // The donor's own acceptance test, kept: a skill on the profile that is reported
  // missing tells the student to learn something they already have.
  const jdSkills = ['Kubernetes', 'JavaScript', 'PostgreSQL', 'GraphQL'];
  const { gap } = classifySkillGaps(jdSkills, ['k8s', 'JS', 'postgres', 'GraphQL'], '');
  assert.deepEqual(gap, []);
});

test('classification: a phrase-shaped profile skill still cancels', () => {
  // profile_skills really contains values like this (Nidhi's row, live).
  const { existing, gap } = classifySkillGaps(
    ['JavaScript', 'CSS3'],
    ['JavaScript(ES6+)', 'CSS3(Grid/Flexbox)'],
    '',
  );
  assert.ok(existing.includes('JavaScript'), `existing=${existing.join(',')}`);
  assert.ok(!gap.includes('JavaScript'), `gap=${gap.join(',')}`);
});

test('courses: a course covering a requirement is reported with WHICH course', () => {
  const matched = matchCourses(['Kubernetes', 'Terraform', 'Snowflake'], [
    { course_code: 'CS 3214', title: 'Computer Systems', skills: ['C', 'Kubernetes', 'Linux'] },
    { course_code: 'CS 2104', title: 'Discrete Math', skills: ['Proofs'] },
  ]);
  assert.equal(matched.length, 1);
  assert.match(matched[0], /^CS 3214 — Computer Systems \(Kubernetes\)$/);
});

// ── 3. The eligibility gate ─────────────────────────────────────────────────

const CLEARED_JD = [
  'Senior Systems Engineer supporting a federal customer.',
  '',
  '## Requirements',
  '- Must hold an active TS/SCI clearance with polygraph',
  '- 5+ years of Linux administration',
].join('\n');

test('GATE: clearance required + no clearance = FAIL, with a reason', () => {
  const v = evaluateEligibility({ jdText: CLEARED_JD }, { clearance: 'none' });
  assert.equal(v.eligibility, 'fail');
  // A fail with no reason is a bug. This is the assertion that says so.
  assert.ok(v.reason.length > 20, `reason too thin: ${v.reason}`);
  assert.match(v.reason, /TS\/SCI/);
  assert.match(v.reason, /no clearance/i);
});

test('GATE: clearance required + holds one = pass, and says what it checked', () => {
  const v = evaluateEligibility({ jdText: CLEARED_JD }, { clearance: 'active Secret' });
  assert.equal(v.eligibility, 'pass');
  assert.match(v.reason, /clearance/i);
});

test('GATE: clearance required + status unknown = unknown, NOT dropped', () => {
  // Dropping on unknown would hide most of the corpus from every student who has
  // not yet answered the voice agent's question. `goals` is legitimately empty.
  const v = evaluateEligibility({ jdText: CLEARED_JD }, {});
  assert.equal(v.eligibility, 'unknown');
  assert.match(v.reason, /does not state a clearance status/i);
});

test('GATE: "no clearance required" must not read as a clearance requirement', () => {
  const jd = '## Requirements\n- No security clearance required\n- Python';
  assert.equal(evaluateEligibility({ jdText: jd }, { clearance: 'none' }).eligibility, 'pass');
});

test('GATE: refuses sponsorship + student needs it = FAIL, with a reason', () => {
  const jd = 'We are unable to provide visa sponsorship for this role.';
  const v = evaluateEligibility({ jdText: jd }, { work_authorization: 'F-1 OPT, needs H1B later' });
  assert.equal(v.eligibility, 'fail');
  assert.match(v.reason, /sponsor/i);
  assert.match(v.reason, /OPT/);
});

test('GATE: OFFERS sponsorship is not a refusal', () => {
  // The polarity trap: both sentences contain "sponsor".
  const jd = 'We are happy to sponsor visas for exceptional candidates.';
  const v = evaluateEligibility({ jdText: jd }, { work_authorization: 'F-1 OPT' });
  assert.equal(v.eligibility, 'pass');
});

test('GATE: "must be a US citizen" + non-citizen = FAIL', () => {
  const jd = 'Due to federal contract requirements, applicants must be a U.S. citizen.';
  const v = evaluateEligibility({ jdText: jd }, { work_authorization: 'green card holder' });
  assert.equal(v.eligibility, 'fail');
  assert.match(v.reason, /citizenship/i);
});

test('GATE: an ordinary posting passes, and still carries a reason', () => {
  const jd = '## Requirements\n- 2 years of Python\n- Remote, US';
  const v = evaluateEligibility({ jdText: jd }, { work_authorization: 'US citizen', clearance: 'none' });
  assert.equal(v.eligibility, 'pass');
  // An empty reason next to a `pass` reads as "not checked".
  assert.ok(v.reason.length > 20, v.reason);
});

test('GATE: work authorization free text classifies without an agreed enum', () => {
  assert.deepEqual(pick(classifyWorkAuthorization('US Citizen')), { needsSponsorship: false, isCitizen: true });
  assert.deepEqual(pick(classifyWorkAuthorization('Green Card holder')), { needsSponsorship: false, isCitizen: false });
  assert.deepEqual(pick(classifyWorkAuthorization('F-1 student, will need H1B')), { needsSponsorship: true, isCitizen: false });
  assert.deepEqual(pick(classifyWorkAuthorization('requires sponsorship')), { needsSponsorship: true, isCitizen: false });
  // Unstated stays UNSTATED. Guessing here is what turns an unknown into a wrong
  // hard filter.
  assert.deepEqual(pick(classifyWorkAuthorization(null)), { needsSponsorship: null, isCitizen: null });
  assert.deepEqual(pick(classifyWorkAuthorization('')), { needsSponsorship: null, isCitizen: null });
  function pick(v) {
    return { needsSponsorship: v.needsSponsorship, isCitizen: v.isCitizen };
  }
});

test('GATE: clearance free text classifies, and "none" is a real answer', () => {
  assert.equal(classifyClearance('none').hasClearance, false);
  assert.equal(classifyClearance('TS/SCI').level, 'TS/SCI');
  assert.equal(classifyClearance('Top Secret').level, 'Top Secret');
  assert.equal(classifyClearance(null).hasClearance, null);
});

// ── 4. Cosine arithmetic ────────────────────────────────────────────────────

test('cosine: identical vectors are exactly 1', () => {
  const v = [1, 2, 3, 4, 5];
  assert.equal(cosine(v, v), 1);
  assert.equal(cosine([0.5, -0.25, 3], [0.5, -0.25, 3]), 1);
});

test('cosine: orthogonal vectors are exactly 0', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(cosine([3, 0, 0, 0], [0, 0, 4, 0]), 0);
});

test('cosine: opposite vectors are -1, and scale does not matter', () => {
  // NOT assert.equal, and the asymmetry with the two tests above is the point.
  // The clamp in cosine() makes an OVERSHOOT exact (1.0000000000000002 -> 1), but
  // [1,2] vs [-1,-2] lands at -0.9999999999999998, which is INSIDE the range: the
  // precision is genuinely lost in the division, not clipped off the end. Rounding
  // it to -1 would mean inventing a digit the arithmetic never produced, so the
  // test carries a tolerance instead. 1e-12 is ~10,000x the 1024-dimension error
  // budget and far tighter than anything that could reorder a ranking.
  assert.ok(Math.abs(cosine([1, 2], [-1, -2]) + 1) < 1e-12);
  // Cosine is scale-invariant. A sum-of-products bug that forgot to normalise
  // would make this 5x larger and still look "ordered correctly".
  assert.equal(cosine([1, 2, 3], [5, 10, 15]), 1);
});

test('cosine: a known non-trivial value', () => {
  // [1,1] vs [1,0] -> 1/sqrt(2)
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-12);
});

test('cosine: a zero vector is 0, not NaN', () => {
  // NaN propagates into an ORDER BY and sorts unpredictably, corrupting a ranking
  // rather than being visible in it.
  assert.equal(cosine([0, 0, 0], [1, 2, 3]), 0);
  assert.ok(!Number.isNaN(cosine([0, 0], [0, 0])));
});

test('cosine: mismatched lengths throw rather than silently truncating', () => {
  assert.throws(() => cosine([1, 2], [1, 2, 3]), TypeError);
  assert.throws(() => cosine([], []), TypeError);
});

test('cosineSql: the generated SQL casts to DOUBLE and guards the denominator', () => {
  const sqlText = cosineSql('e.embedding', 'q.v');
  // ARRAY<FLOAT> summed in single precision reorders near-ties, which is exactly
  // where the top-20 cut is made.
  assert.match(sqlText, /CAST\(x AS DOUBLE\)/);
  // A zero-magnitude embedding must not divide by zero.
  assert.match(sqlText, /NULLIF/);
  assert.match(sqlText, /COALESCE/);
  assert.ok(sqlText.includes('e.embedding') && sqlText.includes('q.v'));
});

// ── Stage 2 validation: the "no reason, no row" rule ────────────────────────

test('rerank: a score with NO reason is dropped, not stored', () => {
  const r = validateEvaluation({ overall_score: 87, recommendation: 'strong', explanation_text: '' });
  assert.equal(r.ok, false);
  assert.match(r.why, /reason/i);
  assert.equal(validateEvaluation({ overall_score: 87 }).ok, false);
  assert.equal(validateEvaluation({ overall_score: 87, explanation_text: 'ok' }).ok, false);
});

test('rerank: a null or boolean score is rejected, not coerced to 0', () => {
  // Number(null) === 0 and Number(false) === 0 — both finite. Checking the
  // coerced value would let a malformed response through as a confident zero.
  const reason = 'A real explanation of the fit, long enough to be useful.';
  assert.equal(validateEvaluation({ overall_score: null, explanation_text: reason }).ok, false);
  assert.equal(validateEvaluation({ overall_score: false, explanation_text: reason }).ok, false);
  assert.equal(validateEvaluation({ overall_score: '', explanation_text: reason }).ok, false);
  assert.equal(validateEvaluation({ overall_score: 0, explanation_text: reason }).ok, true);
});

test('rerank: a per-requirement score with no reason is dropped from the array', () => {
  const r = validateEvaluation({
    overall_score: 70,
    recommendation: 'possible',
    explanation_text: 'Covers most of the stack but has never shipped Terraform.',
    requirement_scores: [
      { requirement: 'Python', score: 90, reason: 'Listed and evidenced.' },
      { requirement: 'Terraform', score: 0 },
      { requirement: 'Kubernetes', score: 50, reason: '' },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.requirement_scores.length, 1);
  assert.equal(r.value.requirement_scores[0].requirement, 'Python');
});

test('rerank: an out-of-range score is clamped and an odd recommendation normalised', () => {
  const r = validateEvaluation({
    overall_score: 140,
    recommendation: 'AMAZING',
    explanation_text: 'Strong overlap on the whole required stack.',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.overall_score, 100);
  assert.equal(r.value.recommendation, 'possible');
});

test('rerank: unparseable output is rejected rather than half-read', () => {
  assert.equal(validateEvaluation('{not json').ok, false);
  assert.equal(validateEvaluation('[1,2,3]').ok, false);
  assert.equal(validateEvaluation(null).ok, false);
});

// ── Title matching and the profile embed text ───────────────────────────────

test('titles: a target role boosts, and short acronyms are word-anchored', () => {
  assert.equal(titleHits('Software Engineer, Backend', ['backend']).hits, 1);
  // "ai" must not match inside "Retail" — the reason 2-3 letter keywords are
  // anchored rather than substring-matched.
  assert.equal(titleHits('Retail Operations Manager', ['ai']).hits, 0);
  assert.equal(titleHits('AI Engineer', ['ai']).hits, 1);
  // AND-group: order and separator do not matter.
  assert.equal(titleHits('Senior Director, Platform Engineering', ['director + engineering']).hits, 1);
  // A malformed target_roles entry must not throw and drop the whole company.
  assert.equal(titleHits(null, [null, 42, '', 'backend']).hits, 0);
});

test('titles: seniority tokens are reported, not scored', () => {
  assert.deepEqual(seniorityTokens('Senior Staff Engineer').sort(), ['senior', 'staff']);
  assert.deepEqual(seniorityTokens('Software Engineering Intern'), ['intern']);
  assert.deepEqual(seniorityTokens('Software Engineer'), []);
});

test('embed text: skills and target roles are in it, not just the summary', () => {
  const text = buildEmbedText({
    summary: 'CS senior at Virginia Tech.',
    headline: 'CS senior',
    location: 'Blacksburg, VA',
    claimedSkills: ['Python', 'React'],
    targetRoles: ['Backend Engineer'],
  });
  assert.match(text, /Backend Engineer/);
  assert.match(text, /Python, React/);
  assert.match(text, /Virginia Tech/);
  // Empty input must not produce a string of stray labels.
  assert.equal(buildEmbedText({ summary: '', headline: null, location: null, claimedSkills: [], targetRoles: [] }), '');
});

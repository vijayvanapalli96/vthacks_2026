/**
 * title-match.mjs — how a target-role keyword matches a job title, and what a
 * seniority token means.
 *
 * LIFTED from career-ops v1.33.0: `title-keywords.mjs` (the matcher, near
 * verbatim) and the seniority/stopword sets from `role-matcher.mjs`.
 *
 *   Copyright (c) 2026 Santiago Fernández de Valderrama
 *   MIT License. https://github.com/santifer/career-ops
 *
 * The two came from different files there and are merged here because in this
 * codebase there is exactly one caller (stage-1 retrieval) and splitting them
 * would create the drift both modules' own headers warn about. What is dropped:
 * the `content_filter` compiler (we match descriptions by embedding, not
 * keywords) and the YAML-shaped `buildTitleFilter` normaliser is kept because
 * `goals.target_roles` is an ARRAY<STRING> that can legitimately contain a NULL.
 *
 * WHY THIS IS A RANKING SIGNAL AND NOT A FILTER, here. career-ops filters a scan
 * by title because it is choosing which boards to fetch. We already have the
 * postings, and a student's `target_roles` is aspirational free text ("SWE",
 * "backend") that would veto most of a corpus it only loosely describes. So a
 * title hit BOOSTS; it never excludes. The things that exclude are in
 * eligibility.mjs, and they exclude on facts rather than on wording.
 */

/** Opt-in whole-word matching for a keyword too long to get it automatically. */
export const WORD_PREFIX = 'word:';

/**
 * `stem:` is the other half of the same question. `word:agent` says "agent and
 * nothing longer" and rejects Agentforce; `stem:agent` says "a word STARTING
 * with agent" and keeps Agentforce and Agentic while dropping Reagents, where
 * the keyword lands mid-word. A bare `agent` keeps all three — so a plain
 * substring is not "the loose option", it is two loosenesses at once.
 */
export const STEM_PREFIX = 'stem:';

function escapeForRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One definition of "inside a word", used by BOTH branches below. \p{L}\p{M}\p{N}
// rather than [a-z0-9_], because an ASCII-only lookaround treats every accented
// letter as a separator, so `word:intern` matched inside an accented "preintern"
// and vetoed exactly the international titles the prefix exists to protect.
//
// String.raw, not a plain template literal: `\p` is not a recognised string
// escape, so an ordinary template drops the backslash and the character class
// degenerates to the literal characters p, {, L, } — no error, and the anchor is
// simply off.
const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;
const anchoredPattern = (body) => new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, 'u');
const stemPattern = (body) => new RegExp(`(?<!${WORD_CHAR})${body}`, 'u');

function compilePrefixedKeyword(kw) {
  if (kw.startsWith(WORD_PREFIX)) {
    const bare = kw.slice(WORD_PREFIX.length).trim();
    // A bare `word:` is a typo. Matching NOTHING is the safe reading: as a
    // positive it contributes no match, while an empty pattern matching
    // everything would boost every row from one stray colon.
    if (!bare) return () => false;
    const re = anchoredPattern(escapeForRegExp(bare));
    return (lower) => re.test(lower);
  }
  if (kw.startsWith(STEM_PREFIX)) {
    const bare = kw.slice(STEM_PREFIX.length).trim();
    if (!bare) return () => false;
    const re = stemPattern(escapeForRegExp(bare));
    return (lower) => re.test(lower);
  }
  return null;
}

/**
 * Compile a lowercased keyword into a matcher.
 *
 * Short all-letter acronyms (2-3 chars: swe, sre, ml, ai) match on WORD
 * BOUNDARIES so "COO" does not match "Coordinator" and "ai" does not match
 * "Retail". Multi-word phrases and keywords containing non-letters (".NET",
 * "C++") keep fast, permissive substring matching.
 *
 * @param {string} kw - already trimmed and lowercased
 * @returns {(lower: string) => boolean}
 */
export function compileKeyword(kw) {
  const prefixed = compilePrefixedKeyword(kw);
  if (prefixed) return prefixed;
  if (/^[a-z]{2,3}$/.test(kw)) {
    // The same boundary as above, not \b: \b is ASCII-only, so "vp" matched
    // inside an accented word while `word:vp` did not.
    const re = anchoredPattern(kw);
    return (lower) => re.test(lower);
  }
  return (lower) => lower.includes(kw);
}

/**
 * An AND-group: " + " (whitespace-delimited) between terms means EVERY term must
 * appear in the title, in any order — "director + engineering" matches
 * "Senior Director, Platform Engineering" and "Director - Software Engineering",
 * which no single literal spelling does.
 *
 * The separator REQUIRES surrounding whitespace on purpose. A bare split('+')
 * would turn the ordinary keyword "C++" into "c", which matches almost every
 * title — trading a silent drop for a silent flood.
 */
export const AND_SEPARATOR = /\s+\+\s+/;

/**
 * @param {string} keyword - already trimmed and lowercased
 * @returns {(lower: string) => boolean}
 */
export function compilePositiveKeyword(keyword) {
  if (!AND_SEPARATOR.test(keyword)) return compileKeyword(keyword);
  const terms = keyword.split(AND_SEPARATOR).map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return compileKeyword(keyword);
  const matchers = terms.map(compileKeyword);
  return (lower) => matchers.every((m) => m(lower));
}

/**
 * How many of a student's `target_roles` a title matches.
 *
 * Returns a COUNT rather than a boolean because it feeds a ranking blend, and 0
 * is a legitimate, non-excluding answer. `String(title ?? '')` rather than
 * `title || ''`: a truthy non-string title from a malformed scrape must not throw
 * and drop the whole company's rows from the pipeline.
 *
 * @param {string} title
 * @param {(string|null|undefined)[]|null|undefined} targetRoles
 * @returns {{hits: number, matched: string[]}}
 */
export function titleHits(title, targetRoles) {
  const lower = String(title ?? '').toLowerCase();
  const matched = [];
  for (const raw of Array.isArray(targetRoles) ? targetRoles : []) {
    if (typeof raw !== 'string') continue;
    const kw = raw.trim().toLowerCase();
    if (!kw) continue;
    if (compilePositiveKeyword(kw)(lower)) matched.push(raw.trim());
  }
  return { hits: matched.length, matched };
}

// ── Seniority, from role-matcher.mjs ────────────────────────────────────────

/**
 * @type {Set<string>}
 *
 * EXTENDED beyond career-ops' original set. The original is missing `manager`,
 * `director`, `vp` and `architect`, which is why "Senior Engineering Manager" and
 * "Staff Software Engineer" were reported as having no seniority at all and ranked
 * freely against a student with no professional experience. career-ops could afford
 * the omission because it matches requisitions for ONE known person; we rank for a
 * student, where "is this level reachable" is the question.
 */
export const SENIORITY_TOKENS = new Set([
  'junior', 'mid', 'middle', 'senior', 'sr', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'internship', 'entry', 'manager', 'director',
  'vp', 'architect', 'distinguished', 'fellow', 'president',
]);

/**
 * Seniority tokens that place a role BELOW the bare baseline title.
 * "senior"/"principal" modify an ambiguous baseline; these words mean the role
 * sits at a LOWER level than the unqualified title, with its own scope and comp
 * band. For a student that is a feature, not a demotion — which is why this set
 * is used to BOOST rather than penalise when the profile has little experience.
 * @type {Set<string>}
 */
export const SUB_BASELINE_SENIORITY = new Set(['associate', 'junior', 'entry', 'intern']);

/**
 * The seniority tokens present in a title.
 * @param {string} title
 * @returns {string[]}
 */
export function seniorityTokens(title) {
  const words = String(title ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return [...new Set(words.filter((w) => SENIORITY_TOKENS.has(w)))];
}

/**
 * Roughly how many years of professional experience a title's LEVEL implies.
 *
 * These are floors, not requirements, and they are read off the title rather than
 * the posting body on purpose: the body's "5+ years" is frequently absent,
 * frequently aspirational, and sits past the 4,000-character truncation in 71% of
 * our stored descriptions. The title is the one part we always have in full.
 *
 * Ordered by how strongly the word pins a level, because a title can carry several
 * ("Senior Engineering Manager" is a manager first) and the HIGHEST floor wins.
 * @type {[RegExp, number][]}
 */
const LEVEL_FLOORS = [
  [/\b(chief|c[te]o|cto|cio|president|vp|vice\s+president|svp|evp)\b/, 15],
  [/\b(distinguished|fellow)\b/, 15],
  [/\b(director|dir)\b/, 12],
  [/\b(principal|architect)\b/, 10],
  [/\b(manager|mgr|head\s+of|head)\b/, 8],
  [/\b(staff)\b/, 7],
  [/\b(lead|tech\s+lead)\b/, 6],
  [/\b(senior|sr\.?)\b/, 5],
  [/\b(iii|3)\b/, 4],
  [/\b(mid|middle|ii|2)\b/, 2],
  // Sub-baseline LAST: "Senior Associate" is senior, and an early-career token must
  // not pull the floor down out from under a word that already raised it.
  [/\b(intern|internship|co-?op|new\s?grad|new\s+graduate|university\s+grad|entry|junior|jr\.?|apprentice|trainee|student)\b/, 0],
];

/**
 * A title with no level word at all. "Software Engineer" is not entry-level, but it
 * is reachable from a new grad in a way "Staff Software Engineer" is not — one year,
 * so a bare title outranks Senior for a student and is barely penalised for a
 * candidate with real experience.
 */
const BASELINE_FLOOR = 1;

/**
 * Degree ranks, for comparing "what the title asks for" with "what the student has".
 * MBA shares a rank with a master's because it is at that academic level, but it is
 * a DIFFERENT TRACK and degreeFit treats it as such rather than as one step up.
 * @type {Record<string, number>}
 */
const DEGREE_RANK = { highschool: 0, associate: 1, bachelors: 2, masters: 3, mba: 3, phd: 4 };

/** Word-anchored so "ms" does not match inside "systems" and "ba" not inside "database". */
const DEGREE_PATTERNS = [
  ['bachelors', /\b(b\.?s\.?|b\.?a\.?|bachelors?|bachelor's|undergraduate|undergrad)\b/],
  ['masters', /\b(m\.?s\.?|m\.?sc\.?|masters?|master's|m\.?eng\.?)\b/],
  ['mba', /\bm\.?b\.?a\.?\b/],
  ['phd', /\b(ph\.?\s?d\.?|doctoral|doctorate)\b/],
];

/**
 * The LOWEST degree a title will accept, or null if it names none.
 *
 * Lowest, not highest, and that is the whole subtlety. "2027 Summer Intern, BS/MS"
 * accepts a bachelor's student and is a fine result; "2027 Summer Intern, MS/PhD" does
 * not. Reading the highest mentioned degree would reject both, which is how a
 * perfectly reachable Waymo BS/MS internship would have been pushed down.
 *
 * @param {string} title
 * @returns {string|null}
 */
export function requiredDegree(title) {
  const lower = String(title ?? '').toLowerCase();
  const mentioned = DEGREE_PATTERNS.filter(([, re]) => re.test(lower)).map(([name]) => name);
  if (mentioned.length === 0) return null;
  // An MBA line that also says BS/MS is an ordinary posting; an MBA line alone is the
  // business track, which is not a step on the same ladder.
  const academic = mentioned.filter((m) => m !== 'mba');
  if (academic.length === 0) return 'mba';
  return academic.reduce((lo, m) => (DEGREE_RANK[m] < DEGREE_RANK[lo] ? m : lo), academic[0]);
}

/**
 * How reachable a title is given the student's highest degree. 1 = reachable.
 *
 * This is why "2027 Summer Intern, PhD, Machine Learning, Computer Vision" kept
 * appearing for a BS student: it is an INTERNSHIP, so every years-of-experience
 * signal reads it as entry-level and correct. The barrier is the degree, and nothing
 * was reading the degree.
 *
 * @param {string} title
 * @param {string|null|undefined} highestDegree - free text; 'bachelors' if unknown
 * @returns {number} 0..1
 */
export function degreeFit(title, highestDegree) {
  const required = requiredDegree(title);
  if (!required) return 1;
  const have = normalizeDegree(highestDegree);
  if (required === 'mba') return have === 'mba' ? 1 : 0.15;
  const gap = DEGREE_RANK[required] - DEGREE_RANK[have];
  if (gap <= 0) return 1;
  if (gap === 1) return 0.45;
  return 0.1;
}

/**
 * Free-text degree ("Bachelor of Science in Computer Science") to a rank key.
 * Defaults to bachelors, because an unrecognised degree on a student profile is far
 * more likely to be an unusual bachelor's spelling than a doctorate.
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function normalizeDegree(text) {
  const lower = String(text ?? '').toLowerCase();
  if (!lower.trim()) return 'bachelors';
  // `doctor` on its own is included HERE but deliberately not in DEGREE_PATTERNS: this
  // function reads a degree field, where "Doctor of Philosophy" is the ordinary
  // spelling, while a job TITLE containing "Doctor" is usually a clinical vacancy.
  if (/\b(ph\.?\s?d\.?|doctor(al|ate)?|d\.?phil)\b/.test(lower)) return 'phd';
  if (/\bm\.?b\.?a\.?\b/.test(lower)) return 'mba';
  if (/\b(m\.?s\.?|m\.?sc\.?|masters?|master's|m\.?eng\.?)\b/.test(lower)) return 'masters';
  if (/\bassociate\b/.test(lower)) return 'associate';
  if (/\b(high school|diploma|ged)\b/.test(lower)) return 'highschool';
  return 'bachelors';
}

/**
 * The highest degree in a list of free-text degree strings.
 * @param {(string|null|undefined)[]|null|undefined} degrees
 * @returns {string}
 */
export function highestDegreeOf(degrees) {
  const list = (Array.isArray(degrees) ? degrees : []).filter((d) => typeof d === 'string' && d.trim());
  if (list.length === 0) return 'bachelors';
  return list
    .map(normalizeDegree)
    .reduce((hi, d) => (DEGREE_RANK[d] > DEGREE_RANK[hi] ? d : hi), 'highschool');
}

/**
 * @param {string} title
 * @returns {number} implied years-of-experience floor for this title
 */
export function levelFloor(title) {
  const lower = String(title ?? '').toLowerCase();
  let floor = null;
  for (const [re, years] of LEVEL_FLOORS) {
    if (re.test(lower)) {
      floor = floor === null ? years : Math.max(floor, years);
    }
  }
  return floor === null ? BASELINE_FLOOR : floor;
}

/**
 * How well a title's level fits a candidate's experience. 1 = reachable, 0 = not.
 *
 * THIS IS A RANKING SIGNAL, NOT A GATE, and the distinction is deliberate. A
 * student who wants to try for a Senior role is allowed to see one and apply; what
 * they must not get is a page where eight of the top ten need eight years. Gates
 * exclude on facts (eligibility.mjs); this one just stops sorting a student's
 * results by how far out of reach the job is.
 *
 * Over-qualification is penalised far more gently than under-qualification: an
 * internship shown to someone with six years is a mismatch, but a survivable one,
 * whereas a Director role shown to a sophomore is noise.
 *
 * @param {string} title
 * @param {number|null|undefined} yearsExperience - null means "none recorded"
 * @returns {number} 0..1
 */
export function levelFit(title, yearsExperience) {
  const floor = levelFloor(title);
  // null/undefined -> 0. HIREWIRE is a student product and `profiles.years_experience`
  // is empty for every account that has not finished intake; treating unknown as
  // "senior enough for anything" is what produced the reported bug.
  const years = Number.isFinite(Number(yearsExperience)) ? Number(yearsExperience) : 0;

  const gap = floor - years;
  if (gap <= 0) {
    // At or above the floor. Over-qualified only counts against a title that is
    // explicitly early-career, and only mildly.
    const overshoot = years - floor;
    if (floor === 0 && overshoot >= 4) return 0.4;
    return 1;
  }
  if (gap <= 1) return 0.85;
  if (gap <= 2) return 0.7;
  if (gap <= 4) return 0.4;
  if (gap <= 6) return 0.2;
  return 0.05;
}

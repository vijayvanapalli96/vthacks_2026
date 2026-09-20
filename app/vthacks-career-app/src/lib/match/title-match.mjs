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

/** @type {Set<string>} */
export const SENIORITY_TOKENS = new Set([
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'entry',
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

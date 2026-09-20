/**
 * verify-cv-facts.mjs — the PURE CORE lifted from the career-ops donor repo,
 * with its fact source repointed from career-ops' `cv.md` to our
 * `workspace.vthacks_2026.profile_current`.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * Source:  career-ops/verify-cv-facts.mjs  (v1.33.0, 1322 lines)
 * License: MIT — Copyright (c) 2026 Santiago Fernández de Valderrama
 *          <hi@santifer.io> · https://santifer.io
 * career-ops is a DONOR REPO, not a dependency. Copied, never imported across
 * the repo boundary; `../career-ops/` is never edited.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * THIS IS A PARTIAL LIFT, and the triage is worth stating precisely because the
 * PR has to say which files were verbatim and which were not:
 *
 *   VERBATIM (every regex, every constant, every comment): foldDigits,
 *   stripMarkup, normalizeClaim, normalizeFact, looksToolShaped, isLikelyTool,
 *   factClaims, factStatements, attributionTokens, delegatedAuthorshipClaims,
 *   clauseAround, countMatches, metricClaims, countShapedSpans,
 *   diagnoseCoverage, allowedMetricSet, auditClaims, sourceContainsFact, and
 *   all of TOOL_PROSE_WORDS / METRIC_NOUNS / COUNT_CLAIM_RE / NOUN_SYNONYMS /
 *   SIMPLE_CLAIM_PATTERNS / the authorship regexes / the plan-horizon rules.
 *   These are 18 of the donor's 19 pure functions and they are the whole of the
 *   detector. Re-deriving them would produce a verifier that disagrees with the
 *   one career-ops has actually run over hundreds of real documents, and the
 *   comments in here are a bug-report archive — the lazy quantifier in
 *   COUNT_CLAIM_RE, the `|$`-less Skills boundary, the `'d`-is-"had" heuristic
 *   — that we have no way to rebuild.
 *
 *   NOT LIFTED: `readIfExists`, `loadFactConfig`, `resolveInputPath`,
 *   `parseCliArgs`, `usage`, `runCli`, `runSelfTest`, and the module-level
 *   `DATA_ROOT = getCareerOpsRoot()` / `DEFAULT_SOURCES` / `DEFAULT_CONFIG`.
 *   Every one of them is filesystem or argv. Our facts are 95 rows in Delta,
 *   not two markdown files on someone's laptop.
 *
 *   REWRITTEN: `verifyFacts` takes `sourceText` and `config` as ARGUMENTS
 *   instead of reading `cv.md` and `config/cv-facts.json` off disk. Its body
 *   below is the donor's body with exactly the first two IO lines removed and
 *   `|| []` guards added on the three config arrays, which the donor could omit
 *   because `loadFactConfig` guaranteed them. `assertFacts` follows, with the
 *   same throw message.
 *
 * WHY THIS FILE IS THE POINT OF THE WHOLE FEATURE. A cover-letter generator
 * with no verification step is a machine that invents work history and puts it
 * on a real application under a real person's name. Hard rule 8 is "don't
 * overclaim". So: every generated document goes through `verifyFacts` BEFORE it
 * is shown, a `block` verdict lists the failing claims and offers no download,
 * and the verdict is stored next to the text in `artifacts.verification_json`
 * so it can be audited after the fact.
 *
 * The three regexes with mutable `lastIndex` (COUNT_CLAIM_RE,
 * DIRECT_AUTHORSHIP_CLAIM_RE) are reset before every use, exactly as the donor
 * does. Removing a reset makes this module order-dependent and non-reentrant,
 * which in a Next.js route means the second request gets different answers than
 * the first.
 */

// ── Constants — verbatim ─────────────────────────────────────────────────────

const TOOL_PROSE_WORDS = new Set([
  'a', 'an', 'and', 'at', 'built', 'by', 'containerized', 'deployment',
  'deployments', 'delivery', 'diagnosing', 'efficiency', 'feedback', 'for', 'from', 'improve',
  'improving', 'in', 'of', 'on', 'on-time', 'operations', 'production', 'project',
  'recurring', 'resolving', 'submission', 'team', 'the', 'to', 'using', 'with',

  // ── HIREWIRE ADDITION (not in the donor's list) ───────────────────────────
  //
  // Found live, not by reading. The donor's tool capture takes everything after
  // "using" and splits it on `,`/`and`/`with`/`in`, so a real bullet —
  //   "…using AWS, LangChain, RAG, Neo4j, pgvector, and FastAPI, building
  //    real-time streaming, cross-session memory, guardrails, …"
  // — yields the fragment "building real-time streaming". It is three words, it
  // matches TOOL_PHRASE_PATTERN, and it is not tool-shaped, so `isLikelyTool`
  // falls through to the prose-word check. The donor's list has `built` but not
  // `building`, so the fragment was retained as a TOOL CLAIM and blocked a
  // truthful document. That is the direction that gets a fact gate switched off.
  //
  // Present-participle VERBS only, because that is the exact shape the split
  // produces from a bullet written in career-ops' own house style. The donor's
  // comment is explicit that morphological suffixes must NOT be used for this —
  // "real products such as Spring, Unity, and Processing share them" — so
  // `processing`, `spring`, `unity` are deliberately NOT here, and neither is
  // any bare `-ing` rule. Each entry below is a word observed as a prose false
  // positive, which is precisely the criterion the donor states for this list.
  'building', 'implementing', 'designing', 'developing', 'creating',
  'deploying', 'architecting', 'enabling', 'launching', 'leading',
  'raising', 'boosting', 'allowing', 'increasing', 'reducing', 'cutting',
  'saving', 'supporting', 'maintaining', 'automating', 'integrating',
]);
const TOOL_PHRASE_PATTERN = /^(?=.{1,80}$)[\p{L}\p{N}.][\p{L}\p{N}+#./-]*(?:\s+[\p{L}\p{N}.][\p{L}\p{N}+#./-]*){0,2}$/u;
const DELEGATED_PARTY_RE = /\b(?:vendors?|agenc(?:y|ies)|contractors?|consultanc(?:y|ies)|consultants?|external teams?|outsourc(?:ed|ing)|implementation partners?)\b/i;
const DELEGATION_RE = /\b(?:commissioned|coordinated|directed|engaged|hired|managed|oversaw|partnered with|supervised)\b/i;
const DIRECT_AUTHORSHIP_SIGNAL_RE = /\b(?:authored|built|coded|developed|engineered|implemented|programmed|wrote)\b/i;
const THIRD_PARTY_EXECUTION_RE = /\b(?:vendors?|agenc(?:y|ies)|contractors?|consultanc(?:y|ies)|consultants?|external teams?|outsourc(?:ed|ing)|implementation partners?)\b[^.;!?]{0,120}\b(?:which|who|that)\b[^.;!?]{0,120}\b(?:authored|built|coded|developed|engineered|implemented|programmed|wrote)\b/i;
const DIRECT_AUTHORSHIP_CLAIM_RE = /\b(authored|built|coded|developed|engineered|implemented|programmed|wrote)\b\s+(?:the\s+|an?\s+|my\s+|our\s+)?([^.;!?]{1,160})/giu;
const ATTRIBUTION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'authored', 'build', 'built', 'by', 'coded',
  'commissioned', 'coordinated', 'created', 'developed', 'directed', 'engineered',
  'engaged', 'for', 'from', 'hired', 'implemented', 'in', 'managed', 'my', 'of',
  'on', 'our', 'oversaw', 'partnered', 'programmed', 'supervised', 'the', 'through',
  'to', 'vendor', 'vendors', 'with', 'wrote',
]);
const METRIC_NOUNS = [
  'users', 'customers', 'clients', 'employees', 'engineers', 'teams', 'companies',
  'partners', 'organizations', 'organisations', 'brands', 'countries',
  'hours', 'days', 'weeks', 'months', 'years', 'minutes', 'seconds',
  'requests', 'tokens', 'documents', 'workflows', 'pipelines', 'agents',
  'interviews', 'applications', 'offers', 'reports', 'cvs', 'resumes',
  'enrollments', 'enrolments', 'completions', 'courses', 'certifications',
  'certificates', 'sessions', 'responses', 'surveys', 'cohorts',
  'commits', 'contributions', 'repositories', 'repos', 'modules', 'tools',
  'servers', 'guides', 'articles', 'datasets', 'examples', 'deployments',
  'services', 'downloads', 'stars', 'lines', 'projects', 'integrations', 'tests',
  // Headcount outside software. The list above counts users, engineers and
  // repos, so a CV in operations, facilities, healthcare, education or the
  // trades produced NO claim for the one number those CVs actually inflate:
  // how many people were managed. "Managed 45 staff" against a source saying
  // 20 passed the gate silently, which is the exact fabrication class this
  // script exists to catch.
  'staff', 'personnel', 'people', 'technicians', 'operators', 'contractors',
  'vendors', 'scientists', 'researchers', 'volunteers', 'students', 'patients',
  'crew',
  // Physical assets and scale, for the same reason.
  'facilities', 'sites', 'buildings', 'rooms', 'labs', 'laboratories', 'plants',
  'machines', 'devices', 'instruments', 'vehicles', 'units', 'locations',
  'acres', 'hectares', 'shifts', 'rounds', 'inspections', 'audits', 'incidents',
  'alarms', 'tickets',
  // Education and training, for the same reason as the headcount block above.
  // 'students' and 'staff' were already here, but the nouns an education or
  // L&D CV actually inflates were not: how many people were put through a
  // program and how many sites it covered. "Trained 900+ candidates across 60
  // schools" against a source saying 250 and 20 passed the gate in silence.
  'candidates', 'trainees', 'learners', 'participants', 'attendees',
  'graduates', 'alumni', 'teachers', 'instructors', 'educators', 'faculty',
  'schools', 'districts', 'campuses', 'classrooms', 'programs', 'programmes',
  'workshops', 'assessments', 'exams',

  // ── HIREWIRE ADDITION (not in the donor's list) ───────────────────────────
  //
  // Found by a test, not by reading. The donor counts `companies`, `clients`,
  // `customers` and `brands` but not `businesses` — and the live profile in this
  // workspace says, verbatim, "adopted by 50,000+ businesses". So the single
  // most inflatable number in this student's resume produced NO claim and the
  // gate passed "adopted by 250,000+ businesses" in silence. That is precisely
  // the failure the donor's own comment above describes for `staff`:
  // "passed the gate silently, which is the exact fabrication class this script
  // exists to catch."
  //
  // Widening is the safe direction, for the reason the MODIFIER_WINDOW comment
  // gives about widening the window: the same regex parses the generated
  // document AND the sources, so a longer noun list can only ever extract MORE
  // claims, on both sides. It cannot hide one.
  //
  // Kept in its own block, below the donor's list and labelled, so the lift
  // stays auditable — a reader can see exactly what is ours.
  'businesses', 'firms', 'startups', 'merchants', 'stores', 'accounts',
  'suppliers', 'buyers', 'sellers', 'subscribers', 'members',
  // The ABBREVIATED time units, folded to their full forms by NOUN_SYNONYMS
  // below. The live profile says "saving 15+ hrs/week"; without `hrs` that
  // number produced no claim, so a letter could have said "45+ hrs/week" and
  // passed. Symmetric by construction — the same regex reads the profile and
  // the document — so the abbreviation and the full word compare equal either
  // way round.
  'hrs', 'yrs', 'mos', 'wks', 'mins', 'secs',
];
// How many words may sit between a number and the noun it counts. The same
// regex parses the generated CV and the sources, so the window is symmetric by
// construction — but a window still decides WHETHER a claim exists, and the CV
// and its source rarely word a fact identically. At {0,2}, "~5 live Cloud Run
// deployments" (three modifiers) yielded no claim while the paraphrase
// "~5 Cloud Run deployments" (two) did, which broke the gate in both
// directions (#2279):
//
//   - a truthful CV failed, because the claim existed on the CV side only;
//   - a CHANGED number passed, because a 3-modifier phrasing on the CV side
//     produced no claim to compare — and catching invented numbers is the
//     entire point of this script.
//
// Four covers the phrasings seen in real CVs ("live Cloud Run deployments",
// "active monthly paying customers"). Widening cannot hide an invented number:
// it only ever extracts MORE claims, on both sides. A number is a hard barrier
// for the chain — modifiers are alphabetic only — so a wider window still
// cannot jump across an intervening figure to bind an unrelated noun.
const MODIFIER_WINDOW = 4;
// The number capture takes an immediately-adjacent magnitude suffix (50k, 1.5M)
// as part of the number, mirroring what the currency pattern below already does.
// Without it the modifier window re-consumed that letter as a generic word, so
// "50k users" normalized to the claim "50 users" and matched a CV that said 50 —
// letting a 1000x inflation through the gate while a smaller "900 users" was
// correctly caught.
//
// `[kKmMbB]\b` requires the suffix to END the token, so "50 million users" (space,
// handled by the modifier window) and "50kg users" (k not at a boundary) both keep
// their existing behaviour and still normalize to "50".
const COUNT_CLAIM_RE = new RegExp(
  // LAZY (`{0,N}?`), so the number binds to the NEAREST noun in the window
  // rather than the farthest. Greedy, the quantifier consumed as many filler
  // words as the window allowed before looking for a noun, and only backtracked
  // if that failed — so whenever two METRIC_NOUNS sat within the window it
  // reported the wrong one (#3414):
  //
  //   "15+ years scaling teams and platforms"        -> 15 platforms, not 15 years
  //   "20+ years leading engineering organizations"  -> 20 organizations, not 20 years
  //
  // The same sentence's plainer paraphrase ("15+ years of experience") produced
  // "15 years", so a truthful line copied verbatim out of cv.md could be flagged
  // as invented: the CV and the source stated the same fact and the extractor
  // read two different claims out of them.
  //
  // Lazy cannot LOSE a claim. Both directions match exactly when some noun sits
  // inside the window; only WHICH one is bound differs, and the nearest is the
  // one a human reads. #2279's wide-window cases are unaffected — "~5 live
  // Cloud Run deployments" still yields "5 deployments", because there is only
  // one noun to bind to.
  String.raw`\b(\d[\d,.]*(?:[kKmMbB]\b)?)\s*\+?\s*(?:[A-Za-z][A-Za-z-]*\s+){0,${MODIFIER_WINDOW}}?(${METRIC_NOUNS.join('|')})\b`,
  'gi'
);
const NOUN_SYNONYMS = new Map([
  ['repos', 'repositories'],
  ['enrolments', 'enrollments'],
  ['organisations', 'organizations'],
  ['cvs', 'resumes'],
  ['certificates', 'certifications'],
  ['articles', 'guides'],
  // A CV and its source rarely word a headcount identically; "20 personnel"
  // restating a source's "20 staff" is a paraphrase, not a fabrication.
  ['personnel', 'staff'],
  ['labs', 'laboratories'],
  // HIREWIRE ADDITION, paired with the abbreviations added to METRIC_NOUNS:
  // "15+ hrs/week" in the profile and "15+ hours a week" in a letter are the
  // same fact, and a gate that reads them as two different claims blocks a
  // truthful sentence.
  ['hrs', 'hours'],
  ['yrs', 'years'],
  ['mos', 'months'],
  ['wks', 'weeks'],
  ['mins', 'minutes'],
  ['secs', 'seconds'],
]);
const SIMPLE_CLAIM_PATTERNS = [
  /\b\d+(?:\.\d+)?\s?%/g,
  /(?<![\w$€£])[$€£]\s?\d[\d,.]*(?:\s?[kKmMbB])?/g,
  /\b\d+(?:\.\d+)?\s?x\b/gi,
];

// ── Digit folding + markup stripping — verbatim ───────────────────────────────

// Unicode decimal-digit blocks, by the code point of their zero. Every claim
// pattern in this file is written with ASCII `\d`, so a CV that spells its
// numbers in any other script produced ZERO claims and the gate reported a
// pass without having checked anything — in ar, hi, ja, zh and zh-TW, all of
// which ship mode sets. NFKC alone is not enough: it folds full-width digits
// (ja/zh) but leaves Arabic-Indic, Persian and Devanagari untouched.
const DIGIT_ZEROS = [
  0x0660, // Arabic-Indic (ar)
  0x06f0, // Extended Arabic-Indic (fa, ur)
  0x0966, // Devanagari (hi)
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0e50, // Thai
  0x0ed0, // Lao
  0x0f20, // Tibetan
  0x1040, // Myanmar
  0x17e0, // Khmer
  0x1810, // Mongolian
];

/**
 * Rewrite every Unicode decimal digit as its ASCII counterpart, plus the
 * separators and percent signs that travel with them, so the claim patterns
 * see the same numbers whatever script wrote them.
 *
 * Applied to the generated document AND to the sources, so it can only ever
 * make MORE claims visible on both sides — it cannot hide one.
 *
 * @param {string} text
 * @returns {string}
 */
export function foldDigits(text) {
  // NFKC first: it maps full-width digits and ％ to ASCII outright.
  let out = text.normalize('NFKC');
  out = out.replace(/\p{Nd}/gu, (char) => {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= 0x30 && cp <= 0x39) return char;
    for (const zero of DIGIT_ZEROS) {
      const value = cp - zero;
      if (value >= 0 && value <= 9) return String(value);
    }
    return char; // a decimal digit from a block we don't list: left as-is
  });
  // Arabic separators and percent sign, which NFKC does not fold either.
  out = out
    .replace(/٪/g, '%')   // ٪ Arabic percent sign
    .replace(/٫/g, '.')   // ٫ Arabic decimal separator
    .replace(/٬/g, ',');  // ٬ Arabic thousands separator
  // A SPACE-grouped thousand ("16 181", common in fr/ru/sv and as NNBSP in
  // typeset text) has to be joined here, before extraction: the claim pattern
  // reads a number as `\d[\d,.]*`, so it would stop at the space and extract
  // "181 users" — a claim the sources never contain, failing a truthful CV.
  // The `(?<!\d)\d{1,3}` guard keeps it to real grouping: in "in 2026 100
  // users" the left part is four digits, so nothing is joined.
  return out.replace(/(?<!\d)(\d{1,3})[\s  ](?=\d{3}(?!\d))/g, '$1');
}

/** Remove HTML, basic LaTeX commands, and excess whitespace from document text. */
export function stripMarkup(text, { keepLineBreaks = false } = {}) {
  return foldDigits(String(text))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    // Only strip things that actually look like tags: `<name …>` or `</name>`.
    // A bare `<` is ordinary prose in these sources (`p<0.001`, `ρ < 0.3`, `<30 min`),
    // and `[^>]` matches newlines — so the old `/<[^>]+>/g` let one stray `<` swallow
    // everything up to the next `>`, deleting real evidence from the allow-list and
    // failing truthful CVs (article-digest.md lost 1,327 chars, incl. two metrics).
    // A BLOCK boundary becomes a sentence break, not a space. Collapsing
    // `</li><li>` to ' ' glues two bullets into one line, and the employer /
    // title captures chain consecutive Capitalised words — so a truthful
    // "…as a Principal Engineer" followed by a bullet starting "Built…" was
    // read as the title "Principal Engineer Built", which no source contains.
    // The markdown sources never had the problem (their newlines break the
    // chain), so the two sides now normalise the same way.
    .replace(/<\/?(?:li|p|div|tr|h[1-6]|section|article|ul|ol|table|br)\b[^>\n]*>/gi, '. ')
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, ' ')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{([^}]*)\})?/g, ' $1 ')
    // Markdown emphasis (`**bold**`, `__bold__`, `*italic*`) — the house style
    // used to bold nearly every metric in cv.md/article-digest.md. A closing
    // marker sitting directly against the number severed the number-noun
    // adjacency the claim patterns require, so a bolded metric quoted verbatim
    // from the source was reported as "invented" (#4085). Requires
    // non-whitespace touching each marker (the standard markdown emphasis
    // rule), so a lone unpaired asterisk — a footnote marker like "40%*", or
    // two of them on one line — is left alone rather than paired into a false
    // span. Single underscores are load-bearing in these sources (snake_case,
    // env_keys.json, file paths), so only a DOUBLED underscore is stripped.
    // Must run AFTER the LaTeX pass above: a LaTeX star-variant command
    // (`\section*{...}`) leaves a single bare `*` behind if consumed first,
    // and that stray star can pair with an unrelated later `*...*` span and
    // mangle both. Bold before italic, so the italic pass never splits a
    // `**...**` run in two. Bold may span a wrapped line (`keepLineBreaks`);
    // italic is deliberately kept single-line, to stay conservative about the
    // more collision-prone single-asterisk form.
    //
    // Deliberately NOT letter/digit-boundary-guarded (e.g. `(?<![\p{L}\p{N}_])`)
    // even though that would preserve literal patterns like `2*3*4` or
    // `foo*bar*baz`: a LaTeX star command directly abutting the next word
    // (`\section*{Foo}and*emphasis*done` -> `Foo and*emphasis*done`) leaves
    // the italic span's markers touching letters on both sides, which such a
    // guard rejects — turning real emphasis back into a false negative. The
    // covered CV/article-digest sources never contain literal multiplication
    // asterisks, so this trades an untested hypothetical for a real,
    // regression-tested case (see the LaTeX star-command test below).
    .replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, ' $1 ')
    .replace(/__(\S(?:[\s\S]*?\S)?)__/g, ' $1 ')
    .replace(/\*(\S(?:[^\n*]*\S)?)\*/g, ' $1 ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    // keepLineBreaks preserves a newline as a CLAUSE boundary for the plan-horizon
    // scan. Horizontal whitespace still collapses, and every claim pattern spans a
    // newline through `\s`, so extraction is unaffected either way.
    .replace(keepLineBreaks ? /[^\S\n]+/g : /\s+/g, ' ')
    .replace(/ *\n+ */g, keepLineBreaks ? '\n' : ' ')
    .trim();
}

// ── Claim normalization — verbatim ───────────────────────────────────────────

/**
 * Normalize a claim for case- and whitespace-insensitive comparison.
 *
 * Thousands separators are removed FIRST, so the same number compares equal
 * however it is grouped: "16,181" / "16 181" / "16181". Without that step the
 * old rule turned "16,181" into "16 181" while an ungrouped source stayed
 * "16181", and the two never matched — a truthful CV failed the gate because
 * of a comma. That bites hardest in the scripts folded above, since Arabic and
 * Devanagari numerals are usually written without a separator at all.
 *
 * Only a separator followed by EXACTLY three digits is removed, so a decimal
 * comma ("1,2 million") and ordinary prose are left alone.
 *
 * The period is in the class for the same reason the comma is, from the other
 * side of the convention: this repo ships mode sets for markets that group
 * with a period, so a JD or a portfolio note written "16.181 users" is a
 * source a CV written "16,181 users" is checked against. Grouping style is not
 * evidence of a different number, and the gate reported one as invented.
 *
 * The three-digit window is what makes this safe to widen: it leaves a genuine
 * decimal alone at every precision a metric noun realistically carries ("2.5
 * hours", "99.95 uptime"). It cannot disambiguate a three-place decimal, where
 * "1.250 million" reads as thousands - an ambiguity the comma branch already
 * carries in the mirror direction, and one no separator rule can resolve
 * without knowing the document's locale. allow_metrics covers the rest.
 */
export function normalizeClaim(claim) {
  return String(claim)
    .toLowerCase()
    .replace(/(\d)[,.\s  ](?=\d{3}(?!\d))/g, '$1')
    .replace(/[,\s]+/g, ' ')
    .trim();
}

/** Normalize a non-metric fact and remove terminal punctuation. */
function normalizeFact(value) {
  return normalizeClaim(value).replace(/[.;:,]+$/g, '').trim();
}

// ── Tool / employer / title fact extraction — verbatim ───────────────────────

/** Whether a raw (unnormalized) tool fragment looks like a real product name: Title Case, or carries a digit/version token (e.g. "n8n", "Python 3.11", "GPT-4"). */
function looksToolShaped(rawValue) {
  const trimmed = String(rawValue).trim();
  if (!trimmed) return false;
  // A digit anywhere marks a version or a name built on one: "n8n", "GPT-4",
  // "Python 3.11".
  if (/\d/.test(trimmed)) return true;
  // Every word capitalised: "React", "Google Cloud", "Node.js". A single
  // lowercase connector inside an otherwise-capitalised phrase never reaches
  // here — TOOL_PHRASE_PATTERN caps a tool fragment at 3 words and the
  // surrounding split on `and`/`with`/`in` already removes connectors.
  return trimmed.split(/\s+/).every(word => /^[\p{Lu}]/u.test(word));
}

/**
 * Keep likely technology names while dropping ordinary prose fragments.
 *
 * A fragment that does not look tool-shaped (see `looksToolShaped`) is kept
 * anyway when it is already an exact substring of the source files: a real
 * lowercase tool name ("kubernetes", "n8n") a user genuinely used and listed
 * in cv.md must still pass, and rejecting it on casing alone would just trade
 * one false-positive class for another.
 *
 * A fragment that is neither tool-shaped nor source-backed is still retained
 * by default, preserving the gate's fail-closed behavior for lowercase names.
 * Only exact words observed as prose false positives are rejected through
 * `TOOL_PROSE_WORDS`; morphological suffixes are deliberately not used
 * because real products such as Spring, Unity, and Processing share them.
 */
function isLikelyTool(value, sourceNormalized) {
  const normalized = normalizeFact(value);
  const words = normalized.split(' ');
  if (!normalized || words.length > 3) return false;
  if (!TOOL_PHRASE_PATTERN.test(value.trim())) return false;
  if (looksToolShaped(value)) return true;
  if (sourceNormalized != null && sourceContainsFact(sourceNormalized, normalized)) return true;
  return !words.some(word => TOOL_PROSE_WORDS.has(word));
}

/**
 * Extract explicitly asserted employer, title, and tool claims from text.
 *
 * `sourceNormalized` (from `normalizeFact(stripMarkup(sourceText))`, as
 * `verifyFacts` already builds it) is optional and used only to let a
 * lowercase-but-genuine tool fragment through `isLikelyTool` when it is
 * already backed by a source file — see that function's doc comment. Callers
 * that omit it (existing direct callers, tests) get the same conservative
 * shape-only behaviour as before: a tool-shaped fragment is extracted, an
 * ordinary lowercase one is not.
 */
export function factClaims(text, sourceNormalized = null) {
  const clean = stripMarkup(text);
  const claims = [];
  const patterns = [
    // The TRIGGER is case-insensitive, the CAPTURE is not. Both patterns used
    // to be plain /g, so only a lowercase trigger matched — and a CV is
    // written in capitalised bullets, so the phrasings that actually occur
    // were invisible:
    //
    //   "- Worked at Initech as a Principal Engineer"  ->  no claim, gate passed
    //   "he worked at Initech as a Principal Engineer" ->  employer + title
    //
    // A fabricated employer or title therefore shipped unflagged in the
    // spelling CVs use, which is the half of this gate that enforces
    // AGENTS.md's "authorship claims are non-negotiable".
    //
    // The `i` flag is NOT applied to the whole regex on purpose: the capture
    // leans on `[A-Z]` to tell a proper noun from ordinary prose, and making
    // that case-insensitive would read "worked at the office as a manager" as
    // an employer claim. Only the trigger words carry an explicit case class.
    ['employer', /\b(?:[Ww]orked [Aa]t|[Jj]oined|[Ee]mployer\s*:\s*|[Cc]ompany\s*:\s*)\s*([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/g],
    // A title may carry a lowercase connector: stopping at it truncated "Head
    // of Data" to "head", which made it indistinguishable from "Head of
    // Engineering" — so an inflated title compared equal to the real one and
    // passed the gate (CodeRabbit review). The connector list is closed and
    // each one must be followed by another Capitalised word, so the capture
    // cannot wander into ordinary prose.
    //
    // #3907 — the first captured token used `[A-Z][\w/-]*`, whose `*` allows
    // a bare single capital letter to satisfy it. Ordinary prose like "...to
    // this role: I do not have..." then read the pronoun "I" as a one-letter
    // job title. The fix requires at least one more character after the
    // leading capital (`+` instead of `*`), which a real title always has —
    // even a 2-letter acronym like "VP" or "PM" still matches — while a bare
    // "I" or "A" no longer can. Only the FIRST token of each alternative is
    // tightened; the subsequent tokens in the `{0,4}` repetition keep `*`
    // because a later short word in a real multi-word title (e.g. the "AI"
    // in "Head of AI") must still be allowed.
    ['title', /\b(?:[Ss]erved [Aa]s|[Ww]orked [Aa]s|[Tt]itle\s*:\s*|[Rr]ole\s*:\s*)\s*(?:an?\s+|the\s+)?([A-Z][\w/-]+(?:\s+(?:of|for|and|the)\s+[A-Z][\w/-]*|\s+[A-Z][\w/-]*){0,4})|\b(?:[Ww]orked [Aa]t|[Jj]oined)\s+[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4}\s+[Aa]s\s+(?:an?\s+|the\s+)?([A-Z][\w/-]+(?:\s+(?:of|for|and|the)\s+[A-Z][\w/-]*|\s+[A-Z][\w/-]*){0,4})/g],
    ['tool', /\b(?:using|built with|worked with|technologies?\s*:\s*|tech stack\s*:\s*)([^.;\n]+?)(?=\s+\bfor\b|[.;\n]|$)/gi],
  ];
  for (const [kind, pattern] of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const rawText = kind === 'tool' ? match[1].trim() : '';
      const rawValues = kind === 'tool'
        ? (/^the\s+/i.test(rawText) ? [] : rawText.split(/,|\band\b|\bwith\b|\bin\b/i))
        : [match[1] || match[2]];
      for (const raw of rawValues) {
        const value = normalizeFact(raw);
        if (value && (kind !== 'tool' || isLikelyTool(raw, sourceNormalized))) claims.push({ kind, value });
      }
    }
  }
  return claims;
}

// ── Statement splitting + delegated authorship — verbatim ────────────────────

/** Split generated/source documents into bounded statements for attribution checks. */
function factStatements(text) {
  const withLineBoundaries = String(text ?? '').replace(/\r?\n+/g, '. ');
  return stripMarkup(withLineBoundaries)
    .split(/(?:[.!?]\s+|[.!?]$)/u)
    .map(statement => statement.trim())
    .filter(Boolean);
}

/** Return conservative content tokens used only to link a rewrite to its source statement. */
function attributionTokens(text) {
  return normalizeFact(text)
    .split(/[^\p{L}\p{N}+#./-]+/u)
    .filter(token => token.length >= 3 && !ATTRIBUTION_STOP_WORDS.has(token));
}

/**
 * Detect a narrow authorship escalation: a source explicitly attributes
 * execution to a third party, while the generated rewrite claims direct
 * implementation and drops that attribution.
 *
 * This deliberately does not guess from generic leadership prose. It requires
 * a delegation verb, a named third-party role, and at least two shared content
 * tokens between the source and generated statements. Ambiguous source
 * statements that also contain a direct implementation verb are left alone;
 * an explicit relative clause such as "vendor X, which built Y" is treated as
 * third-party execution evidence rather than candidate direct-work evidence.
 */
export function delegatedAuthorshipClaims(targetText, sourceText) {
  const sourceStatements = factStatements(sourceText);
  const directSources = sourceStatements
    .filter(statement => DIRECT_AUTHORSHIP_SIGNAL_RE.test(statement))
    .filter(statement => !THIRD_PARTY_EXECUTION_RE.test(statement))
    .map(statement => new Set(attributionTokens(statement)));
  const delegatedSources = sourceStatements
    .filter(statement => DELEGATED_PARTY_RE.test(statement) && DELEGATION_RE.test(statement))
    .filter(statement => (
      !DIRECT_AUTHORSHIP_SIGNAL_RE.test(statement) || THIRD_PARTY_EXECUTION_RE.test(statement)
    ))
    .map(statement => ({
      statement,
      tokens: new Set(attributionTokens(statement)),
    }));
  if (!delegatedSources.length) return [];

  const claims = [];
  for (const statement of factStatements(targetText)) {
    // Keeping the third-party attribution is not an authorship escalation.
    if (DELEGATED_PARTY_RE.test(statement)) continue;
    DIRECT_AUTHORSHIP_CLAIM_RE.lastIndex = 0;
    for (const match of statement.matchAll(DIRECT_AUTHORSHIP_CLAIM_RE)) {
      const value = normalizeFact(`${match[1]} ${match[2]}`);
      const tokens = [...new Set(attributionTokens(match[2]))];
      if (tokens.length < 2) continue;
      // Explicit direct-work evidence wins over a nearby delegated project
      // that happens to use the same technology or artifact vocabulary.
      if (directSources.some(source => tokens.filter(token => source.has(token)).length >= 2)) {
        continue;
      }
      const delegatedSource = delegatedSources.find(source => (
        tokens.filter(token => source.tokens.has(token)).length >= 2
      ));
      if (delegatedSource) {
        claims.push({ kind: 'authorship', value });
      }
    }
  }
  return claims.filter((claim, index, all) => (
    all.findIndex(other => other.value === claim.value) === index
  ));
}

// ── Plan-horizon suppression + metric extraction — verbatim ──────────────────

// A PLAN HORIZON is the window a candidate proposes to work in, and it asserts
// nothing about the past:
//
//   "I'd welcome the chance to talk through how I'd approach the first 90 days"
//
// The time units it uses belong in METRIC_NOUNS -- "cut deployment time to 2
// days" and "saved 20 hours a week" are exactly the claims this gate exists to
// check -- so the stock cover-letter closing above was extracted as the claim
// "90 days" and reported as unsupported. No source can ever evidence a proposal,
// so the only remedy was an allow_metrics entry per phrasing, and every fresh
// wording came back red.
//
// Two signals are required together, and each alone would silence a real claim:
//
//   - a horizon LEAD adjacent to the number ("the first", "my next"). Alone it
//     would swallow "revenue grew in the first 12 months", a past-tense claim.
//   - a FORWARD marker in the same sentence: one of the four modals that frame
//     a proposal (would, will, shall, should), a contracted 'd/'ll, or an
//     explicit intent verb. Ability and possibility modals (can, could, may,
//     might) are deliberately out, since they frame what is possible rather
//     than what is planned. Alone this half would swallow "I would bring 20
//     years of experience", where the number is a real claim inside a
//     hypothetical sentence.
//
// CLAUSE-scoped on purpose. Document-scoped, one conditional courtesy line
// would silence every time-unit claim in the letter; sentence-scoped, a marker in
// a later clause ("...in the first 99 months, and I would be glad to repeat it")
// silences a fabricated PAST number, which is the direction this gate exists to
// prevent. A newline ends a clause, so a soft-wrapped letter cannot join two.
const TIME_NOUNS = new Set(['days', 'weeks', 'months', 'years', 'hours', 'minutes', 'seconds']);
const HORIZON_LEAD_RE = /\b(?:the|my|our|your)?\s*(?:first|next)\s+$/i;
// `'d` is "had" as often as "would", so it only counts when the verb after it is
// not a past participle. The -ed test is a heuristic: an irregular participle
// ("I'd built the first 12 months") still reads as a marker, which is why the
// clause scope below carries the weight rather than this test alone.
const FORWARD_MARKER_RE = /\b(?:would|will|shall|should)\b|['’]d\b(?!\s+[A-Za-z]+ed\b)|['’]ll\b|\b(?:plan|plans|planning|intend|intends)\s+to\b|\bgoing to\b|\blooking forward\b/i;

/**
 * The CLAUSE of `text` containing `index`.
 *
 * Bounded by `. ! ? , ; :` and by a newline, so a marker in a neighbouring
 * clause cannot reach the number: "grew in the first 99 months, and I would be
 * glad to repeat it" keeps its claim, and so does the same pair soft-wrapped
 * across two lines. A separator BETWEEN DIGITS is not a boundary, or the clause
 * around "1.5 years" would end inside the number and lose its own marker.
 *
 * @param {string} text
 * @param {number} index
 * @returns {string}
 */
function clauseAround(text, index) {
  const isBoundary = (i) => {
    const c = text[i];
    if (c === '\n') return true;
    if (c !== '.' && c !== '!' && c !== '?' && c !== ',' && c !== ';' && c !== ':') return false;
    return !(/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? ''));
  };
  const isSentenceEnd = (i) => {
    const c = text[i];
    if (c === '\n') return true;
    if (c !== '.' && c !== '!' && c !== '?') return false;
    return !(/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? ''));
  };
  let start = 0;
  for (let i = index - 1; i >= 0; i--) if (isBoundary(i)) { start = i + 1; break; }
  let end = text.length;
  for (let i = index; i < text.length; i++) if (isBoundary(i)) { end = i; break; }
  // A clause opened by a coordinator continues the one before it, and a plan
  // stated once governs both halves: "I'd approach the first 90 days by
  // listening, and the first 30 days by shipping". The lookback stops at a
  // SENTENCE end, so it can never reach across "…first 99 months. I would…".
  if (/^\s*(?:and|or|then|plus)\b/i.test(text.slice(start, end))) {
    let sentenceStart = 0;
    for (let i = start - 1; i >= 0; i--) if (isSentenceEnd(i)) { sentenceStart = i + 1; break; }
    return text.slice(sentenceStart, end);
  }
  return text.slice(start, end);
}

/**
 * Count-claim matches in `clean`, minus the ones that assert nothing.
 *
 * Shared by metricClaims and diagnoseCoverage so the two cannot disagree about
 * whether a document contained a readable count.
 *
 * @param {string} clean
 * @returns {RegExpMatchArray[]}
 */
function countMatches(clean) {
  COUNT_CLAIM_RE.lastIndex = 0;
  return [...clean.matchAll(COUNT_CLAIM_RE)].filter((match) => {
    if (!TIME_NOUNS.has(match[2].toLowerCase())) return true;
    const lead = clean.slice(Math.max(0, match.index - 40), match.index);
    if (!HORIZON_LEAD_RE.test(lead)) return true;
    return !FORWARD_MARKER_RE.test(clauseAround(clean, match.index));
  });
}

/** Extract metric-like claims that require source evidence. */
export function metricClaims(text) {
  const clean = stripMarkup(text, { keepLineBreaks: true });
  const claims = new Set();
  for (const pattern of SIMPLE_CLAIM_PATTERNS) {
    for (const match of clean.matchAll(pattern)) claims.add(normalizeClaim(match[0]));
  }
  for (const match of countMatches(clean)) {
    const noun = match[2].toLowerCase();
    claims.add(normalizeClaim(`${match[1]} ${NOUN_SYNONYMS.get(noun) ?? noun}`));
  }
  return claims;
}

// ── Coverage diagnosis — verbatim ────────────────────────────────────────────

// A number counting a word, in ANY script — the language-agnostic SHAPE of the
// claims COUNT_CLAIM_RE recognises only when the noun happens to be English.
// Used solely to answer "were there count claims this gate could not read?",
// never to build a claim: it has no lexicon, so it cannot say what was counted.
const GENERIC_COUNT_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(\d[\d,.]*)\s*\+?\s*(?:[\p{L}][\p{L}\p{M}-]*[\s]+){0,${MODIFIER_WINDOW}}([\p{L}][\p{L}\p{M}]{2,})`,
  'giu',
);
// A year is not a count. "Led the 2024 migration" is the shape above and none
// of its meaning, and every CV has several.
const YEAR_LIKE = /^(?:19|20)\d{2}$/;

/**
 * Count-shaped spans in `text`, whatever language it is written in.
 *
 * @param {string} text
 * @returns {string[]}
 */
function countShapedSpans(text) {
  const clean = stripMarkup(String(text ?? ''));

  // Ranges the language-neutral patterns already own. "$120k and closed a
  // $90,000 deal" is currency followed by prose, and reads as two counts to a
  // detector that only knows "digits, then a word" — but those amounts ARE
  // checked, in every language, so reporting them as unread is a false alarm.
  // Derived from SIMPLE_CLAIM_PATTERNS rather than re-guessed, so the two
  // cannot drift.
  const covered = [];
  for (const pattern of SIMPLE_CLAIM_PATTERNS) {
    for (const m of clean.matchAll(pattern)) covered.push([m.index, m.index + m[0].length]);
  }
  const alreadyChecked = (i) => covered.some(([from, to]) => i >= from && i < to);

  const out = [];
  for (const m of clean.matchAll(GENERIC_COUNT_RE)) {
    if (YEAR_LIKE.test(m[1].replace(/[,.]/g, ''))) continue;
    // The digits are what a simple pattern would have claimed, so test their
    // position, not the span's — the span starts at the number either way, but
    // a currency match starts one character earlier, at the symbol.
    if (alreadyChecked(m.index) || alreadyChecked(m.index + m[0].indexOf(m[1]))) continue;
    out.push(m[0].trim());
  }
  return out;
}

/**
 * Whether this document contains count claims the extractor could not read.
 *
 * METRIC_NOUNS is an English word list, and COUNT_CLAIM_RE's modifier window is
 * `[A-Za-z]`. Percentages, currency and multipliers are language-neutral and
 * still checked everywhere — but a COUNT is checked only in English, and this
 * file's own METRIC_NOUNS comment names counts as the class that gets inflated:
 * "Managed 45 staff against a source saying 20 passed the gate silently, which
 * is the exact fabrication class this script exists to catch."
 *
 * Reporting it rather than blocking is the same choice jd-skill-gap.mjs's
 * diagnoseExtraction() and story-provenance-check.mjs's diagnose() make, and
 * for the reason story-provenance states outright: so "an empty/near-empty
 * result isn't misread as 'scanned and clean'". Blocking instead would fail
 * every non-English document, trading a silent gap for a wall.
 *
 * DELIBERATELY CONSERVATIVE. It fires only when the document has two or more
 * count-shaped spans and the extractor produced NO count claim at all — a
 * document where the lexicon reached something is assumed to be reaching it in
 * the language it was written in. Under-reporting is the right direction for a
 * signal added to a gate every generated document already runs.
 *
 * @param {string} targetText
 * @returns {{reason: string, message: string, spans: string[]}|null}
 */
export function diagnoseCoverage(targetText) {
  const spans = countShapedSpans(targetText);
  if (spans.length < 2) return null;
  // RAW matches on purpose. This asks "could the extractor read any count here?",
  // which is about the noun lexicon, not about whether a count was later judged a
  // proposal. Reading the filtered set made a letter whose only counts were plan
  // horizons report "none matched the metric extractor, whose noun list is
  // English-only" -- a false warn blaming the lexicon for counts it had read fine.
  COUNT_CLAIM_RE.lastIndex = 0;
  const recognized = [...stripMarkup(String(targetText ?? '')).matchAll(COUNT_CLAIM_RE)];
  if (recognized.length > 0) return null;
  return {
    reason: 'no-count-claims-recognized',
    message:
      `${spans.length} count-like claims are present but none matched the metric extractor, whose noun ` +
      'list is English-only — so no count in this document was checked against your sources. ' +
      'Percentages, currency and multipliers were still checked. Verify the counts by hand.',
    spans,
  };
}

// ── Allow-list + the pure comparison — verbatim ──────────────────────────────

/**
 * Build the allow-list a metric claim is checked against.
 *
 * Claims extracted from text are folded through NOUN_SYNONYMS; allow_metrics
 * entries used to be normalized only, so an exception written in the spelling
 * a human reaches for - `77 repos` - never matched the canonical `77
 * repositories` the extractor produces. The entry then did nothing at all and
 * the CV still failed the gate, with no diagnostic pointing at the allow-list
 * (CodeRabbit, reviewing #2175). A silently inert exception is the same failure
 * class this script exists to catch.
 *
 * Both spellings are added rather than the canonical one alone: metricClaims()
 * yields nothing for an entry no pattern recognizes (a bare `$900k`, a
 * percentage), so replacing normalizeClaim outright would drop those exceptions
 * instead of widening them. The union can only ever allow more, never less.
 */
function allowedMetricSet(sourceText, allowMetrics) {
  const allowed = new Set(metricClaims(sourceText));
  for (const entry of allowMetrics || []) {
    allowed.add(normalizeClaim(entry));
    for (const canonical of metricClaims(String(entry))) allowed.add(canonical);
  }
  return allowed;
}

/** Compare generated metric claims against source text without reading files. */
export function auditClaims(targetText, sourceText, config = {}) {
  const allowed = allowedMetricSet(sourceText, config.allow_metrics);
  const invented = [...metricClaims(targetText)].filter(claim => !allowed.has(claim));
  // Hoisted: stripMarkup re-ran the whole markup pass once per configured
  // phrase (CodeRabbit, reviewing #2175). Same result, one pass.
  const targetPlain = stripMarkup(targetText).toLowerCase();
  const forbidden = (config.forbidden_phrases || [])
    .filter(Boolean)
    .filter(phrase => targetPlain.includes(String(phrase).toLowerCase()));
  return { invented, forbidden };
}

/** Check a normalized fact as a complete token or phrase, not a substring. */
function sourceContainsFact(sourceText, value) {
  const escaped = value
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}+#/-])${escaped}(?=$|[^\\p{L}\\p{N}+#/-])`, 'iu').test(sourceText);
}

// ── HIREWIRE: the donor's `verifyFacts` body, with the fact source injected ───

/**
 * The HIREWIRE fact gate. Same body as the donor's `verifyFacts`, minus its two
 * filesystem lines: `sourceText` is the student's own `profile_current` rows,
 * flattened by `src/lib/artifacts/facts.mjs`, and `config` is a plain object
 * instead of `config/cv-facts.json`. `|| []` guards are added on the three
 * config arrays because the donor's `loadFactConfig` guaranteed them and we
 * have no loader.
 *
 * @param {string} targetText the generated document, before the human sees it
 * @param {string} sourceText everything we can actually evidence
 * @param {{allow_metrics?: string[], allow_facts?: string[],
 *          forbidden_phrases?: string[], warn_phrases?: string[]}} [config]
 * @returns {{verdict: 'pass'|'warn'|'block', invented: string[],
 *            unsupportedFacts: {kind: string, value: string}[],
 *            forbidden: string[], warnings: string[],
 *            coverage: {reason: string, message: string, spans: string[]}|null}}
 */
export function verifyFacts(targetText, sourceText, config = {}) {
  const allowed = allowedMetricSet(sourceText, config.allow_metrics);
  const targetClaims = metricClaims(targetText);
  const invented = [...targetClaims].filter(claim => !allowed.has(claim));
  const sourceNormalized = normalizeFact(stripMarkup(sourceText));
  const allowedFacts = new Set((config.allow_facts || []).map(normalizeFact));
  const unsupportedFacts = [...factClaims(targetText, sourceNormalized), ...delegatedAuthorshipClaims(targetText, sourceText)]
    .filter(({ value }) => !sourceContainsFact(sourceNormalized, value) && !allowedFacts.has(value))
    .filter((claim, index, claims) => claims.findIndex(other => other.kind === claim.kind && other.value === claim.value) === index);
  const targetPlain = stripMarkup(targetText).toLowerCase();
  const forbidden = (config.forbidden_phrases || [])
    .filter(Boolean)
    .filter(phrase => targetPlain.includes(String(phrase).toLowerCase()));
  const warnings = (config.warn_phrases || [])
    .filter(Boolean)
    .filter(phrase => targetPlain.includes(String(phrase).toLowerCase()));
  // Never downgrades a block and never creates one: a document that fails on
  // real evidence still fails on that, and a coverage gap only turns a would-be
  // 'pass' into 'warn' so the caller is told the gate could not read it.
  const coverage = diagnoseCoverage(targetText);
  const blocked = invented.length || unsupportedFacts.length || forbidden.length;
  return {
    verdict: blocked ? 'block' : (warnings.length || coverage) ? 'warn' : 'pass',
    invented,
    unsupportedFacts,
    forbidden,
    warnings,
    coverage,
  };
}

/**
 * Verify a document and throw when it contains a blocking unsupported claim.
 * The donor's `assertFacts`, with the same three detail strings.
 *
 * The API route does NOT use this — it needs the structured verdict so the UI
 * can show the failing claims — but it is kept because the throwing form is the
 * right one for any future non-interactive caller (a batch job, a voice action
 * that must refuse out loud) and because deleting half a lifted API invites
 * someone to re-derive it differently.
 */
export function assertFacts(targetText, sourceText, config = {}, label = '') {
  const result = verifyFacts(targetText, sourceText, config);
  if (result.verdict === 'block') {
    const details = [];
    if (result.invented.length) details.push(`metric-like claims absent from sources: ${result.invented.join(', ')}`);
    if (result.unsupportedFacts.length) details.push(`non-metric facts absent from sources: ${result.unsupportedFacts.map(({ kind, value }) => `${kind}=${value}`).join(', ')}`);
    if (result.forbidden.length) details.push(`forbidden phrases found: ${result.forbidden.join(', ')}`);
    throw new Error(`Fact check failed${label ? ` for ${label}` : ''}: ${details.join('; ')}`);
  }
  return result;
}

// ── HIREWIRE ADDITIONS ───────────────────────────────────────────────────────

/**
 * The fact-gate config for HIREWIRE. career-ops reads this from
 * `config/cv-facts.json`; we have no user-editable config surface at a hackathon,
 * so it is a constant and its contents are argued for here.
 *
 * `forbidden_phrases` are the tells of a document that should never reach an
 * employer under a real name: a leaked system prompt, an unfilled placeholder,
 * or the literal fake company the hard rules forbid (hard rule 7).
 *
 * `warn_phrases` are the tells of a letter that is padding rather than saying
 * anything — not a lie, so not a block, but worth telling the human about.
 *
 * `allow_metrics` is EMPTY and should stay that way. Every entry in it is a
 * number the gate stops checking, and the only honest source of numbers here is
 * the student's own profile.
 */
export const FACT_CONFIG = {
  allow_metrics: [],
  allow_facts: [],
  forbidden_phrases: [
    'as an ai language model',
    'as an ai assistant',
    'i am an ai',
    'lorem ipsum',
    'acme corp',
    'acme corporation',
    'john doe',
    'jane doe',
    '[company]',
    '[company name]',
    '[your name]',
    '[position]',
    '[role]',
    'xyz company',
    'insert company',
    'todo:',
  ],
  warn_phrases: [
    'i am a perfect fit',
    'i am the perfect candidate',
    'passionate about leveraging',
    'synergy',
    'think outside the box',
    'world-class',
    'rockstar',
    'ninja',
  ],
};

/**
 * One reason sentence per finding, because hard rule 4 applies to a flagged
 * claim exactly as it applies to a score. The donor returns bare strings and
 * `{kind, value}` pairs; a UI that renders those raw shows the student
 * `45 staff` with no explanation of why it is red.
 *
 * @param {ReturnType<typeof verifyFacts>} result
 * @returns {{claim: string, kind: string, severity: 'block'|'warn', reason: string}[]}
 */
export function explainFindings(result) {
  const out = [];
  for (const claim of result.invented) {
    out.push({
      claim,
      kind: 'metric',
      severity: 'block',
      reason:
        `Your profile contains no number matching "${claim}", so this figure was not ` +
        `copied from anything you told us — it was produced by the model. It cannot go ` +
        `on an application until you can point at where it comes from.`,
    });
  }
  for (const { kind, value } of result.unsupportedFacts) {
    const why = {
      employer: 'an employer you never listed',
      title: 'a job title you never listed',
      tool: 'a technology your profile never mentions',
      authorship: 'direct authorship of work your profile attributes to someone else',
    }[kind] ?? 'a fact with no support in your profile';
    out.push({
      claim: value,
      kind,
      severity: 'block',
      reason: `The document claims ${why} ("${value}"). Nothing in your profile supports it.`,
    });
  }
  for (const phrase of result.forbidden) {
    out.push({
      claim: phrase,
      kind: 'forbidden',
      severity: 'block',
      reason:
        `"${phrase}" is a placeholder or a model artefact, not something a person wrote. ` +
        `A document containing it must never be sent.`,
    });
  }
  for (const phrase of result.warnings) {
    out.push({
      claim: phrase,
      kind: 'filler',
      severity: 'warn',
      reason:
        `"${phrase}" is filler — it is not false, but it says nothing a reader can check. ` +
        `Consider cutting it.`,
    });
  }
  if (result.coverage) {
    out.push({
      claim: result.coverage.spans.join(', '),
      kind: 'coverage',
      severity: 'warn',
      reason: result.coverage.message,
    });
  }
  return out;
}

/** The one-sentence summary of a verdict, for the aria-live region. */
export function verdictSentence(result, claimsChecked) {
  if (result.verdict === 'block') {
    const n =
      result.invented.length + result.unsupportedFacts.length + result.forbidden.length;
    return (
      `Verification FAILED: ${n} claim${n === 1 ? '' : 's'} in this document ` +
      `${n === 1 ? 'has' : 'have'} no support in your profile. The download is withheld ` +
      `until they are resolved — a document that overclaims is worse than no document.`
    );
  }
  if (result.verdict === 'warn') {
    return (
      `Verification PASSED with ${result.warnings.length + (result.coverage ? 1 : 0)} advisory ` +
      `note${result.warnings.length + (result.coverage ? 1 : 0) === 1 ? '' : 's'}: every factual ` +
      `claim traces to your profile, but some wording is worth a second look.`
    );
  }
  return (
    `Verification PASSED: all ${claimsChecked} checkable claim${claimsChecked === 1 ? '' : 's'} ` +
    `in this document trace back to a fact in your profile.`
  );
}

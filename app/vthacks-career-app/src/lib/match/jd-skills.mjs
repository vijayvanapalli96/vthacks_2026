/**
 * jd-skills.mjs — zero-LLM JD requirement extraction and three-way skill
 * classification. STAGE 1 of the match agent; spends no model call at all.
 *
 * ADAPTED from career-ops v1.33.0 `jd-skill-gap.mjs`.
 *
 *   Copyright (c) 2026 Santiago Fernández de Valderrama
 *   MIT License. https://github.com/santifer/career-ops
 *
 * WHAT WAS LIFTED, AND WHAT WAS NOT. The original is 925 lines and is coupled
 * to `cv.md` and career-ops' data-root resolution, so copying it wholesale would
 * drag a filesystem contract we do not have into a Next.js bundle. Lifted here:
 * the requirement/non-requirement header state machine, `SKILL_TOKEN_RE`, the
 * `STOPWORDS` list, `skillMentionedInText`, and — the genuinely valuable idea —
 * the THREE-WAY existing / supportedByResume / gap classification.
 *
 * Why three ways and not two. "Does the JD ask for something the profile lacks?"
 * has three answers, not two, and collapsing them loses the useful one:
 *
 *   existing          the profile CLAIMS this skill (it is in profile_skills)
 *   supportedByResume the profile does not claim it, but the prose — experience
 *                     bullets, projects, summary — evidences it
 *   gap               no trace anywhere
 *
 * `existing` and `supportedByResume` are both "can do it"; only `gap` is a real
 * hole. Merging the middle bucket into `gap` manufactures gaps out of skills the
 * candidate demonstrably has but never listed, and telling a student to go learn
 * something their own resume proves they did is confidently wrong. Merging it
 * into `existing` is the opposite error and produces an indefensible claim.
 * `match_evaluations.skills_missing` is fed from `gap` ONLY.
 *
 * SECURITY: every string here comes from `job_snapshots.description_text`, which
 * came from the open internet. It is DATA, never instruction, and it never
 * reaches a SQL statement except as a bound parameter.
 */
// Via skill-aliases.mjs, not skill-extract.mjs directly: the alias layer has to
// see BOTH sides of every comparison or it moves mismatches instead of fixing
// them. See that file's header for why the additions live outside the verbatim
// donor copy.
import {
  canonicalizeSkill as canonicalize,
  extractSkillsExtended as extractSkills,
} from './skill-aliases.mjs';

// ── Header detection ─────────────────────────────────────────────────────────
// Lifted from jd-skill-gap.mjs. The CJK alternatives in the original are kept:
// the corpus is 74 US-facing boards today, but the cost of keeping them is zero
// and the cost of a posting that closes its requirements block in Chinese is a
// benefits list scored as required skills.

const REQUIREMENT_HEADER_RE = new RegExp(
  '^#{0,6}\\s*(?:(?:' +
    [
      'required',
      'requirements',
      'qualifications',
      'must[- ]have',
      'preferred',
      'nice[- ]to[- ]have',
      "what\\s+we(?:(?:'|’)?\\s*re|\\s+are)\\s+looking\\s+for",
      "what\\s+you(?:(?:'|’)ll|\\s+will)?\\s+bring",
      'who\\s+you\\s+are',
      'about\\s+you',
      'your\\s+(?:background|experience|profile)',
      'you\\s+(?:may|might|could)\\s+be\\s+a\\s+good\\s+fit',
      // Ashby's default template ships a bare "YOU HAVE:" heading with no
      // markdown hashes, already allowed by the ^#{0,6} prefix. Without this
      // entry the whole requirements block is invisible even though the bullets
      // under it are perfectly well formed.
      "you(?:(?:'|’)ll|\\s+will)?\\s+have",
      "it(?:'|’)?s\\s+important\\s+to\\s+us\\s+that\\s+you\\s+have",
      'it\\s+would\\s+be\\s+great\\s+if\\s+you\\s+ha(?:ve|d)',
      'ideal\\s+candidate',
      'skills\\s+(?:and|&)\\s+experience',
      // ADDED for this corpus, not in the career-ops original: Greenhouse and
      // Lever postings in job_snapshots routinely head the block with these.
      'basic\\s+qualifications',
      'minimum\\s+qualifications',
      'preferred\\s+qualifications',
      'what\\s+you(?:(?:\'|’)ll)?\\s+need',
      'requirements\\s+(?:and|&)\\s+skills',
    ].join('|') +
    ')s?\\b|(?:' +
    [
      '應徵條件',
      '資格條件',
      '職務需求',
      '條件要求',
      '任職資格',
      '必要條件',
      '基本要求',
      '職位要求',
      '加分項目',
      '加分條件',
    ].join('|') +
    ')).*$',
  'im',
);

// Headers that END a requirements block even when the posting uses no markdown
// heading levels. Without this the block stays open to end-of-file and sweeps
// the benefits list into "required skills" — turning perks like "401k" and
// "Equity" into reported skill gaps.
const NON_REQUIREMENT_HEADER_RE = new RegExp(
  '^#{0,6}\\s*(?:(?:' +
    [
      // The negative lookahead keeps "You will have" on the requirements side;
      // this pattern is tested BEFORE REQUIREMENT_HEADER_RE in scanJd(), so
      // without it a "You will have:" heading would close a block instead of
      // opening one.
      'you\\s+will(?!\\s+have)',
      'benefits?',
      'perks?',
      'benefits\\s+and\\s+perks',
      'compensation',
      'salary',
      'pay\\s+range',
      'what\\s+we\\s+offer',
      'why\\s+(?:join|work|this\\s+role)',
      'about\\s+(?:us|the\\s+company|the\\s+team|the\\s+role)',
      'how\\s+(?:and\\s+where\\s+)?we\\s+work',
      'equal\\s+opportunity',
      'eeo',
      'diversity',
      'interview\\s+process',
      'how\\s+to\\s+apply',
      'to\\s+apply',
      'our\\s+(?:stack|process|values|mission)',
      // ADDED for this corpus: US postings in job_snapshots close with these
      // far more often than with the career-ops list's headings, and the
      // sponsorship/authorization boilerplate under them is the single biggest
      // source of phantom "skills".
      'responsibilities',
      'what\\s+you(?:(?:\'|’)ll)?\\s+do',
      'the\\s+role',
      'day\\s+to\\s+day',
      'legal\\s+notice',
      'privacy',
      'accommodations?',
    ].join('|') +
    ')\\b|(?:' +
    [
      '工作內容',
      '工作職責',
      '職責範疇',
      '福利',
      '薪資',
      '薪酬',
      '公司介紹',
      '關於我們',
      '應徵方式',
      '如何應徵',
    ].join('|') +
    ')).*$',
  'im',
);

// `\r?$` is required, not cosmetic: JS treats \r as a line terminator, so `.`
// cannot consume it and a bare `$` never matches on a CRLF-split line. Half the
// scraped descriptions in job_snapshots are CRLF.
const BULLET_LINE_RE = /^\s*[-*•]\s*(.+)\r?$/;

// Strip markdown STRONG-emphasis markers so a bolded heading with no `#` at all
// — "**What We're Looking For**" — still reaches the header patterns above as if
// the bold wrapper were never there. Only DOUBLED markers: a single `*` is also
// how a plain markdown bullet starts, and a bullet whose text begins with a
// keyword must stay a bullet.
function stripBoldMarkers(line) {
  return line.replace(/\*\*|__/g, '');
}

// A conservative skill-token extractor: pulls technical-looking tokens out of a
// requirement bullet rather than treating the whole bullet as one skill string,
// because JD bullets are usually full sentences.
//
// Trailing boundary: \b fails at symbol edges (\bC\+\+\b needs a word char
// AFTER the +), so C++/C#/F# would never match standalone — (?!\w) is
// equivalent to \b for word-char edges and correct for symbol edges.
const SKILL_TOKEN_RE = /\b([A-Z][A-Za-z0-9+.#]{0,29}[A-Za-z0-9+#](?:\.[a-z]{2,4})?)(?!\w)/g;

// Deliberately broad. This list exists specifically to stop generic capitalized
// nouns from JD bullets ("Bachelor's degree required", "3+ years of experience")
// from being misreported as missing SKILLS — the exact failure mode that makes a
// skill-gap list useless.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'our', 'this', 'that', 'these', 'those',
  'must', 'able', 'ability', 'strong', 'excellent', 'proven', 'a', 'an', 'or', 'in',
  'of', 'to', 'as', 'is', 'are',
  // degree / education boilerplate
  'bachelor', 'bachelors', 'master', 'masters', 'degree', 'diploma', 'certification',
  'certificate',
  // experience / seniority boilerplate
  'experience', 'years', 'year', 'senior', 'junior', 'entry', 'level', 'minimum',
  'preferred', 'required',
  // generic sentence-starters that show up capitalized at the start of a bullet
  'candidates', 'candidate', 'applicants', 'applicant', 'ideal', 'successful',
  'knowledge', 'understanding', 'familiarity', 'exposure', 'background',
  'skills', 'skill', 'communication', 'team', 'teams', 'work', 'working',
  'deep', 'interest', 'genuine', 'solid', 'comfortable', 'passion', 'passionate',
  'track', 'record', 'real', 'bonus', 'plus', 'hands', 'proficiency', 'fluency',
  'expertise', 'demonstrated', 'extensive', 'practical', 'good', 'great', 'clear',
  // ADDED for this corpus. US postings put authorization, EEO and location
  // boilerplate inside requirement blocks, and every capitalized noun in it was
  // landing in skills_missing — which is the column the coursework lever will
  // aggregate, so noise here becomes a wrong course recommendation later.
  'us', 'usa', 'united', 'states', 'citizen', 'citizenship', 'authorization',
  'authorized', 'sponsorship', 'visa', 'clearance', 'secret', 'eligible',
  'eligibility', 'employer', 'employment', 'equal', 'opportunity', 'veteran',
  'disability', 'gender', 'race', 'remote', 'hybrid', 'onsite', 'office',
  'time', 'full', 'part', 'week', 'day', 'days', 'month', 'months',
  'ideally', 'willingness', 'willing', 'nice', 'must-have', 'able',
  'you’ll', 'we', 'we’re', 'if', 'what', 'who', 'how', 'why', 'when',
  'plus', 'also', 'but', 'not', 'all', 'any', 'more', 'most', 'other', 'others',
  'bachelor’s', 'master’s', 'phd', 'ph', 'd', 'bs', 'ms', 'ba', 'ma',
]);

/**
 * Scan a JD once, returning both the extracted requirement tokens and whether a
 * requirement-style section was ever opened.
 *
 * `sawRequirementSection` is what lets a caller tell apart the two very
 * different reasons an extraction comes back empty: "I never found a
 * requirements section, so I checked nothing" versus "I checked one and
 * recognized none of its terms". Both print as zero skills, and only the first
 * means the check did not run. It is surfaced on the retrieval row so an empty
 * `skills_missing` never silently reads as "no gaps".
 *
 * @param {string} jdText
 * @returns {{skills: string[], sawRequirementSection: boolean}}
 */
export function scanJd(jdText) {
  const lines = String(jdText ?? '').split('\n');
  const skills = new Set();
  // Every line inside a requirements block, bullet or not. The donor only ever
  // harvested BULLETS, via SKILL_TOKEN_RE, which has two consequences on this
  // corpus: a non-bullet requirement line ("3+ years with Python and Kubernetes")
  // contributes nothing, and a lowercase skill name ('dbt', 'k8s',
  // 'scikit-learn') can never match because SKILL_TOKEN_RE is anchored on [A-Z].
  // The donor's own diagnoseExtraction() comment says so outright. Collecting the
  // section TEXT lets requirementsFor() run the canonical vocabulary over it,
  // which has neither limitation — while this stays ONE state machine, which is
  // the thing the donor is emphatic about not duplicating.
  const requirementLines = [];
  let inRequirementsBlock = false;
  let sawRequirementSection = false;

  for (const line of lines) {
    const headerLine = stripBoldMarkers(line);
    // Checked BEFORE the requirement test so a heading that satisfies both
    // closes the block rather than reopening it.
    if (NON_REQUIREMENT_HEADER_RE.test(headerLine)) {
      inRequirementsBlock = false;
      continue;
    }
    if (REQUIREMENT_HEADER_RE.test(headerLine)) {
      inRequirementsBlock = true;
      sawRequirementSection = true;
      continue;
    }
    if (inRequirementsBlock && line.trim() === '') continue;
    if (
      inRequirementsBlock &&
      /^#{1,6}\s/.test(line) &&
      !REQUIREMENT_HEADER_RE.test(headerLine)
    ) {
      inRequirementsBlock = false;
    }

    if (inRequirementsBlock) requirementLines.push(line);

    const bulletMatch = BULLET_LINE_RE.exec(line);
    if (inRequirementsBlock && bulletMatch) {
      const bulletText = bulletMatch[1];
      let m;
      SKILL_TOKEN_RE.lastIndex = 0;
      while ((m = SKILL_TOKEN_RE.exec(bulletText)) !== null) {
        const token = m[1].trim();
        if (!STOPWORDS.has(token.toLowerCase()) && token.length > 1) {
          skills.add(token);
        }
      }
    }
  }
  return {
    skills: [...skills],
    sawRequirementSection,
    requirementText: requirementLines.join('\n'),
  };
}

/**
 * Extract candidate requirement tokens from a JD's requirement-style sections.
 * @param {string} jdText
 * @returns {string[]}
 */
export function extractJdSkills(jdText) {
  return scanJd(jdText).skills;
}

// ── Making the above actually work on THIS corpus ────────────────────────────
//
// MEASURED, on 60 engineering postings drawn from the live `open_us_jobs` view:
//
//   scanJd() on the raw text            ->  2 / 60 found a requirements section
//   scanJd() on normalised text         -> 41 / 60
//   canonical vocabulary, whole text    -> 2.9 recognised skills per posting
//
// 2 out of 60 is the whole story. `job_snapshots.description_text` is HTML that
// has been flattened to plain text by the ingest path: most rows are ONE running
// paragraph with no newlines and no bullet characters at all. The donor's state
// machine needs lines to classify and bullets to harvest, so on this corpus it
// silently returned nothing — which shipped as empty `skills_matched` and empty
// `skills_missing` on every single match in the first live run. Nothing threw.
// That is the failure mode plan §7.1 predicted ("description_text quality varies
// by ATS"), arriving structurally rather than occasionally.
//
// Two fixes, layered, precision first.

const HEADING_PHRASES = [
  // Longest first within a family so "Basic Qualifications" wins over
  // "Qualifications" and the shorter one does not split the longer one's text.
  'Basic Qualifications', 'Minimum Qualifications', 'Preferred Qualifications',
  'Qualifications', 'Requirements', 'Required Skills', 'Skills and Experience',
  "What You'll Bring", 'What You Will Bring', "What You'll Need",
  'Who You Are', 'About You', 'You Have', 'You Will Have',
  'Nice to have', 'Nice-to-have', 'Must have', 'Must-have',
  // Closers matter as much as openers: without them the block runs to
  // end-of-file and the benefits list becomes required skills.
  'Responsibilities', "What You'll Do", 'What You Will Do',
  'Benefits', 'Perks', 'Compensation', 'Salary Range', 'Pay Range',
  'About Us', 'About the Role', 'About the Team', 'Equal Opportunity',
  'How to Apply', 'What we offer', 'Why Join',
];

const HEADING_SPLIT_RE = new RegExp(
  `\\b(${HEADING_PHRASES.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b\\s*:?`,
  'gi',
);

/**
 * Re-introduce enough structure into a flattened description for scanJd() to work.
 *
 * Three passes, and each one is doing the minimum that lets the existing state
 * machine see what it needs:
 *   1. every recognised heading PHRASE becomes a markdown heading on its own line;
 *   2. every sentence boundary becomes a bullet, because a flattened bullet list
 *      IS a run of sentences once the <li> tags are gone;
 *   3. any remaining line that starts with a capital becomes a bullet too.
 *
 * Only ever called when the RAW text yielded nothing, so it cannot damage a
 * posting that already had real structure. That guard is load-bearing: run on
 * Replit's already-structured posting, this normaliser produces ZERO tokens where
 * the raw text produced fourteen, because pass 2 shatters its lines.
 *
 * The lookbehind in pass 2 requires a lowercase letter, digit or closing bracket
 * before the period, which keeps "Ph.D.", "U.S." and "Node.js" from splitting.
 *
 * @param {string} jdText
 * @returns {string}
 */
export function normalizeFlattenedJd(jdText) {
  //   is everywhere in scraped ATS text and is NOT matched by \s in some
  // older engines; normalising it first makes every pattern below simpler.
  let s = String(jdText ?? '').replace(/ /g, ' ');
  s = s.replace(HEADING_SPLIT_RE, (m) => `\n## ${m.replace(/:\s*$/, '').trim()}\n`);
  s = s.replace(/(?<=[a-z0-9)\]”"'])\.\s+(?=[A-Z])/g, '.\n- ');
  s = s.replace(/\n(?!##|- )([A-Z][^\n]{3,})/g, '\n- $1');
  return s;
}

/**
 * The requirements of a posting, and WHERE they were read from.
 *
 * The requirements SECTION is located with the donor's state machine; the skills
 * inside it are then read with the CANONICAL VOCABULARY rather than with
 * `SKILL_TOKEN_RE`. That swap is the precision half of the fix, and it buys two
 * things at once:
 *
 *   * No garbage. `SKILL_TOKEN_RE` harvests any capitalised token, so on real
 *     postings "Palo", "Alto", "Site", "Reliability" and "Systems" land in
 *     `skills_missing` next to Terraform. `skills_missing` is the column the
 *     coursework lever will aggregate into "take CS 3214 and +40% of postings open
 *     up", so a garbage token there becomes a wrong course recommendation later. A
 *     closed vocabulary cannot produce one.
 *   * Lowercase and non-bullet requirements. `SKILL_TOKEN_RE` is anchored on
 *     `[A-Z]` and only ever ran on bullets, so 'dbt' and 'k8s' were invisible and
 *     so was "3+ years with Python and Kubernetes" if it was not a bullet.
 *
 * THE COST, stated rather than hidden: a genuinely required skill the vocabulary
 * does not know — RocksDB, Spanner, AlloyDB — is dropped from `skills_missing`.
 * That is plan §7.2's trade ("skill extraction is a vocabulary, not
 * understanding") and it is exactly what stage 2 covers; the reranker reads the
 * full posting and names those requirements in its explanation. It is a
 * zero-token stage being honest about its ceiling, not a bug.
 *
 * `source` is returned, not inferred, so an empty result can always be told apart
 * from an unchecked one.
 *
 * @param {string} jdText
 * @returns {{skills: string[], source: string, sawRequirementSection: boolean}}
 */
export function requirementsFor(jdText) {
  const raw = scanJd(jdText);
  if (raw.sawRequirementSection) {
    const skills = [...extractSkills(raw.requirementText)];
    if (skills.length > 0) {
      return { skills, source: 'requirements-section', sawRequirementSection: true };
    }
  }

  // Only now. The normaliser SHATTERS an already-structured posting — its
  // sentence-to-bullet pass breaks real lines — so running it first would destroy
  // the postings that need no help.
  const normalized = scanJd(normalizeFlattenedJd(jdText));
  if (normalized.sawRequirementSection) {
    const skills = [...extractSkills(normalized.requirementText)];
    if (skills.length > 0) {
      return {
        skills,
        source: 'normalized-requirements-section',
        sawRequirementSection: true,
      };
    }
  }

  // No requirements section anywhere. Fall back to the vocabulary over the whole
  // description. Less precise about what is REQUIRED versus merely mentioned, and
  // labelled as such — but it is the difference between this feature working on
  // this corpus and returning empty arrays on every row.
  return {
    skills: [...extractSkills(jdText)],
    source: 'whole-description-vocabulary',
    sawRequirementSection: false,
  };
}

/**
 * Word-boundary, case-insensitive check for whether a token appears in text.
 * Lifted as-is: it is what stops "Java" matching inside "JavaScript", which is
 * the single most common false positive in this whole pipeline.
 *
 * @param {string} skill
 * @param {string} text
 * @returns {boolean}
 */
export function skillMentionedInText(skill, text) {
  if (!skill || !text) return false;
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i');
  return re.test(text);
}

/**
 * Classify each JD requirement token against a profile, three ways.
 *
 * The career-ops original splits one `cv.md` into a named "## Skills" section
 * and the remaining prose. Our equivalent split is structural rather than
 * textual and is the one place this function genuinely differs: `claimedSkills`
 * is `profile_skills` (the rows the student explicitly asserted, already
 * canonical per that table's own comment) and `proseText` is the summary,
 * experience bullets and project descriptions. Same two tiers, same meaning,
 * read from tables instead of parsed out of markdown.
 *
 * Folding BOTH sides through `canonicalize()` is what closes the alias gap: a
 * profile that says "k8s" and a JD that says "Kubernetes" must resolve to one
 * name instead of being reported as a false gap.
 *
 * @param {string[]} jdSkills
 * @param {Iterable<string>} claimedSkills - profile_skills.skill values
 * @param {string} proseText - summary + experience bullets + projects
 * @returns {{existing: string[], supportedByResume: string[], gap: string[]}}
 */
export function classifySkillGaps(jdSkills, claimedSkills, proseText) {
  const prose = String(proseText ?? '');
  // Canonicalize the CLAIMED set itself, not just the JD token. profile_skills
  // is supposed to already hold canonical forms, but it is written by the intake
  // extractor and "JS" / "Node" get through — and a claimed skill that does not
  // canonicalize is a claimed skill that never cancels a JD requirement.
  const claimedCanon = new Set();
  for (const raw of claimedSkills ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    claimedCanon.add(canonicalize(raw.trim()));
    // A profile skill can be a phrase ("CSS3(Grid/Flexbox)", "JavaScript(ES6+)")
    // that canonicalize() passes through unchanged. Running the vocabulary over
    // it recovers the canonical names inside.
    for (const inner of extractSkills(raw)) claimedCanon.add(inner);
  }
  const proseCanon = extractSkills(prose);

  const existing = [];
  const supportedByResume = [];
  const gap = [];

  for (const skill of jdSkills) {
    const canon = canonicalize(skill);
    // "Known" = the vocabulary recognizes this token. For known skills the
    // canonical-set lookup is authoritative and alias-safe. Unknown tokens
    // canonicalize to themselves and fall through to the word-boundary
    // heuristic below.
    const known = canon !== skill || extractSkills(skill).size > 0;

    if (known && claimedCanon.has(canon)) existing.push(skill);
    else if (known && proseCanon.has(canon)) supportedByResume.push(skill);
    else if (claimedCanon.has(skill)) existing.push(skill);
    else if (skillMentionedInText(skill, prose)) supportedByResume.push(skill);
    else gap.push(skill);
  }

  return { existing, supportedByResume, gap };
}

/**
 * Coursework that covers a JD requirement.
 *
 * Distinct from `supportedByResume` on purpose: a course is weaker evidence than
 * shipped work and a student knows the difference, so it gets its own column
 * (`match_evaluations.courses_matched`) rather than being folded into either
 * "has it" bucket. The returned strings are `"CS 3214 — Computer Systems"`-shaped
 * so the UI can show WHICH course covers the gap without a second query.
 *
 * @param {string[]} jdSkills
 * @param {{course_code: string, title?: string|null, skills?: string[]|null}[]} courses
 * @returns {string[]}
 */
export function matchCourses(jdSkills, courses) {
  const wanted = new Set(jdSkills.map(canonicalize));
  const out = [];
  for (const course of courses ?? []) {
    if (!course?.course_code) continue;
    const covered = new Set();
    for (const raw of course.skills ?? []) {
      if (typeof raw !== 'string') continue;
      const canon = canonicalize(raw.trim());
      if (wanted.has(canon)) covered.add(canon);
      for (const inner of extractSkills(raw)) if (wanted.has(inner)) covered.add(inner);
    }
    if (covered.size > 0) {
      const label = course.title ? `${course.course_code} — ${course.title}` : course.course_code;
      out.push(`${label} (${[...covered].sort().join(', ')})`);
    }
  }
  return out;
}

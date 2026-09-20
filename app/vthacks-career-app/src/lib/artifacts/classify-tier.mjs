/**
 * classify-tier.mjs — LIFTED VERBATIM from the career-ops donor repo.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * Source:  career-ops/classify-tier.mjs  (v1.33.0)
 * License: MIT — Copyright (c) 2026 Santiago Fernández de Valderrama
 *          <hi@santifer.io> · https://santifer.io
 * career-ops is a DONOR REPO, not a dependency. The file is copied, never
 * imported across the repo boundary, and `../career-ops/` is never edited.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * WHAT CHANGED, and nothing else changed:
 *   1. The two donor imports (`./lib/cli-flags.mjs`, `./lib/is-main-module.mjs`)
 *      are gone, along with the `--test`/`--help` CLI shim and `runTests()` they
 *      served. This runs inside a Next.js route, where `process.argv` is the
 *      server's argv and `process.exit` would kill the app.
 *   2. `export default classifyTier` is kept.
 * `classifyTier` itself — every regex, every weight, both guards, the
 * leftmost-marker rule and all of its comments — is byte-identical to the donor.
 * That is the point: this is the function career-ops uses to decide whether a
 * posting titled "junior" is actually entry level, and a re-derived version
 * would quietly disagree with it.
 *
 * Why we want it: hard rule 8 (don't overclaim) cuts both ways. A posting that
 * says "Junior Engineer" in the title and "5+ years required" in the body is a
 * senior role, and telling a student it is entry-level wastes their application.
 */

/**
 * Classifies a job title into exactly one seniority tier.
 *
 * NOTE: Unrecognized or plain titles (e.g., "Software Engineer" with no explicit level
 * indicators) fall back to 'mid' as the default/unknown bucket. Consequently, configuring
 * `skip_tiers: [mid]` in portals.yml will exclude most unmatched/ordinary listings, not
 * just explicit mid-level roles.
 *
 * @param {string} title - The job title to classify.
 * @returns {'intern' | 'entry' | 'mid' | 'senior'}
 */
export function classifyTier(title) {
  if (typeof title !== 'string') {
    return 'mid';
  }

  // Preprocess title to avoid false positives with common acronyms
  let cleanTitle = title
    .replace(/\bA\.I\./ig, 'AI')
    .replace(/\bA\.I\b/ig, 'AI')
    .replace(/\bA\.\s+I\b/ig, 'AI')
    .replace(/\bI\.T\./ig, 'IT')
    .replace(/\bI\.T\b/ig, 'IT')
    .replace(/\bI\.\s+T\b/ig, 'IT')
    .replace(/\bi\/o\b/ig, 'IO');

  // Define matchers with tier and weight (higher weight wins)
  const matchers = [
    // Senior Tier (weight 4)
    { pattern: /\bchief\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bvp\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bvice\s+president\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bdirector\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bprincipal\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bstaff\b/i, tier: 'senior', weight: 4 },
    { pattern: /\blead\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bsenior\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bsr\b/i, tier: 'senior', weight: 4 },
    { pattern: /\bsr\./i, tier: 'senior', weight: 4 },
    { pattern: /\bhead\s+of\b/i, tier: 'senior', weight: 4 },
    { pattern: /\b[a-z]{2,}[\s-](iii|iv|v)\b/i, tier: 'senior', weight: 4 },

    // Mid Tier (weight 3)
    { pattern: /\bmid-level\b/i, tier: 'mid', weight: 3 },
    { pattern: /\bmid\b/i, tier: 'mid', weight: 3 },
    { pattern: /\b[a-z]{2,}[\s-](ii)\b/i, tier: 'mid', weight: 3 },
    { pattern: /\b(l4|l5)\b/i, tier: 'mid', weight: 3 },

    // Entry Tier (weight 2)
    { pattern: /\bentry-level\b/i, tier: 'entry', weight: 2 },
    { pattern: /\bentry\b/i, tier: 'entry', weight: 2 },
    { pattern: /\bassociate\b/i, tier: 'entry', weight: 2 },
    { pattern: /\bjunior\b/i, tier: 'entry', weight: 2 },
    { pattern: /\b[a-z]{2,}[\s-](i)\b/i, tier: 'entry', weight: 2 },
    { pattern: /\b(l1|l2)\b/i, tier: 'entry', weight: 2 },

    // Intern Tier (weight 1)
    { pattern: /\binternship\b/i, tier: 'intern', weight: 1 },
    { pattern: /\bintern\b/i, tier: 'intern', weight: 1 },
    { pattern: /\btrainee\b/i, tier: 'intern', weight: 1 },
    { pattern: /\bco-op\b/i, tier: 'intern', weight: 1 },
    {
      pattern: {
        test: (t) => /\bgraduate\b/i.test(t) && /\b(program|scheme)\b/i.test(t),
        // Position of the level word itself, not of the "program" qualifier.
        // Deliberately NOT named `search`: overloading a String.prototype method
        // name on a matcher object makes `pattern.search(title)` read as the
        // built-in, which coerces its argument to a RegExp — CodeQL flagged it
        // as regex injection on the CLI's argv-derived title. The regex here is
        // a literal and nothing is compiled from input, but the name was the
        // problem, for a reader as much as for the analyzer.
        levelWordIndex: (t) => t.search(/\bgraduate\b/i)
      },
      tier: 'intern',
      weight: 1
    }
  ];

  // Guard (a): "Associate <senior noun>" resolves to senior. The `associate`
  // prefix qualifies the seniority band of a senior role; it does not demote it
  // to entry-level. Checked before the position loop because `associate` always
  // precedes the senior noun, so the leftmost-marker rule would fire on
  // `associate` at index 0 and return entry.
  //
  // The noun list is CLOSED, and has to stay that way: in plenty of fields
  // `associate` genuinely does mark the junior variant, and those must keep
  // resolving to entry — Associate Attorney, Associate Editor, Associate
  // Producer, Associate Manager, Associate Consultant. A generic "associate
  // never demotes" rule breaks every one of them.
  //
  // The academic ranks are on the list because `associate` names a RANK there
  // rather than a junior variant: Associate Professor is the rung above
  // Assistant Professor, and Dean/Provost/Chancellor/Superintendent head an
  // institution (#3178). The criterion is institution-level head, not
  // office-level deputy — which is why Registrar, Bursar and Librarian stay
  // off, along with Rector (a parish `associate rector` IS the junior one).
  const associateAt = cleanTitle.search(/\bassociate\b/i);
  if (associateAt >= 0) {
    // A junior marker that LEADS the title still decides it. "Intern, Associate
    // Dean of Student Life" is an internship in a dean's office, not a
    // deanship — the same doctrine the position loop below applies to
    // "Summer Intern, Director of Product". Without this the guard returns
    // early and inverts the very harm #3178 is about, on the same board.
    const juniorAt = cleanTitle.search(/\b(?:intern(?:ship)?|trainee|co-op|graduate|junior|entry(?:-level)?)\b/i);
    if (juniorAt < 0 || juniorAt > associateAt) {
      const afterAssociate = cleanTitle.slice(associateAt + 'associate'.length);
      // WHITESPACE only, and at most two words of gap. Both bounds carry
      // weight. Any comma or dash after `associate` means `associate` is the
      // role and what follows is a separate clause: "Research Associate -
      // Professor Smith Laboratory" and "Administrative Associate, Office of
      // the Dean" are junior roles that a to-end-of-string search reads as
      // senior. The two-word cap then stops "Office of the Dean" and real
      // employers named for a noun on this list — Dean & Company (whose entry
      // title is literally "Associate Consultant"), Dean Foods, Dean Witter,
      // Provost Umphrey. It also keeps the legal pair honest: bare `counsel`
      // is off the list because a firm's associate IS the junior lawyer, and
      // without the bound "Associate Counsel, Office of the General Counsel"
      // would match `general counsel` from the department name.
      if (/^\s+(?:[a-z]+\s+){0,2}(director|vice\s+president|vp|principal|partner|chief|head\s+of|professor|dean|provost|chancellor|superintendent|general\s+counsel)\b/i.test(afterAssociate)) {
        return 'senior';
      }
    }
  }

  // Guard (b): [intern/entry marker] + [programme bridge noun] + [senior role noun]
  // resolves to senior. "Intern Program Director" manages an intern programme; it is
  // not itself an internship. The bridge-noun set is a closed list — a generic
  // adjacency rule breaks "Junior Staff Accountant" (staff is a senior matcher but
  // not a bridge word for this construction).
  const programBridge = /\b(?:intern(?:ship)?|trainee|co-op|graduate|junior|entry(?:-level)?)\s+(?:program|scheme|talent|cohort)\b/i;
  if (programBridge.test(cleanTitle)) {
    const afterBridge = cleanTitle.replace(programBridge, ' ').trim();
    if (/\b(chief|vp|vice\s+president|director|principal|staff|lead|senior|sr\.?|head\s+of|partner)\b/i.test(afterBridge)) {
      return 'senior';
    }
  }

  // POSITION decides, not seniority rank. Ranking by weight meant any senior
  // word anywhere outranked an explicit programme marker, and in real titles
  // that word is usually naming the team, office or person the role sits beside
  // — "Summer Intern, Director of Product" is an internship. English job titles
  // put the level first, so the LEFTMOST marker is the role's own level. That
  // still reads "Senior Intern Coordinator" as senior: there the senior word
  // genuinely leads the title.
  //
  // This is not cosmetic: scan.mjs drops a posting whose tier is in
  // `skip_tiers` without naming it, so a junior candidate skipping `senior`
  // silently lost the internships they were scanning for.
  //
  // Weight survives only as the tie-break for two markers at the same offset,
  // which keeps the longer, more specific pattern of an overlapping pair
  // (`mid-level` over `mid`, `entry-level` over `entry`).
  let bestMatch = null;
  let bestIndex = Infinity;

  for (const matcher of matchers) {
    // Match first: the graduate matcher is a COMPOUND condition (graduate AND
    // program/scheme), so its position alone would fire on a bare "Graduate
    // Engineer" that the condition itself rejects.
    if (!matcher.pattern.test(cleanTitle)) continue;
    const index = typeof matcher.pattern.levelWordIndex === 'function'
      ? matcher.pattern.levelWordIndex(cleanTitle)
      : cleanTitle.search(matcher.pattern);
    if (index < 0) continue;
    if (index < bestIndex || (index === bestIndex && matcher.weight > bestMatch.weight)) {
      bestMatch = matcher;
      bestIndex = index;
    }
  }

  return bestMatch ? bestMatch.tier : 'mid';
}

export default classifyTier;

// ── HIREWIRE ADDITION (not in the donor) ─────────────────────────────────────
//
// Hard rule 4: no output without its reason sentence. `classifyTier` returns a
// bare label, which is exactly the shape hard rule 4 forbids on screen, so the
// reason is derived here rather than written by hand at every call site.
//
// YEARS_REQUIRED is the honest half of this tool. A title is a marketing
// artifact; the years figure in the body is the actual bar. When the two
// disagree we say so, because that disagreement is the single most useful thing
// a student can learn from a posting.

/** Minimum years of experience the posting's own text asks for, or null. */
export function yearsRequired(jdText) {
  const text = String(jdText ?? '');
  const found = [];
  // "5+ years", "5-7 years", "minimum of 5 years", "at least 5 years"
  const pattern = /(\d{1,2})\s*(?:\+|\s*-\s*\d{1,2})?\s*(?:\+)?\s*(?:years?|yrs?)\b/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const n = Number(match[1]);
    // 20+ is boilerplate ("20 years in business"), 0 is noise.
    if (Number.isFinite(n) && n > 0 && n <= 15) found.push(n);
  }
  return found.length ? Math.min(...found) : null;
}

const TIER_LABEL = {
  intern: 'internship',
  entry: 'entry level',
  mid: 'mid level',
  senior: 'senior',
};

/** Years that would be unsurprising for each tier. Used only to phrase the reason. */
const TIER_YEARS_CEILING = { intern: 1, entry: 2, mid: 5, senior: 15 };

/**
 * The tier read, with the reason sentence hard rule 4 requires.
 *
 * @param {string} title
 * @param {string} jdText
 * @returns {{tier: string, label: string, years_required: number|null,
 *            mismatch: boolean, reason: string}}
 */
export function tierRead(title, jdText) {
  const tier = classifyTier(title);
  const years = yearsRequired(jdText);
  const label = TIER_LABEL[tier] ?? tier;
  const ceiling = TIER_YEARS_CEILING[tier] ?? 15;
  const mismatch = years !== null && years > ceiling;

  let reason;
  if (mismatch) {
    reason =
      `The title reads as ${label}, but the posting text asks for ${years}+ years of experience — ` +
      `more than an ${label} role normally implies, so treat the title with suspicion.`;
  } else if (years !== null) {
    reason =
      `The title reads as ${label}, and the posting asks for ${years}+ years, ` +
      `which is consistent with that.`;
  } else {
    reason =
      `The title reads as ${label}. The posting names no explicit years-of-experience ` +
      `requirement, so this is the title's own signal and nothing more.`;
  }
  return { tier, label, years_required: years, mismatch, reason };
}

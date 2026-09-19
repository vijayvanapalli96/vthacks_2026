/**
 * eligibility.mjs — the HARD GATE. Zero model calls.
 *
 * ELIGIBILITY IS A GATE, NOT A SCORE PENALTY. A role demanding a clearance the
 * student does not hold, or refusing the sponsorship they need, is not a 40%
 * match — it is NOT A MATCH. Showing it as a weak one wastes their time and
 * ours, and "apply to 200 things and hope" is the behaviour this product exists
 * to replace.
 *
 * But it is never SILENTLY dropped. Every `fail` carries an
 * `eligibility_reason`, the row is counted in `match_runs.dropped_ineligible`,
 * and the reason is written to `match_evaluations.eligibility_reason` when the
 * caller chooses to persist rejects. A filter you cannot interrogate is
 * indistinguishable from a bug — that is hard rule 4 arriving from a different
 * direction, and it is why this module returns a reason on the `pass` path too.
 *
 * THREE VERDICTS, and `unknown` is load-bearing:
 *
 *   pass     the posting states a requirement and the profile satisfies it,
 *            or the posting states no relevant requirement at all
 *   fail     the posting states a requirement the profile CANNOT satisfy
 *   unknown  we do not know the student's authorization or clearance status,
 *            or the posting's wording is ambiguous
 *
 * `unknown` does NOT drop the row. Dropping on unknown would hide most of the
 * corpus from every student who has not yet answered the voice agent's
 * authorization question — the `goals` table is written by the voice lane and is
 * legitimately empty for a brand-new account. An unknown is surfaced with its
 * reason so the UI can ask, which is the product working rather than failing.
 *
 * SECURITY: `jdText` is scraped from the open internet. It is DATA. Nothing here
 * evaluates it, and none of these strings reach SQL except as bound parameters.
 */

/** Verdicts, so callers never spell one wrong. */
export const PASS = 'pass';
export const FAIL = 'fail';
export const UNKNOWN = 'unknown';

// ── What the POSTING demands ────────────────────────────────────────────────

/**
 * Does the posting require a US security clearance?
 *
 * Deliberately specific phrases, never a bare /clearance/: postings say "no
 * clearance required" and "we will sponsor your clearance", and a bare match on
 * the word turns both into a rejection. The negative forms are checked first and
 * win, for exactly that reason.
 */
const CLEARANCE_NOT_REQUIRED_RE =
  /\b(?:no|without|not?\s+require\w*)\s+(?:(?:security|active)\s+)?clearance\b|\bclearance\s+(?:is\s+)?not\s+required\b/i;

const CLEARANCE_REQUIRED_RE = new RegExp(
  [
    // "active Secret clearance", "must hold a Top Secret clearance"
    '\\b(?:active|current|existing|must\\s+(?:hold|have|possess)|able\\s+to\\s+obtain)\\b[^.\\n]{0,40}\\bclearance\\b',
    '\\bclearance\\b[^.\\n]{0,30}\\b(?:required|is\\s+required|mandatory)\\b',
    // The named levels are themselves a requirement statement.
    '\\bTS\\s*\\/\\s*SCI\\b',
    '\\bTop\\s*Secret\\b',
    '\\bSCI\\s+eligib\\w*',
    '\\bpolygraph\\b',
    '\\bpublic\\s+trust\\s+clearance\\b',
    '\\bDoD\\s+(?:secret|security)\\s+clearance\\b',
  ].join('|'),
  'i',
);

/** The clearance LEVEL the posting names, or null. Used only in reason strings. */
function statedClearanceLevel(jdText) {
  if (/\bTS\s*\/\s*SCI\b/i.test(jdText)) return 'TS/SCI';
  if (/\bTop\s*Secret\b/i.test(jdText)) return 'Top Secret';
  if (/\bactive\s+secret\b/i.test(jdText)) return 'active Secret';
  if (/\bpublic\s+trust\b/i.test(jdText)) return 'Public Trust';
  if (/\bsecret\s+clearance\b/i.test(jdText)) return 'Secret';
  return null;
}

/**
 * Does the posting REFUSE visa sponsorship?
 *
 * THIS IS THE TRAP IN THIS WHOLE MODULE, and the first version of it was wrong.
 * "We are unable to PROVIDE visa SPONSORSHIP" and "we PROVIDE SPONSORSHIP" differ
 * by one word that is nowhere near the keyword. Matching a refusal pattern and an
 * offer pattern independently and letting the offer cancel meant the refusal above
 * was read as an offer, because it contains the exact substring "provide visa
 * sponsorship". A keyword pair cannot express polarity.
 *
 * So the stance is read PER SENTENCE and per OCCURRENCE, in a window around each
 * mention of "sponsor": negation anywhere in the 60 characters BEFORE it, or in
 * the 25 characters AFTER it, makes that mention a refusal.
 *
 * The two window sizes are different on purpose. Before: "must be authorized to
 * work in the United States WITHOUT sponsorship" puts the negation far to the
 * left, so the window has to be generous. After: "SPONSORSHIP is NOT available"
 * puts it just to the right, but "Sponsorship is available for this role, NO
 * exceptions" puts an unrelated "no" about forty characters to the right — so the
 * right-hand window is deliberately too short to reach it.
 */
const SPONSOR_WORD_RE = /sponsor\w*/gi;

const NEGATION_RE =
  /\b(?:not|un(?:able|willing)|cannot|can\s*not|can't|won't|does\s*n[o']t|do\s*n[o']t|do\s+not|does\s+not|will\s+not|no|without|never|neither|nor|lack\w*|ineligible|unavailable)\b/i;

const NEG_WINDOW_BEFORE = 60;
const NEG_WINDOW_AFTER = 25;

/**
 * 'refused' | 'offered' | 'mixed' | 'silent'
 *
 * 'mixed' is a real outcome, not a bug: a posting that both refuses and offers
 * sponsorship in different sentences is genuinely ambiguous, and the gate answers
 * `unknown` for it rather than picking one. Guessing "refused" would drop a role
 * the student might be eligible for; guessing "offered" would recommend one they
 * are not.
 */
function sponsorshipStance(jdText) {
  const text = String(jdText ?? '');
  let refused = false;
  let offered = false;
  for (const m of text.matchAll(SPONSOR_WORD_RE)) {
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - NEG_WINDOW_BEFORE), start);
    const after = text.slice(start + m[0].length, start + m[0].length + NEG_WINDOW_AFTER);
    // Do not read across a sentence boundary: the previous sentence's "no" says
    // nothing about this sentence's sponsorship clause.
    const beforeClause = before.split(/[.\n;]/).pop() ?? '';
    const afterClause = after.split(/[.\n;]/)[0] ?? '';
    if (NEGATION_RE.test(beforeClause) || NEGATION_RE.test(afterClause)) refused = true;
    else offered = true;
  }
  if (refused && offered) return 'mixed';
  if (refused) return 'refused';
  if (offered) return 'offered';
  return 'silent';
}

/** Does the posting require US citizenship outright? Stricter than sponsorship. */
const CITIZENSHIP_REQUIRED_RE =
  /\b(?:must\s+be\s+a?\s*|require\w*\s+)?U\.?S\.?\s+citizen(?:ship)?\b[^.\n]{0,30}\b(?:required|only|is\s+required|mandatory)\b|\bmust\s+be\s+a\s+U\.?S\.?\s+citizen\b|\bU\.?S\.?\s+citizenship\s+(?:is\s+)?required\b/i;

// ── What the PROFILE can satisfy ─────────────────────────────────────────────

/**
 * Normalise `goals.work_authorization` free text.
 *
 * `goals` is written by the VOICE lane and is empty in the workspace today, so
 * there is no observed value set to code against. I chose a tolerant classifier
 * over a strict enum because the alternative — assuming an enum the other lane
 * has not agreed to — fails closed on every real value that does not match, and
 * failing closed here means dropping roles a student is eligible for. If the
 * voice lane later settles an enum, the enum values already fall out of these
 * patterns.
 *
 * @param {string|null|undefined} value
 * @returns {{needsSponsorship: boolean|null, isCitizen: boolean|null, raw: string|null}}
 */
export function classifyWorkAuthorization(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : null;
  if (!raw) return { needsSponsorship: null, isCitizen: null, raw: null };
  const v = raw.toLowerCase();

  // Checked first: a green-card holder or citizen needs no sponsorship even if
  // the sentence also contains the word "visa".
  if (/\b(?:us\s*citizen|u\.s\.\s*citizen|citizen)\b/.test(v)) {
    return { needsSponsorship: false, isCitizen: true, raw };
  }
  if (/\b(?:green\s*card|permanent\s*resident|lpr|gc\s*holder)\b/.test(v)) {
    return { needsSponsorship: false, isCitizen: false, raw };
  }
  if (/\b(?:no\s+sponsorship\s+(?:needed|required)|authorized|eligible\s+to\s+work)\b/.test(v)) {
    return { needsSponsorship: false, isCitizen: false, raw };
  }
  if (/\b(?:h-?1b|h1-?b|opt|cpt|stem\s*opt|f-?1|j-?1|tn\s*visa|sponsor\w*|international\s+student|requires?\s+visa)\b/.test(v)) {
    return { needsSponsorship: true, isCitizen: false, raw };
  }
  return { needsSponsorship: null, isCitizen: null, raw };
}

/**
 * Normalise `goals.clearance`.
 * @param {string|null|undefined} value
 * @returns {{hasClearance: boolean|null, level: string|null, raw: string|null}}
 */
export function classifyClearance(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : null;
  if (!raw) return { hasClearance: null, level: null, raw: null };
  const v = raw.toLowerCase();
  if (/\b(?:none|no|n\/a|not?\s+applicable|never)\b/.test(v)) {
    return { hasClearance: false, level: null, raw };
  }
  if (/\bts\s*\/?\s*sci\b/.test(v)) return { hasClearance: true, level: 'TS/SCI', raw };
  if (/\btop\s*secret\b/.test(v)) return { hasClearance: true, level: 'Top Secret', raw };
  if (/\bsecret\b/.test(v)) return { hasClearance: true, level: 'Secret', raw };
  if (/\bpublic\s*trust\b/.test(v)) return { hasClearance: true, level: 'Public Trust', raw };
  return { hasClearance: null, level: null, raw };
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * Decide whether a student may actually be considered for a posting.
 *
 * Order matters and is deliberate: CLEARANCE first, then CITIZENSHIP, then
 * SPONSORSHIP. Each is stricter than the next, and the reason string should name
 * the hardest barrier rather than the first one found — a TS/SCI role that also
 * refuses sponsorship should say "clearance", because that is the blocker the
 * student cannot fix by changing employer.
 *
 * @param {{jdText?: string|null}} job
 * @param {{work_authorization?: string|null, clearance?: string|null}} goals
 * @returns {{eligibility: 'pass'|'fail'|'unknown', reason: string}}
 */
export function evaluateEligibility(job, goals) {
  const jd = String(job?.jdText ?? '');
  const auth = classifyWorkAuthorization(goals?.work_authorization);
  const clr = classifyClearance(goals?.clearance);

  const demandsClearance =
    CLEARANCE_REQUIRED_RE.test(jd) && !CLEARANCE_NOT_REQUIRED_RE.test(jd);

  if (demandsClearance) {
    const level = statedClearanceLevel(jd) ?? 'a US security';
    if (clr.hasClearance === false) {
      return {
        eligibility: FAIL,
        reason: `Posting requires ${level} clearance; profile records no clearance.`,
      };
    }
    if (clr.hasClearance === null) {
      return {
        eligibility: UNKNOWN,
        reason: `Posting requires ${level} clearance and the profile does not state a clearance status. Not filtered — ask before applying.`,
      };
    }
    // Holds one. We deliberately do NOT compare levels: a Secret holder is
    // routinely eligible to be submitted for a TS role and upgraded, so ranking
    // that as a fail would drop real matches. Say what we checked instead.
    return {
      eligibility: PASS,
      reason: `Posting requires ${level} clearance; profile records ${clr.level ?? clr.raw}.`,
    };
  }

  const demandsCitizenship = CITIZENSHIP_REQUIRED_RE.test(jd);
  if (demandsCitizenship) {
    if (auth.isCitizen === true) {
      return { eligibility: PASS, reason: 'Posting requires US citizenship; profile states US citizen.' };
    }
    if (auth.isCitizen === false) {
      return {
        eligibility: FAIL,
        reason: `Posting requires US citizenship; profile states work authorization "${auth.raw}".`,
      };
    }
    return {
      eligibility: UNKNOWN,
      reason: 'Posting requires US citizenship and the profile does not state citizenship. Not filtered — ask before applying.',
    };
  }

  const stance = sponsorshipStance(jd);
  if (stance === 'mixed' && auth.needsSponsorship === true) {
    return {
      eligibility: UNKNOWN,
      reason: 'Posting both refuses and offers visa sponsorship in different sentences; profile needs sponsorship. Not filtered — confirm with the employer before applying.',
    };
  }
  if (stance === 'refused') {
    if (auth.needsSponsorship === true) {
      return {
        eligibility: FAIL,
        reason: `Posting states it will not sponsor a visa; profile states work authorization "${auth.raw}", which needs sponsorship.`,
      };
    }
    if (auth.needsSponsorship === null) {
      return {
        eligibility: UNKNOWN,
        reason: 'Posting states it will not sponsor a visa and the profile does not state work authorization. Not filtered — ask before applying.',
      };
    }
    return {
      eligibility: PASS,
      reason: 'Posting will not sponsor a visa; profile needs no sponsorship.',
    };
  }

  // Nothing in the posting gates on authorization or clearance. That is a real
  // pass, and saying so is not padding: an empty reason string next to a `pass`
  // reads as "not checked", which is the ambiguity this module exists to remove.
  if (auth.raw === null && clr.raw === null) {
    return {
      eligibility: PASS,
      reason: 'Posting states no clearance, citizenship or sponsorship requirement.',
    };
  }
  return {
    eligibility: PASS,
    reason: 'Posting states no clearance, citizenship or sponsorship requirement the profile cannot meet.',
  };
}

/**
 * jd-similarity.mjs — LIFTED VERBATIM from the career-ops donor repo.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * Source:  career-ops/jd-similarity.mjs  (v1.33.0)
 * License: MIT — Copyright (c) 2026 Santiago Fernández de Valderrama
 *          <hi@santifer.io> · https://santifer.io
 * career-ops is a DONOR REPO, not a dependency. The file is copied, never
 * imported across the repo boundary, and `../career-ops/` is never edited.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * WHAT CHANGED, and nothing else changed: the `fs` import, the
 * `./lib/is-main-module.mjs` import, and the CLI block that read two file paths
 * off `process.argv` are gone. The donor's `fs` use was ONLY on the CLI path —
 * `tokenize`, `jaccardSimilarity`, `hardMismatch` and `recommendCvReuse` are
 * pure string functions and are byte-identical here, including the Chinese
 * stop-words and level words, which we keep rather than "cleaning up": a JD
 * scraped from a US board can still carry them, and removing vocabulary from a
 * classifier is how you silently change its output.
 *
 * WHAT THIS NUMBER IS, and is not. This is JACCARD similarity over tokens —
 * literal word overlap between the posting text and the student's own written
 * profile. It is NOT the match score on the dashboard, which is a cosine
 * similarity over `databricks-gte-large-en` embeddings followed by a model
 * rerank. Two different numbers measuring two different things, and the UI must
 * say which is which; labelling text overlap as "fit" would be hard rule 8
 * (don't overclaim) broken by a tooltip.
 */

const STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'that', 'this', 'have', 'will', 'you',
  'your', 'our', 'are', 'not', 'to', 'of', 'in', 'on', 'or', 'a', 'an',
  '负责', '岗位', '工作', '相关', '具备', '以及', '能够', '进行', '通过', '需要',
]);

const LEVELS = [
  ['intern', '实习', '实习生', '应届'],
  ['junior', '初级'],
  ['mid', '中级'],
  ['senior', '高级', '资深'],
  ['staff', 'principal', 'lead', '负责人'],
];

/** Tokenize JD/CV text into normalized, stop-word-filtered terms. */
export function tokenize(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .match(/[\p{L}\p{N}+#./-]+/gu)
      ?.map(token => token.replace(/^[./-]+|[./-]+$/g, ''))
      .filter(token => token && (token.length > 1 || /\d/.test(token)) && !STOP_WORDS.has(token)) || [],
  );
}

/** Calculate Jaccard similarity between two texts or token sets. */
export function jaccardSimilarity(left, right) {
  const a = left instanceof Set ? left : tokenize(left);
  const b = right instanceof Set ? right : tokenize(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Level words that are also ordinary English, mapped to the words that follow
 * them in their NON-seniority sense. JD boilerplate is full of these: "Principal
 * responsibilities" means "main duties", "mid-market" is a customer segment, and
 * "lead" is usually a verb. Matching them as job levels made the gate below fire
 * on postings of identical seniority.
 *
 * Only the trailing word is inspected: "Principal Engineer" and "Lead Engineer"
 * stay levels because `engineer` is not in any of these lists.
 */
const NON_LEVEL_FOLLOWERS = {
  principal: ['responsibilities', 'responsibility', 'duties', 'accountabilities', 'objectives', 'purpose', 'tasks', 'activities'],
  lead: ['to', 'the', 'a', 'an', 'our', 'and', 'or', 'by', 'on', 'in', 'for', 'with', 'from', 'mentoring', 'projects'],
  mid: ['market', 'size', 'sized', 'cap', 'tier', 'funnel', 'term', 'sized-company'],
};

/** Whether a level word at `index` reads as a job level rather than plain English. */
function readsAsLevel(word, normalized, index) {
  const followers = NON_LEVEL_FOLLOWERS[word];
  if (!followers) return true;
  const after = normalized.slice(index + word.length).match(/^[^a-z0-9]*([a-z0-9-]+)/);
  return !after || !followers.includes(after[1]);
}

/**
 * Every distinct seniority level named in the text, as LEVELS indices.
 *
 * Returns ALL of them rather than the first: a document may name several (a CV
 * showing career progression names each rank it held), and `findIndex` used to
 * collapse that to whichever appeared earliest in the LEVELS table — reading a
 * junior-to-senior CV as junior.
 */
function levelsIn(text) {
  const normalized = String(text ?? '').toLowerCase();
  const found = new Set();
  LEVELS.forEach((words, level) => {
    for (const word of words) {
      if (/^[\p{Script=Han}]+$/u.test(word)) {
        if (normalized.includes(word)) { found.add(level); break; }
        continue;
      }
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, 'gi');
      let match;
      while ((match = pattern.exec(normalized)) !== null) {
        if (readsAsLevel(word, normalized, match.index + match[0].length - word.length)) {
          found.add(level);
          break;
        }
      }
      if (found.has(level)) break;
    }
  });
  return found;
}

/**
 * Detect the seniority level of a document, or -1 when it has no single
 * unambiguous one. Naming several levels counts as ambiguous, NOT as the lowest
 * one: the gate below exists to catch a clear level difference, and a guess is
 * worse than standing down and letting the similarity score decide.
 */
function levelOf(text) {
  const levels = levelsIn(text);
  return levels.size === 1 ? [...levels][0] : -1;
}

/** Return whether the new JD and previous document have different seniority levels. */
export function hardMismatch(newJd, previousText) {
  const newLevel = levelOf(newJd);
  const previousLevel = levelOf(previousText);
  return newLevel >= 0 && previousLevel >= 0 && newLevel !== previousLevel;
}

/** Recommend CV reuse, reuse with edits, or regeneration for a new JD. */
export function recommendCvReuse(newJd, previousText, options = {}) {
  const score = jaccardSimilarity(newJd, previousText);
  const high = Number(options.highThreshold ?? 0.72);
  const medium = Number(options.mediumThreshold ?? 0.45);
  if (hardMismatch(newJd, previousText)) {
    return { decision: 'regenerate', score, reason: 'level-mismatch' };
  }
  if (score >= high) return { decision: 'reuse', score, reason: 'high-similarity' };
  if (score >= medium) return { decision: 'reuse-with-edits', score, reason: 'medium-similarity' };
  return { decision: 'regenerate', score, reason: 'low-similarity' };
}

// ── HIREWIRE ADDITION (not in the donor) ─────────────────────────────────────

/**
 * The donor's `reason` field is a machine tag (`low-similarity`). Hard rule 4
 * wants an English sentence, and this one has to carry the caveat: the number
 * measures WORD OVERLAP, and a low overlap against a genuinely good match is
 * normal, because a student's profile and a company's boilerplate are written in
 * different registers. Presenting Jaccard as "fit" without that sentence would
 * be the single most misleading number on the page.
 *
 * @param {string} jdText the posting, untrusted, read only as text
 * @param {string} profileText the student's own summary + bullets
 * @returns {{percent: number, decision: string, tag: string, reason: string}}
 */
export function textOverlapRead(jdText, profileText) {
  const { decision, score, reason: tag } = recommendCvReuse(jdText, profileText);
  const percent = Math.round(score * 1000) / 10;
  const shared = (() => {
    const a = tokenize(jdText);
    const b = tokenize(profileText);
    let n = 0;
    for (const t of a) if (b.has(t)) n++;
    return n;
  })();

  const head =
    `${percent}% of the words in this posting and your written profile are shared ` +
    `(${shared} terms in common).`;
  const tail =
    tag === 'level-mismatch'
      ? ' The two also name different seniority levels, which matters more than the percentage.'
      : ' This is literal word overlap, not the match score — the match score is a semantic' +
        ' embedding comparison and the two numbers will not agree.';

  return { percent, decision, tag, reason: head + tail };
}

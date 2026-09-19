/**
 * skill-aliases.mjs — HIREWIRE's additions to career-ops' skill vocabulary.
 *
 * A separate file rather than an edit to `skill-extract.mjs`, on purpose.
 * `skill-extract.mjs` is a VERBATIM copy of a donor file (CLAUDE.md: copy the
 * `.mjs` files we need and keep the attribution; do not edit them). Editing it
 * would make the next re-copy silently drop our additions, which is exactly the
 * drift that file's own header spends 300 lines warning about. So the additions
 * live here and wrap it.
 *
 * WHY ANY ADDITIONS AT ALL. career-ops' vocabulary is tuned for a senior
 * engineer's CV, and it has one gap that matters for a STUDENT corpus: the short
 * everyday spellings. A resume says "JS, React, Node" and a posting says
 * "JavaScript, React, Node.js". Under the donor vocabulary alone, `JS` extracts as
 * a token, canonicalizes to itself, finds no match, and lands in `skills_missing`
 * — which is the column the coursework lever will later aggregate, so the noise
 * becomes a wrong course recommendation. Both sides of the comparison are run
 * through the same map here, which is the only way aliases ever help: alias one
 * side only and you move the mismatch rather than fixing it.
 *
 * THE OMISSIONS ARE THE INTERESTING PART, and they follow the donor's own
 * asymmetry rule — a missing alias costs one real skill once, visibly, while a
 * colliding one mints a phantom skill out of ordinary prose on every posting:
 *
 *   'TS'  — TypeScript in a stack list, but **TS/SCI** in a cleared posting, and
 *           this corpus has cleared postings. Aliasing it would read "Top Secret
 *           clearance required" as "knows TypeScript". That is not a near miss:
 *           it is the eligibility gate and the skill map being wrong in opposite
 *           directions from one token. `TypeScript` is already in the donor
 *           vocabulary, so the skill is recognised whenever it is spelled out.
 *   'GO'  — handled case-sensitively by the donor's own GO_SKILL_PATTERN, for the
 *           same everyday-word reason. Nothing to add.
 *   'C'   — the language, and also a letter, a grade, and "C-level".
 *   'R'   — the language, and also "R&D", "HR", and a bullet numbering scheme.
 *   'AI'/'ML' — already in the donor list where they belong; as ALIASES they would
 *           map two of the broadest words in tech onto specific tools.
 */
import {
  CANONICAL,
  DISPLAY,
  SKILL_PATTERN,
  SKILL_TOKENS,
  canonicalize as donorCanonicalize,
  extractSkills as donorExtractSkills,
} from './skill-extract.mjs';

/**
 * lowercased spelling -> the donor's display name for the SAME skill.
 *
 * Every value here must already be a name the donor vocabulary produces, so an
 * alias can cancel a JD requirement. A value the donor never emits would create a
 * private third name for one skill and split the very counts this map exists to
 * merge.
 */
export const EXTRA_ALIASES = {
  js: 'JavaScript',
  'java script': 'JavaScript',
  node: 'Node.js',
  'node js': 'Node.js',
  reactjs: 'React',
  'react js': 'React',
  py: 'Python',
  python3: 'Python',
  psql: 'PostgreSQL',
  'postgre sql': 'PostgreSQL',
  mongo: 'MongoDB',
  k8: 'Kubernetes',
  sklearn: 'scikit-learn',
  'sci-kit learn': 'scikit-learn',
  huggingface: 'Hugging Face',
  pytorch: 'PyTorch',
  tf: 'TensorFlow', // safe here and nowhere else: see the note below.
  'ci cd': 'CI/CD',
  cicd: 'CI/CD',
  gha: 'GitHub Actions',
  'amazon web services': 'AWS',
  'google cloud': 'GCP',
  'google cloud platform': 'GCP',
  'microsoft azure': 'Azure',
  golang: 'Go',
  'large language models': 'LLMs',
  'large language model': 'LLMs',
  'natural language processing': 'NLP',
  'retrieval augmented generation': 'RAG',
  'retrieval-augmented generation': 'RAG',
};

// 'tf' note: Terraform also abbreviates to "tf" (the file extension), and in an
// infrastructure posting that is the likelier reading. It is kept because
// TensorFlow is what a student's resume abbreviates and Terraform postings
// overwhelmingly spell "Terraform" out — but it is the one entry in this map whose
// collision is real rather than theoretical, and if a Terraform posting ever shows
// up scored as an ML match, this is the line to delete.

/**
 * Canonical form of a single raw token, HIREWIRE vocabulary.
 *
 * Order matters: our aliases are consulted BEFORE the donor's, so an entry here
 * can correct one there. Unknown tokens still pass through UNCHANGED — there is
 * no umbrella aliasing, because "cloud" must never count as knowing AWS.
 *
 * @param {string} token
 * @returns {string}
 */
export function canonicalizeSkill(token) {
  if (typeof token !== 'string') return '';
  const key = token.trim().toLowerCase();
  if (!key) return '';
  return EXTRA_ALIASES[key] ?? donorCanonicalize(token.trim());
}

// A second pass for the multi-word and short aliases above, which by construction
// are NOT in the donor's SKILL_PATTERN. Longest first so "google cloud platform"
// wins over "google cloud"; (?<!\w)/(?!\w) rather than \b because the map contains
// hyphens and dots, where \b asserts the opposite of the intent.
const EXTRA_PATTERN = new RegExp(
  '(?<!\\w)(?:' +
    Object.keys(EXTRA_ALIASES)
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|') +
    ')(?!\\w)',
  'gi',
);

/**
 * Every canonical skill name present in a blob, donor vocabulary PLUS our aliases.
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractSkillsExtended(text) {
  const found = donorExtractSkills(text);
  if (typeof text === 'string' && text) {
    for (const m of text.matchAll(EXTRA_PATTERN)) found.add(canonicalizeSkill(m[0]));
  }
  return found;
}

export { CANONICAL, DISPLAY, SKILL_PATTERN, SKILL_TOKENS };

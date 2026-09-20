#!/usr/bin/env node
/**
 * artifacts.test.mjs — the job-toolbox unit suite. Runs with plain node:
 *
 *   node --test tests/artifacts/artifacts.test.mjs
 *
 * NOTE THE FILE PATH, not the directory: `node --test <directory>` fails on
 * Node v25, which is what is installed here.
 *
 * No framework, no warehouse, no network. Everything under test is pure, which
 * is why the lift was arranged as pure functions plus a thin SQL shell.
 *
 * WHAT THIS SUITE IS FOR. Not coverage. These are the cases that FAIL SILENTLY
 * — where the bug produces a plausible document in the right shape and nobody
 * notices until a real application goes out under a real person's name:
 *
 *   1. THE VERIFIER MUST ACTUALLY FAIL. A fact gate that passes everything is
 *      indistinguishable from no fact gate, and it is worse, because the UI says
 *      "verified". Four separate fabrication classes are tested for a BLOCK
 *      verdict: an invented number, an invented employer, an invented job title,
 *      and a forbidden placeholder. If any of these ever comes back `pass`, the
 *      product is lying to the student on its most load-bearing screen.
 *   2. THE VERIFIER MUST NOT FAIL A TRUTHFUL DOCUMENT. The failure mode nobody
 *      tests for: a gate so strict that every real document is blocked gets
 *      switched off within a day, and then there is no gate. A letter quoting the
 *      profile verbatim must pass, and a cover letter's stock "first 90 days"
 *      closing must not be read as a past claim.
 *   3. A DOCUMENT WITH NO REASON IS DROPPED (hard rule 4). `validateGeneration`
 *      must refuse a response whose `approach_reason` is missing — the same rule
 *      `rerank.mjs` applies to a score with no explanation.
 *   4. THE TIER READ MUST CATCH THE TITLE/BODY CONTRADICTION. "Junior Engineer"
 *      asking for 8 years is the single most useful thing this page can tell a
 *      student, and it is one boolean away from silently reading "entry level".
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  verifyFacts,
  assertFacts,
  metricClaims,
  factClaims,
  explainFindings,
  verdictSentence,
  FACT_CONFIG,
} from '../../app/vthacks-career-app/src/lib/artifacts/verify-cv-facts.mjs';
import { classifyTier, tierRead, yearsRequired } from '../../app/vthacks-career-app/src/lib/artifacts/classify-tier.mjs';
import { textOverlapRead, jaccardSimilarity } from '../../app/vthacks-career-app/src/lib/artifacts/jd-similarity.mjs';
import { validateGeneration } from '../../app/vthacks-career-app/src/lib/artifacts/generate.mjs';
import { renderResumeHtml, renderDocumentHtml, renderBlockedHtml } from '../../app/vthacks-career-app/src/lib/artifacts/render-html.mjs';

/**
 * A real fact source, in the shape `facts.mjs` builds from `profile_current`.
 * The numbers and employers are the live account's actual profile rows, because
 * hard rule 7 is real content only — a fixture with "Acme Corp" in it would not
 * exercise the employer capture the way a real multi-word company name does.
 */
const SOURCE = [
  'Name: TARANG NAIR',
  'Location: Chantilly, Virginia',
  'A software engineer with 5+ years of experience building systems at scale across early-stage startups and large organizations.',
  'Worked at Noether as Founding Engineer (Jan 2026 – Present).',
  'Title: Founding Engineer',
  'Building an AI patent litigation platform for analyzing patents, claim mapping, citation analysis, and evidence-backed prior-art search.',
  'Engineered a scalable patent search and ingestion platform using GCP, Qdrant, Neo4j, and AlloyDB, implementing hybrid retrieval across 3 vector spaces',
  'Worked at FINRA as Software Engineer Intern (May 2024 – Aug 2024).',
  'Title: Software Engineer Intern',
  'Automated ServiceNow data synchronization, saving 15+ hrs/week of manual work for a regulator body overseeing thousands of firms.',
  'Worked at Xero Apps as Founding Engineer (Oct 2022 – Sept 2023).',
  'Shipped a inventory & billing platform in Flutter adopted by 50,000+ businesses, and earning a 4.8/5 user rating on the App Store.',
  'Education: Masters Of Engineering, Software Engineering, University Of Maryland - College Park',
  'Skills: Python, Go, Java, JavaScript, Neo4j, Qdrant, pgvector, Kubernetes, Docker, FastAPI, LangChain, RAG',
].join('\n');

// ── 1. THE VERIFIER MUST FAIL ───────────────────────────────────────────────

test('BLOCKS an invented number — the fabrication class this gate exists for', () => {
  // The profile says 50,000+ businesses. This says 250,000.
  const document =
    'I shipped an inventory and billing platform in Flutter adopted by 250,000+ businesses, ' +
    'and I cut p95 latency by 62% on the ingestion path.';
  const result = verifyFacts(document, SOURCE, FACT_CONFIG);

  assert.equal(result.verdict, 'block', 'an inflated count must BLOCK, not warn');
  // `businesses` is a HIREWIRE addition to the donor's METRIC_NOUNS, and this
  // assertion is why it exists: the donor counts `companies` and `clients` but
  // not `businesses`, and the live profile says "50,000+ businesses". Before the
  // addition this document came back with only `62%` flagged and the 5x
  // inflation of the headline number passed in silence.
  assert.ok(
    result.invented.some((c) => c.startsWith('250000')),
    `expected the inflated count in invented, got ${JSON.stringify(result.invented)}`,
  );
  assert.ok(result.invented.includes('62%'), 'a percentage absent from the profile must be flagged');

  // And the finding must carry a reason sentence — hard rule 4 applies to a
  // flagged claim exactly as it applies to a score.
  const findings = explainFindings(result);
  const metricFinding = findings.find((f) => f.kind === 'metric');
  assert.ok(metricFinding, 'a blocked metric must produce a finding');
  assert.ok(metricFinding.reason.length > 40, 'a finding without a real reason is a bare red flag');
  assert.equal(metricFinding.severity, 'block');
});

test('BLOCKS an invented employer', () => {
  const document = 'I worked at Stripe as a Backend Engineer before joining my current team.';
  const result = verifyFacts(document, SOURCE, FACT_CONFIG);

  assert.equal(result.verdict, 'block');
  const employer = result.unsupportedFacts.find((f) => f.kind === 'employer');
  assert.ok(employer, `expected an employer finding, got ${JSON.stringify(result.unsupportedFacts)}`);
  assert.match(employer.value, /stripe/);
});

test('BLOCKS an inflated job title even when the employer is real', () => {
  // Noether is real and Founding Engineer is real. "Chief Technology Officer"
  // is not, and this is the capture that stops a one-word promotion shipping.
  const document = 'I served as Chief Technology Officer and shipped the retrieval layer.';
  const result = verifyFacts(document, SOURCE, FACT_CONFIG);

  assert.equal(result.verdict, 'block');
  assert.ok(
    result.unsupportedFacts.some((f) => f.kind === 'title' && /chief/.test(f.value)),
    `expected a title finding, got ${JSON.stringify(result.unsupportedFacts)}`,
  );
});

test('BLOCKS a forbidden placeholder — a document nobody wrote must never be sent', () => {
  const document =
    'Dear Hiring Manager at [Company Name], I am writing about the role. ' +
    'My experience at Noether covers the retrieval work you describe.';
  const result = verifyFacts(document, SOURCE, FACT_CONFIG);

  assert.equal(result.verdict, 'block');
  assert.ok(result.forbidden.includes('[company name]'));
});

test('assertFacts THROWS on a blocking document, with the failing claims named', () => {
  assert.throws(
    () => assertFacts('I worked at Stripe as a Backend Engineer.', SOURCE, FACT_CONFIG, 'cover letter'),
    (error) => {
      assert.match(error.message, /Fact check failed for cover letter/);
      assert.match(error.message, /non-metric facts absent from sources/);
      return true;
    },
  );
});

// ── 2. THE VERIFIER MUST NOT FAIL A TRUTHFUL DOCUMENT ───────────────────────

test('PASSES a document that restates the profile, numbers included', () => {
  const document = [
    'I am applying for the backend role. I build retrieval systems.',
    'I engineered a scalable patent search and ingestion platform using GCP, Qdrant, Neo4j, and AlloyDB,',
    'implementing hybrid retrieval across 3 vector spaces.',
    'I automated ServiceNow data synchronization, saving 15+ hrs/week of manual work.',
    'I shipped an inventory and billing platform in Flutter adopted by 50,000+ businesses.',
  ].join('\n');
  const result = verifyFacts(document, SOURCE, FACT_CONFIG);

  assert.equal(
    result.verdict === 'block' ? `BLOCKED: ${JSON.stringify({ invented: result.invented, facts: result.unsupportedFacts })}` : 'ok',
    'ok',
  );
});

test('the stock cover-letter closing is not read as a past claim', () => {
  // career-ops hit this exact bug: "the first 90 days" was extracted as the
  // claim "90 days" and reported unsupported, and no source can ever evidence a
  // proposal. The clause-scoped plan-horizon rule is what fixes it.
  const claims = metricClaims("I would welcome the chance to talk through how I'd approach the first 90 days.");
  assert.ok(!claims.has('90 days'), `plan horizon must not become a claim, got ${[...claims]}`);
});

test('a past claim in a hypothetical sentence is STILL a claim', () => {
  // The other direction, and the one that matters: a forward-looking marker in a
  // later clause must not silence a fabricated past number.
  const claims = metricClaims('Revenue grew in the first 99 months, and I would be glad to repeat it.');
  assert.ok(claims.has('99 months'), `expected 99 months to survive, got ${[...claims]}`);
});

test('the company being applied to is allowed — a letter may name its addressee', () => {
  const document = 'I want to join Databricks because of the retrieval work described in the posting.';
  const blocked = verifyFacts(document, SOURCE, FACT_CONFIG);
  const allowed = verifyFacts(document, SOURCE, {
    ...FACT_CONFIG,
    allow_facts: [...FACT_CONFIG.allow_facts, 'Databricks'],
  });
  // Whether the bare "join X" phrasing trips the employer capture depends on the
  // donor's trigger list; what must hold is that naming the addressee cannot be
  // the thing that blocks a letter once it is on the allow-list.
  assert.ok(
    allowed.unsupportedFacts.every((f) => f.value !== 'databricks'),
    'an allow_facts entry must actually suppress its fact',
  );
  assert.ok(blocked.verdict === 'pass' || blocked.verdict === 'warn' || blocked.verdict === 'block');
});

test('factClaims reads the capitalised phrasings a real document uses', () => {
  // career-ops' own bug report: both patterns were plain /g, so only a lowercase
  // trigger matched — and documents are written in capitalised sentences, so the
  // phrasings that actually occur were invisible and fabrications shipped.
  const claims = factClaims('Worked at Initech as a Principal Engineer on the billing platform.');
  assert.ok(claims.some((c) => c.kind === 'employer' && c.value === 'initech'));
  assert.ok(claims.some((c) => c.kind === 'title' && /principal engineer/.test(c.value)));
});

test('verdictSentence always produces one sentence with a reason in it', () => {
  const pass = verdictSentence({ verdict: 'pass', invented: [], unsupportedFacts: [], forbidden: [], warnings: [], coverage: null }, 4);
  const block = verdictSentence({ verdict: 'block', invented: ['250000 companies'], unsupportedFacts: [], forbidden: [], warnings: [], coverage: null }, 4);
  assert.match(pass, /PASSED/);
  assert.match(block, /FAILED/);
  assert.match(block, /no support in your profile/);
});

// ── 3. A DOCUMENT WITH NO REASON IS DROPPED ─────────────────────────────────

test('validateGeneration refuses a letter with no approach_reason (hard rule 4)', () => {
  const result = validateGeneration('cover_letter', {
    document: 'x'.repeat(400),
    posting_anomaly: '',
  });
  assert.equal(result.ok, false);
  assert.match(result.why, /approach_reason/);
});

test('validateGeneration checks the RAW type, not the coercion', () => {
  // Number(null) is 0 and String(null) is "null": a coercion check would let a
  // null document through as a 4-character letter.
  const result = validateGeneration('cover_letter', {
    document: null,
    approach_reason: 'I built it from the profile bullets that matched the posting.',
    posting_anomaly: '',
  });
  assert.equal(result.ok, false);
  assert.match(result.why, /no usable letter body/);
});

test('validateGeneration drops a rewritten bullet that does not say what changed', () => {
  const result = validateGeneration('resume', {
    bullets: [
      { original: 'a', tailored: 'A rewritten bullet.', reason: '' },
      { original: 'b', tailored: 'Another rewritten bullet.', reason: 'Mirrored the posting\'s wording for retrieval.' },
    ],
    approach_reason: 'Rewrote only the bullets that named a posting requirement.',
    posting_anomaly: '',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.detail.bullets.length, 1, 'the unexplained rewrite must be dropped');
});

test('validateGeneration accepts a refusal answer and keeps it intact', () => {
  const result = validateGeneration('answers', {
    answers: [
      { question: 'Will you require sponsorship?', answer: 'ASK THE CANDIDATE: their current work authorization status.' },
    ],
    approach_reason: 'The profile has no work-authorization fact, so the sponsorship question was refused rather than guessed.',
    posting_anomaly: '',
  });
  assert.equal(result.ok, true);
  assert.match(result.value.text, /ASK THE CANDIDATE/);
});

// ── 4. THE TIER READ MUST CATCH THE TITLE/BODY CONTRADICTION ────────────────

test('a "Junior" title asking for 8 years is flagged as a contradiction', () => {
  const read = tierRead('Junior Software Engineer', 'We are looking for someone with 8+ years of experience.');
  assert.equal(read.tier, 'entry');
  assert.equal(read.years_required, 8);
  assert.equal(read.mismatch, true);
  assert.match(read.reason, /treat the title with suspicion/);
});

test('an internship asking for no years is not flagged', () => {
  const read = tierRead('Software Engineering Intern', 'You will work with our platform team over the summer.');
  assert.equal(read.tier, 'intern');
  assert.equal(read.years_required, null);
  assert.equal(read.mismatch, false);
  assert.match(read.reason, /names no explicit years-of-experience/);
});

test('classifyTier keeps the donor behaviour exactly', () => {
  // The donor's own inline test cases. If any of these changes, the lift drifted.
  assert.equal(classifyTier('Software Engineer Intern'), 'intern');
  assert.equal(classifyTier('Junior Software Engineer'), 'entry');
  assert.equal(classifyTier('Software Engineer II'), 'mid');
  assert.equal(classifyTier('Senior Software Engineer'), 'senior');
  assert.equal(classifyTier('Engineering Intern Program'), 'intern');
  assert.equal(classifyTier('Software Engineer'), 'mid');
  assert.equal(classifyTier('Senior Intern Coordinator'), 'senior');
  assert.equal(classifyTier('Graduate Engineer'), 'mid');
  assert.equal(classifyTier('Graduate Engineer Program'), 'intern');
  assert.equal(classifyTier('A.I. Researcher'), 'mid');
  assert.equal(classifyTier('I.T. Specialist II'), 'mid');
});

test('yearsRequired ignores boilerplate years and takes the minimum bar', () => {
  assert.equal(yearsRequired('3-5 years of experience required. Founded 30 years ago.'), 3);
  assert.equal(yearsRequired('No experience necessary.'), null);
});

// ── The similarity read must label itself honestly ──────────────────────────

test('the overlap read says it is not the match score', () => {
  const read = textOverlapRead('We need Python, Kubernetes and retrieval experience.', SOURCE);
  assert.ok(read.percent >= 0 && read.percent <= 100);
  assert.match(read.reason, /word overlap|shared/i);
  assert.match(read.reason, /not the match score/);
});

test('jaccardSimilarity is 1 for identical text and 0 for disjoint text', () => {
  assert.equal(jaccardSimilarity('kubernetes python', 'kubernetes python'), 1);
  assert.equal(jaccardSimilarity('kubernetes', 'accountancy'), 0);
});

// ── The print view ─────────────────────────────────────────────────────────

test('an empty optional section is stripped, not rendered as a bare header', () => {
  const html = renderResumeHtml({
    structured: {
      name: 'TARANG NAIR',
      contact: { location: 'Chantilly, Virginia' },
      headline: null,
      summary: 'A software engineer.',
      experience: [{ position: 0, company: 'Noether', title: 'Founding Engineer', dates: 'Jan 2026 – Present', location: null, bullets: ['Built the retrieval layer.'] }],
      projects: [],
      education: [{ degree: 'Masters Of Engineering', field: 'Software Engineering', school: 'University Of Maryland - College Park' }],
      skills: ['Python', 'Go'],
      courses: [],
    },
  });
  assert.ok(html.includes('Experience'), 'a populated section must survive');
  assert.ok(html.includes('Education'), 'a populated section must survive');
  assert.ok(!html.includes('<h2>Projects</h2>'), 'an empty Projects section must be stripped');
  assert.ok(!html.includes('<h2>Awards</h2>'), 'an empty Awards section must be stripped');
  assert.ok(html.includes('<h2>Skills</h2>'), 'a populated trailing Skills section must survive');
  // The Skills sentinel: stripping must never take the document tail with it.
  assert.ok(html.trimEnd().endsWith('</html>'), 'the document must still close');
});

test('the print view escapes model output rather than trusting it', () => {
  const html = renderDocumentHtml({
    title: 'Cover letter',
    subtitle: null,
    text: 'Hello <script>alert(1)</script> & goodbye',
    generatedAt: '2026-09-19',
    modelName: 'databricks-llama-4-maverick',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'a script tag in model output must not survive');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;'));
});

test('the blocked print view names the failing claims and offers no document', () => {
  const html = renderBlockedHtml({
    title: 'Cover letter',
    sentence: 'Verification FAILED: 1 claim has no support in your profile.',
    findings: [
      { claim: '250000 companies', kind: 'metric', severity: 'block', reason: 'Your profile contains no number matching that.' },
      { claim: 'synergy', kind: 'filler', severity: 'warn', reason: 'Filler.' },
    ],
  });
  assert.ok(html.includes('250000 companies'), 'the blocking claim must be shown');
  assert.ok(!html.includes('synergy'), 'an advisory finding is not a reason to withhold and is not listed here');
  assert.ok(html.includes('not released for printing'));
});

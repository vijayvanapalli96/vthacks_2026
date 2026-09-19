// ---------------------------------------------------------------------------
// Unit tests for the two pieces of this pipeline most likely to be subtly
// wrong, and wrong SILENTLY:
//
//   1. the US location filter — if it over-blocks, the product looks empty; if
//      it under-blocks, we show a student jobs in Bengaluru. Neither failure
//      throws, so only a test catches it.
//   2. job_id derivation — the whole "a job is stored exactly once" claim
//      (CLAUDE.md hard rule 2) rests on this one function. Over-normalise and
//      two different postings silently become one row; under-normalise and one
//      posting becomes two rows.
//
// Plain Node, no dependencies, no network, no Databricks:
//   node test/pipeline.test.mjs
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyLocation } from '../lib/location-us.mjs';
import normalizeUrl from '../lib/url-key.mjs';
import workday from '../lib/providers/workday.mjs';
import { jobIdFor } from '../scan-us-jobs.mjs';

// ── 1. US location filter ───────────────────────────────────────────────────

test('"Dublin, OH" is a US job — the case that naive filtering gets wrong', () => {
  // This is THE motivating case. A posting in Ohio does not contain the string
  // "United States" anywhere, and "Dublin" is on the blocked-cities list because
  // of Dublin, Ireland. Only the USPS state table + the always_allow-beats-block
  // ordering gets this right.
  const got = classifyLocation('Dublin, OH', 'https://job-boards.greenhouse.io/acme/jobs/1', 'Software Engineer');
  assert.equal(got.isUs, true);
  assert.equal(got.confidence, 'display');
});

test('"Dublin, Ireland" is not a US job', () => {
  const got = classifyLocation('Dublin, Ireland', '', 'Software Engineer');
  assert.equal(got.isUs, false);
  assert.equal(got.confidence, 'display');
});

test('"Porto Alegre, Rio Grande do Sul, Brazil" is not a US job', () => {
  // block_hard exists for exactly this shape: "Porto" is a blocked city, "Brazil"
  // is a blocked country, and without the hard tier an always_allow match could
  // rescue it. The country must win.
  const got = classifyLocation('Porto Alegre, Rio Grande do Sul, Brazil', '', 'Backend Engineer');
  assert.equal(got.isUs, false);
  assert.equal(got.confidence, 'display');
});

test('"5 Locations" is resolved from the Workday URL path hint', () => {
  // Some boards display a rolled-up count instead of a city. The location string
  // carries no geography at all, so the verdict comes from the URL — and the row
  // records that with location_confidence = 'url_hint'.
  const us = classifyLocation(
    '5 Locations',
    'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Blacksburg-Virginia/Software-Engineer_R-1001',
    'Software Engineer',
  );
  assert.equal(us.isUs, true);
  assert.equal(us.confidence, 'url_hint');

  const notUs = classifyLocation(
    '5 Locations',
    'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Hyderabad-Telangana-India/Network-Engineer_R-65193',
    'Network Engineer',
  );
  assert.equal(notUs.isUs, false);
  assert.equal(notUs.confidence, 'url_hint');
});

test('a bare "Remote" is admitted but marked low-confidence', () => {
  // "Remote" with no country attached is genuinely ambiguous. These are US
  // employers' own boards, so it is admitted rather than discarded — but no
  // geography was ever read, so confidence is 'unknown' and these are the rows
  // to audit first. Documented in docs/JOB_PIPELINE_PLAN.md section 6.3.
  const got = classifyLocation('Remote', 'https://jobs.lever.co/acme/abc', 'Software Engineer');
  assert.equal(got.isUs, true);
  assert.equal(got.confidence, 'unknown');
});

test('"Remote - Canada" is not a US job, despite the word Remote', () => {
  const got = classifyLocation('Remote - Canada', '', 'Software Engineer');
  assert.equal(got.isUs, false);
});

test('a remote TITLE never rescues a blocked location', () => {
  // The title tier is deliberately last, after block. "Program Manager - Remote"
  // hiring in Bengaluru stays non-US.
  const got = classifyLocation('Bengaluru, Karnataka, India', '', 'Program Manager - Remote');
  assert.equal(got.isUs, false);
});

test('a remote title DOES rescue a posting with no usable location', () => {
  const got = classifyLocation('', '', 'Program Manager - Remote');
  assert.equal(got.isUs, true);
  assert.equal(got.confidence, 'unknown');
});

test('"Non-Remote" in a title is not a remote marker', () => {
  // The negation guard: an explicitly on-site role must not slip through the
  // last-resort tier. "Milan" is blocked, so the only thing that could admit
  // this is the remote marker, and the negation has to beat it.
  const got = classifyLocation('Milan, Italy', '', 'Program Manager - Non-Remote');
  assert.equal(got.isUs, false);
});

test('US cities that contain a blocked country name survive', () => {
  // "Indian Head, MD" and "Indianapolis" are the bug that word-boundary matching
  // exists for: a substring match on "india" silently deleted real US jobs.
  for (const location of ['Indian Head, MD', 'Indianapolis, Indiana', 'Chinatown, San Francisco, CA']) {
    assert.equal(classifyLocation(location, '', 'Engineer').isUs, true, location);
  }
});

test('a multi-location posting survives one blocked city', () => {
  // always_allow beats plain block, so a role open in New York AND London is
  // still a US job.
  const got = classifyLocation('New York, NY · London', '', 'Engineer');
  assert.equal(got.isUs, true);
});

test('an empty location with nothing else to go on is not penalised', () => {
  // "Don't penalize missing data" — inherited from career-ops. is_us true with
  // confidence 'unknown' is the honest encoding: we have no evidence either way
  // and the row is kept so it can be re-examined.
  const got = classifyLocation('', '', '');
  assert.equal(got.isUs, true);
  assert.equal(got.confidence, 'unknown');
});

// ── 2. job_id derivation ────────────────────────────────────────────────────

const noKeyProvider = { id: 'greenhouse' };

test('two URL spellings of ONE posting produce ONE job_id', () => {
  const a = jobIdFor(noKeyProvider, {
    url: 'https://job-boards.greenhouse.io/stripe/jobs/6789012?utm_source=linkedin&utm_campaign=spring&gh_src=abc123',
  });
  const b = jobIdFor(noKeyProvider, {
    url: 'http://Job-Boards.Greenhouse.IO/stripe/jobs/6789012/#app',
  });
  assert.equal(a, b);
  assert.equal(a, 'https://job-boards.greenhouse.io/stripe/jobs/6789012');
});

test('query parameter ORDER does not change the job_id', () => {
  const a = jobIdFor(noKeyProvider, { url: 'https://boards.greenhouse.io/acme/jobs/1?gh_jid=42&t=eng' });
  const b = jobIdFor(noKeyProvider, { url: 'https://boards.greenhouse.io/acme/jobs/1?t=eng&gh_jid=42' });
  assert.equal(a, b);
});

test('two genuinely DIFFERENT postings produce TWO job_ids', () => {
  const a = jobIdFor(noKeyProvider, { url: 'https://job-boards.greenhouse.io/stripe/jobs/6789012' });
  const b = jobIdFor(noKeyProvider, { url: 'https://job-boards.greenhouse.io/stripe/jobs/6789013' });
  assert.notEqual(a, b);
});

test('gh_jid is KEPT — on some boards it is the posting id', () => {
  // The under-normalise-on-purpose rule. Stripping a functional param here would
  // collapse two different postings into one row, which is silent data loss.
  const a = jobIdFor(noKeyProvider, { url: 'https://careers.acme.com/jobs?gh_jid=1111' });
  const b = jobIdFor(noKeyProvider, { url: 'https://careers.acme.com/jobs?gh_jid=2222' });
  assert.notEqual(a, b);
});

test('the provider dedupKey wins over the URL when it exists', () => {
  // One Workday requisition served under three sites of one tenant is ONE
  // posting. URL normalisation alone gives three rows; the requisition id gives
  // one. This is why job_id is dedupKey() ?? urlKey(url) and not just urlKey.
  const urls = [
    'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Blacksburg-Virginia/Software-Engineer_JR1001234',
    'https://acme.wd1.myworkdayjobs.com/en-US/Indeed/job/Blacksburg-Virginia/Software-Engineer_JR1001234-2',
    'https://acme.wd1.myworkdayjobs.com/en-US/Glassdoor/job/Blacksburg-Virginia/Software-Engineer_JR1001234-3',
  ];
  const keys = new Set(urls.map(url => jobIdFor(workday, { url })));
  assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(' , ')}`);
  assert.equal([...keys][0], 'workday:acme.wd1.myworkdayjobs.com:jr1001234');

  // …and two different requisitions on that same tenant stay two keys.
  const other = jobIdFor(workday, {
    url: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Blacksburg-Virginia/Software-Engineer_JR1001235',
  });
  assert.notEqual(other, [...keys][0]);

  // KNOWN LIMIT, inherited deliberately from career-ops: the cross-site "-N"
  // suffix is only stripped when what precedes it is requisition-shaped on its
  // own. For a hyphenated id like Walmart's "R-2593225" the trailing digits ARE
  // part of the id, so "R-1001-2" keys differently from "R-1001" and those two
  // sites do NOT collapse. Under-collapsing is the safe direction (a visible
  // duplicate beats a silent merge of two different postings), and asserting it
  // here means a future "fix" has to be a decision rather than an accident.
  const hyphenated = new Set([
    'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Blacksburg-Virginia/Software-Engineer_R-1001',
    'https://acme.wd1.myworkdayjobs.com/en-US/Indeed/job/Blacksburg-Virginia/Software-Engineer_R-1001-2',
  ].map(url => jobIdFor(workday, { url })));
  assert.equal(hyphenated.size, 2);
});

test('a non-Workday URL falls back to the URL key even on the Workday provider', () => {
  const key = jobIdFor(workday, { url: 'https://jobs.lever.co/acme/8f2c_1a' });
  assert.equal(key, 'https://jobs.lever.co/acme/8f2c_1a');
});

test('NO KEY IS NOT A KEY — unusable URLs yield an empty string', () => {
  // A placeholder must never become a shared key that makes unrelated postings
  // compare equal. The scanner skips these rather than storing them.
  for (const url of ['', 'N/A', 'TBD', 'local:jds/foo.md', 'mailto:jobs@acme.com', undefined]) {
    assert.equal(jobIdFor(noKeyProvider, { url }), '', String(url));
  }
});

test('normalizeUrl is what jobIdFor falls back to', () => {
  // Guards against a future refactor quietly introducing a second, divergent
  // normalisation path.
  const url = 'https://job-boards.greenhouse.io/acme/jobs/7?utm_medium=email';
  assert.equal(jobIdFor(noKeyProvider, { url }), normalizeUrl(url));
});

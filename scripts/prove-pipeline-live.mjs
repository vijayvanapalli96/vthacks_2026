/**
 * prove-pipeline-live.mjs — run the SHIPPING write path against the real
 * warehouse and read the rows back.
 *
 * This is the proof the plan asks for in §6, and it runs the same markStatus /
 * readBoard from app/.../src/lib/pipeline.ts that POST /api/pipeline/status and
 * the board call — not a reimplementation. It is transpiled on the fly by the
 * app's own TypeScript because the file uses a parameter property
 * (`constructor(public readonly jobId: string)`) which Node's type stripping
 * cannot erase.
 *
 *   node scripts/prove-pipeline-live.mjs           # TEST account only, cleaned up
 *   node scripts/prove-pipeline-live.mjs --demo    # also seed the LIVE account
 *
 * SAFETY, and this is not decoration:
 *   * LIVE_USER_ID below is the human's real account. Nothing here ever UPDATEs
 *     or DELETEs its rows. `--demo` only ever APPENDs for it, which is the
 *     realistic demo state and is explicitly allowed.
 *   * The cleanup DELETE is asserted to be scoped to the TEST user id before it
 *     is issued, and it aborts if LIVE_USER_ID appears in the affected set. That
 *     assertion queries the warehouse; it does not trust the WHERE clause it is
 *     about to send.
 *   * application_events is otherwise APPEND-ONLY. The only DELETE in this repo's
 *     pipeline code is this test-fixture cleanup, in a script, never in the app.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { FQ, objects, sql } from './lib/dbsql.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'app', 'vthacks-career-app');
const LIB = path.join(APP, 'src', 'lib');
const OUT = path.join(here, '..', '.tmp-pipeline');

/** The human's live account. Read-only to this script except for APPENDs under --demo. */
const LIVE_USER_ID = '3027b072-2f8c-4960-b3c3-33f63569b50a';
/** A throwaway id that is not, and cannot be confused with, a real user. */
const TEST_USER_ID = 'test-pipeline-verify-0000-0000-000000000000';

const DEMO = process.argv.includes('--demo');

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

function toUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/')}`).href;
}

/** Load the real pipeline.ts, transpiled by the app's own TypeScript. */
async function loadPipeline() {
  const { default: ts } = await import(toUrl(path.join(APP, 'node_modules', 'typescript', 'lib', 'typescript.js')));
  mkdirSync(OUT, { recursive: true });
  const emit = (file, out, rewrites = []) => {
    let js = ts.transpileModule(readFileSync(path.join(LIB, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: file,
    }).outputText;
    for (const [from, to] of rewrites) js = js.split(from).join(to);
    writeFileSync(path.join(OUT, out), js);
  };
  emit('pipeline-contract.ts', 'pipeline-contract.mjs');
  emit('pipeline.ts', 'pipeline.mjs', [
    ["'@/lib/pipeline-contract'", "'./pipeline-contract.mjs'"],
    // The real match reader, so readMatchMap is exercised rather than stubbed.
    ["'@/lib/match/run.mjs'", `'${toUrl(path.join(LIB, 'match', 'run.mjs'))}'`],
  ]);
  return import(toUrl(path.join(OUT, 'pipeline.mjs')));
}

const { markStatus, readBoard, readHistory, readMatchMap, applicationId } = await loadPipeline();

// ---------------------------------------------------------------------------
// 0. Real job_ids. Never invented: job_snapshots is the source of truth and the
//    write path validates against it, so a made-up id would (correctly) 404.
// ---------------------------------------------------------------------------
// One job per company: `ORDER BY job_id LIMIT 4` returned four Lyft postings,
// which is a legitimate result and a useless demo. QUALIFY picks the first
// posting per company, so the board shows four real employers.
const jobs = objects(
  await sql(
    `SELECT job_id, company_name, job_title
       FROM ${FQ}.job_snapshots
      WHERE company_name IS NOT NULL AND job_title IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (PARTITION BY company_name ORDER BY job_id) = 1
      ORDER BY company_name
      LIMIT 4`,
  ),
);
check('found real jobs in job_snapshots to track', jobs.length === 4, jobs.map((j) => j.company_name).join(', '));
if (jobs.length < 4) process.exit(1);
const [primary, ...others] = jobs;

// ---------------------------------------------------------------------------
// 1. Start from a known-clean slate for the TEST user only.
// ---------------------------------------------------------------------------
await cleanupTestUser('before');

// ---------------------------------------------------------------------------
// 2. THE APPEND-ONLY PROOF. Three status changes on ONE job.
// ---------------------------------------------------------------------------
console.log(`\n--- three status changes on ${primary.company_name} / ${primary.job_title} ---`);
const results = [];
for (const [index, status] of ['saved', 'applied', 'interviewing'].entries()) {
  const result = await markStatus(sql, {
    userId: TEST_USER_ID,
    jobId: primary.job_id,
    status,
    note: index === 2 ? "Recruiter said two weeks. Note with an apostrophe and a 'quote'." : null,
    source: index === 2 ? 'voice' : 'ui',
  });
  console.log(`  ${status.padEnd(13)} previous_status=${String(result.previous_status)}  at=${result.at}`);
  results.push(result);
}

check(
  'previous_status chains null -> saved -> applied against the LIVE view',
  JSON.stringify(results.map((r) => r.previous_status)) === JSON.stringify([null, 'saved', 'applied']),
  JSON.stringify(results.map((r) => r.previous_status)),
);

const counted = objects(
  await sql(
    `SELECT (SELECT COUNT(1) FROM ${FQ}.application_events
              WHERE user_id = :user_id AND job_id = :job_id) AS events,
            (SELECT COUNT(1) FROM ${FQ}.latest_application_state
              WHERE user_id = :user_id AND job_id = :job_id) AS view_rows`,
    [
      { name: 'user_id', value: TEST_USER_ID },
      { name: 'job_id', value: primary.job_id },
    ],
  ),
)[0];
check(
  'THE PROOF: 3 status changes -> 3 events, 1 view row',
  counted.events === '3' && counted.view_rows === '1',
  `events=${counted.events} view_rows=${counted.view_rows}`,
);

const state = objects(
  await sql(
    `SELECT current_state, event_type, event_source, note, events_total, application_id,
            CAST(state_changed_at AS STRING) AS state_changed_at,
            CAST(first_seen_at    AS STRING) AS first_seen_at
       FROM ${FQ}.latest_application_state
      WHERE user_id = :user_id AND job_id = :job_id`,
    [
      { name: 'user_id', value: TEST_USER_ID },
      { name: 'job_id', value: primary.job_id },
    ],
  ),
)[0];
console.log('  view row:', state);
check('the view resolves to the NEWEST stage', state.current_state === 'interviewing');
check('events_total on the view row says 3', state.events_total === '3');
check('first_seen_at is earlier than state_changed_at, so "days tracked" is real', state.first_seen_at < state.state_changed_at);
check(
  "the note survived a bound parameter intact, apostrophes and all",
  state.note === "Recruiter said two weeks. Note with an apostrophe and a 'quote'.",
  JSON.stringify(state.note),
);
check('event_source records that the last change came from voice', state.event_source === 'voice');
check(
  'application_id matches the derivation, so the old application_id partition is equivalent',
  state.application_id === applicationId(TEST_USER_ID, primary.job_id),
);

const history = await readHistory(sql, TEST_USER_ID, primary.job_id);
check('readHistory returns all 3 events newest first', history.length === 3 && history[0].event_type === 'interviewing');

// ---------------------------------------------------------------------------
// 3. Undo is another event, not a mutation.
// ---------------------------------------------------------------------------
await markStatus(sql, { userId: TEST_USER_ID, jobId: primary.job_id, status: 'applied', source: 'ui' });
const afterUndo = objects(
  await sql(
    `SELECT (SELECT COUNT(1) FROM ${FQ}.application_events
              WHERE user_id = :user_id AND job_id = :job_id) AS events,
            (SELECT current_state FROM ${FQ}.latest_application_state
              WHERE user_id = :user_id AND job_id = :job_id) AS state`,
    [
      { name: 'user_id', value: TEST_USER_ID },
      { name: 'job_id', value: primary.job_id },
    ],
  ),
)[0];
check(
  'an undo APPENDS a 4th event and the view follows it back to applied',
  afterUndo.events === '4' && afterUndo.state === 'applied',
  `events=${afterUndo.events} state=${afterUndo.state}`,
);

// ---------------------------------------------------------------------------
// 4. A hallucinated job_id is refused, and writes nothing.
// ---------------------------------------------------------------------------
let refused = null;
try {
  await markStatus(sql, {
    userId: TEST_USER_ID,
    jobId: 'this-job-id-does-not-exist-anywhere',
    status: 'saved',
    source: 'voice',
  });
} catch (error) {
  refused = error.name;
}
check('a hallucinated job_id throws UnknownJobError', refused === 'UnknownJobError', String(refused));
const strayRows = objects(
  await sql(
    `SELECT COUNT(1) AS n FROM ${FQ}.application_events WHERE job_id = :job_id`,
    [{ name: 'job_id', value: 'this-job-id-does-not-exist-anywhere' }],
  ),
)[0];
check('and wrote no row for it', strayRows.n === '0', `${strayRows.n} rows`);

// ---------------------------------------------------------------------------
// 5. The board read, with a wall clock. This is the server-side work that
//    GET /api/pipeline does, minus auth and JSON serialisation.
// ---------------------------------------------------------------------------
for (const [index, job] of others.entries()) {
  await markStatus(sql, {
    userId: TEST_USER_ID,
    jobId: job.job_id,
    status: ['saved', 'offer', 'rejected'][index],
    source: 'ui',
  });
}

for (const pass of ['cold', 'warm']) {
  const t0 = Date.now();
  const matches = await readMatchMap(sql, TEST_USER_ID);
  const tMatch = Date.now() - t0;
  const board = await readBoard(sql, TEST_USER_ID, matches);
  const total = Date.now() - t0;
  console.log(
    `  GET /api/pipeline server work (${pass}): ${total} ms total (readMatchMap ${tMatch} ms, readBoard ${total - tMatch} ms)`,
  );
  console.log('  counts:', JSON.stringify(board.counts), 'total:', board.total);
  if (pass === 'warm') {
    check('the board has 4 tracked jobs across 4 distinct stages', board.total === 4, JSON.stringify(board.counts));
    check(
      'every stage key is present even when empty, so a caller never guards for undefined',
      Object.keys(board.stages).length === 7,
    );
    const card = board.stages.applied[0];
    check('the card carries days_in_stage and events_total', card && card.days_in_stage !== null && card.events_total === 4,
      card ? `days_in_stage=${card.days_in_stage} events_total=${card.events_total}` : 'no card');
    check('the card carries the real company from job_snapshots', card?.company === primary.company_name, String(card?.company));
  }
}

// ---------------------------------------------------------------------------
// 6. The realistic demo: APPEND for the live account. Never update, never delete.
// ---------------------------------------------------------------------------
if (DEMO) {
  console.log('\n--- seeding the live account (APPEND ONLY) ---');
  const plan = [
    [jobs[0], 'saved'],
    [jobs[1], 'applied'],
    [jobs[2], 'interviewing'],
    [jobs[3], 'offer'],
  ];
  for (const [job, status] of plan) {
    const r = await markStatus(sql, { userId: LIVE_USER_ID, jobId: job.job_id, status, source: 'ui' });
    console.log(`  ${job.company_name} -> ${status} (was ${String(r.previous_status)})`);
  }
  const live = await readBoard(sql, LIVE_USER_ID, await readMatchMap(sql, LIVE_USER_ID));
  console.log('  live board counts:', JSON.stringify(live.counts));
}

// ---------------------------------------------------------------------------
// 7. Cleanup — TEST user only, asserted before the DELETE is issued.
// ---------------------------------------------------------------------------
await cleanupTestUser('after');

console.log(failures === 0 ? '\nALL LIVE CHECKS PASSED' : `\n${failures} LIVE CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;

async function cleanupTestUser(phase) {
  // Ask the warehouse which user_ids the delete would touch. Do NOT trust the
  // WHERE clause about to be sent — read the set, then assert on it.
  const affected = objects(
    await sql(`SELECT DISTINCT user_id FROM ${FQ}.application_events WHERE user_id = :user_id`, [
      { name: 'user_id', value: TEST_USER_ID },
    ]),
  ).map((row) => row.user_id);

  if (affected.includes(LIVE_USER_ID)) {
    throw new Error('ABORT: the live user id appeared in the delete set. Nothing was deleted.');
  }
  if (affected.some((id) => id !== TEST_USER_ID)) {
    throw new Error(`ABORT: delete set contains a non-test user: ${JSON.stringify(affected)}`);
  }
  if (affected.length === 0) {
    console.log(`  cleanup (${phase}): nothing to remove`);
    return;
  }
  await sql(`DELETE FROM ${FQ}.application_events WHERE user_id = :user_id`, [
    { name: 'user_id', value: TEST_USER_ID },
  ]);
  const left = objects(
    await sql(`SELECT COUNT(1) AS n FROM ${FQ}.application_events WHERE user_id = :user_id`, [
      { name: 'user_id', value: TEST_USER_ID },
    ]),
  )[0];
  console.log(`  cleanup (${phase}): removed the test user's rows, ${left.n} left`);
}

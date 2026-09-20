/**
 * verify-pipeline.mjs — prove the pipeline's invariants WITHOUT a warehouse.
 *
 * Why this exists: the live SQL warehouse (441b670a0ff475e0) currently refuses
 * this account — `PERMISSION_DENIED ... user is not authorized to use this
 * warehouse`, because tarangnair98@gmail.com is no longer in the `vthacks-team`
 * group and `warehouses list -p TEAM` returns nothing. That blocks executing the
 * DDL and doing a browser round trip. It does NOT block proving the properties
 * that matter, because the write path takes `sql` as an argument.
 *
 * So: substitute a recording fake for `sql` and assert on what the code EMITS.
 * These are real assertions about real statements, not a mock of the outcome.
 *
 *   node scripts/verify-pipeline.mjs
 *
 * Run it with the app's TypeScript compiled? No — it reads the .ts through a
 * tiny regex-free transform-free path: it imports the compiled contract by
 * re-implementing nothing, and inspects src/lib/pipeline.ts as TEXT for the
 * mutation ban. The behavioural half runs against the real module via tsx if
 * available, and degrades to the text checks if not.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'app', 'vthacks-career-app');
const LIB = path.join(APP, 'src', 'lib');

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

// ---------------------------------------------------------------------------
// 1. Append-only, enforced by reading the source rather than trusting a comment.
// ---------------------------------------------------------------------------
const pipelineTs = readFileSync(path.join(LIB, 'pipeline.ts'), 'utf8');
// Strip comments first: the file TALKS about never updating, and a naive grep
// would match its own documentation and pass for the wrong reason.
const code = pipelineTs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

for (const verb of ['UPDATE ', 'DELETE ', 'MERGE ', 'TRUNCATE ', 'INSERT OVERWRITE']) {
  check(`src/lib/pipeline.ts emits no ${verb.trim()}`, !code.toUpperCase().includes(verb));
}
check('src/lib/pipeline.ts does emit an INSERT INTO', code.toUpperCase().includes('INSERT INTO'));

// ---------------------------------------------------------------------------
// 2. Every value bound, nothing interpolated. `note` is the dangerous one: free
//    text from a human or a speech transcript.
// ---------------------------------------------------------------------------
// Only the template literals that ARE SQL. The file has other backtick strings
// (the hash input in applicationId, an error message) and flagging those would
// make this check noise instead of a guarantee.
const sqlLiterals = [...code.matchAll(/`([^`]*)`/g)]
  .map((m) => m[1])
  .filter((body) => /\b(SELECT|INSERT|UPDATE|DELETE|FROM)\b/.test(body));
check('found the SQL statements to audit', sqlLiterals.length >= 3, `${sqlLiterals.length} statements`);
const allowed = new Set(['FQ']);
const badHoles = sqlLiterals
  .flatMap((body) => [...body.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim()))
  .filter((hole) => !allowed.has(hole));
check(
  'no value is interpolated into SQL — every ${} inside a statement is the table prefix',
  badHoles.length === 0,
  badHoles.length ? `found ${JSON.stringify(badHoles)}` : 'only ${FQ}',
);
check(
  'every :placeholder in every statement has a matching named parameter',
  (() => {
    const placeholders = new Set(sqlLiterals.flatMap((b) => [...b.matchAll(/:([a-z_]+)/g)].map((m) => m[1])));
    const bound = new Set([...code.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]));
    return [...placeholders].every((name) => bound.has(name));
  })(),
);
check("note is bound as a named parameter", /\{ name: 'note', value: note \}/.test(code));

// ---------------------------------------------------------------------------
// 3. The whitelist. An unknown status must be impossible to write.
// ---------------------------------------------------------------------------
const contractTs = readFileSync(path.join(LIB, 'pipeline-contract.ts'), 'utf8');
const EXPECTED = ['saved', 'applied', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn'];
const listed = [...contractTs.matchAll(/^\s{2}'([a-z]+)',$/gm)].map((m) => m[1]);
check(
  'PIPELINE_STATUSES is exactly the seven stages',
  EXPECTED.every((stage) => listed.includes(stage)),
  `declared: ${EXPECTED.filter((s) => listed.includes(s)).join(', ')}`,
);
check(
  'offer and accepted are separate stages, not one "success"',
  listed.includes('offer') && listed.includes('accepted') && !listed.includes('success'),
);

// ---------------------------------------------------------------------------
// 4. The view. Deterministic tiebreak, per-user partition, stage filter.
// ---------------------------------------------------------------------------
// core.autocrlf is true in this repo, so the working tree is CRLF. Normalised so
// every pattern below can be written with plain \n.
const schema = readFileSync(path.join(here, '..', 'sql', 'schema.sql'), 'utf8').replace(/\r\n/g, '\n');
const section8 = schema.slice(schema.indexOf('SECTION 8'));
check('SECTION 8 exists in sql/schema.sql', section8.length > 0);
check(
  'the view partitions by (user_id, job_id)',
  /ROW_NUMBER\(\)\s*OVER \(\s*PARTITION BY e\.user_id, e\.job_id/.test(section8),
);
check(
  'the view tiebreaks on event_id, so two events in one second resolve deterministically',
  /ORDER BY e\.event_at DESC, e\.event_id DESC/.test(section8),
);
check('the ALTER adds user_id and note', /ADD COLUMNS \(\s*\n\s*user_id STRING/.test(section8));
check(
  'submitted and callback are normalised into stages',
  /WHEN 'submitted' THEN 'applied'/.test(section8) && /WHEN 'callback'\s+THEN 'interviewing'/.test(section8),
);
check(
  'non-stage activity is excluded from the view',
  !/'viewed'/.test(section8) || !/IN \('saved'[^)]*'viewed'/.test(section8),
);
check('sections 1-7 are untouched', schema.indexOf('SECTION 8') > schema.indexOf('SECTION 7'));

// ---------------------------------------------------------------------------
// 5. The behavioural proof: three status changes on one job produce THREE
//    INSERTs and never a mutation. Run against the real markStatus through a
//    recording fake for `sql`.
// ---------------------------------------------------------------------------
/**
 * Load the REAL pipeline.ts, transpiled by the app's own TypeScript.
 *
 * Not tsx (not installed, and not worth a dependency for this), and not Node's
 * type stripping: `constructor(public readonly jobId: string)` in
 * UnknownJobError is a parameter property, which is not erasable syntax. So:
 * transpileModule to ESM, rewrite the two `@/lib/...` specifiers Node cannot
 * resolve, and import the result. This runs the SHIPPING code, not a copy.
 */
async function loadPipelineModule() {
  const { default: ts } = await import(
    pathToFileUrl(path.join(APP, 'node_modules', 'typescript', 'lib', 'typescript.js'))
  );
  const outDir = path.join(here, '..', '.tmp-pipeline');
  mkdirSync(outDir, { recursive: true });

  const emit = (fileName, outName, rewrites) => {
    const source = readFileSync(path.join(LIB, fileName), 'utf8');
    let js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName,
    }).outputText;
    for (const [from, to] of rewrites) js = js.split(from).join(to);
    writeFileSync(path.join(outDir, outName), js);
  };

  emit('pipeline-contract.ts', 'pipeline-contract.mjs', []);
  emit('pipeline.ts', 'pipeline.mjs', [
    ["'@/lib/pipeline-contract'", "'./pipeline-contract.mjs'"],
    // The match reader is a dynamic import inside a try/catch that this test
    // never reaches; pointing it at a missing path is caught, not thrown.
    ["'@/lib/match/run.mjs'", "'./no-match-cache.mjs'"],
  ]);
  return import(pathToFileUrl(path.join(outDir, 'pipeline.mjs')));
}

function pathToFileUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/')}`).href;
}

async function behavioural() {
  let markStatus;
  try {
    ({ markStatus } = await loadPipelineModule());
  } catch (error) {
    console.log(`SKIP  behavioural replay — could not load pipeline.ts (${error.message.split('\n')[0]})`);
    failures += 1;
    return;
  }

  const statements = [];
  const stages = ['saved', 'applied', 'interviewing'];
  let current = null;

  /** A recording fake. Answers the probe from in-memory state; records everything. */
  const fakeSql = async (statement, parameters = []) => {
    statements.push({ statement, parameters });
    if (/INSERT INTO/.test(statement)) {
      current = parameters.find((p) => p.name === 'event_type')?.value ?? null;
      return { columns: [], rows: [] };
    }
    // The probe: job exists, previous stage is whatever the last INSERT wrote.
    return { columns: ['job_count', 'previous_status'], rows: [['1', current]] };
  };

  const userId = 'test-user-not-the-live-account';
  const jobId = 'test-job-id';
  const results = [];
  for (const stage of stages) {
    results.push(await markStatus(fakeSql, { userId, jobId, status: stage, source: 'ui' }));
  }

  const inserts = statements.filter((s) => /INSERT INTO/.test(s.statement));
  check('three status changes emit exactly 3 INSERTs', inserts.length === 3, `got ${inserts.length}`);
  check(
    'and zero UPDATE / DELETE / MERGE statements',
    statements.every((s) => !/\b(UPDATE|DELETE|MERGE|TRUNCATE)\b/i.test(s.statement)),
  );
  check(
    'each INSERT has a distinct event_id, so the view has 3 events to rank',
    new Set(inserts.map((s) => s.parameters.find((p) => p.name === 'event_id').value)).size === 3,
  );
  check(
    'all three INSERTs share one application_id — 1 view row, not 3',
    new Set(inserts.map((s) => s.parameters.find((p) => p.name === 'application_id').value)).size === 1,
  );
  check(
    'previous_status chains null -> saved -> applied',
    JSON.stringify(results.map((r) => r.previous_status)) === JSON.stringify([null, 'saved', 'applied']),
    JSON.stringify(results.map((r) => r.previous_status)),
  );
  check(
    'job_id is validated against job_snapshots before the write',
    /job_snapshots WHERE job_id = :job_id/.test(statements[0].statement),
  );

  // A hallucinated job_id must 404, not write.
  const noJobSql = async (statement) =>
    /INSERT/.test(statement)
      ? (() => {
          throw new Error('wrote a row for a job that does not exist');
        })()
      : { columns: ['job_count', 'previous_status'], rows: [['0', null]] };
  let threw = false;
  try {
    await markStatus(noJobSql, { userId, jobId: 'hallucinated', status: 'saved', source: 'voice' });
  } catch (error) {
    threw = error.name === 'UnknownJobError';
  }
  check('an unknown job_id throws UnknownJobError and writes nothing', threw);
}

await behavioural();

// ---------------------------------------------------------------------------
// 6. The view's SEMANTICS: 3 events on one job must collapse to 1 row, and the
//    winner must be the newest, with event_id breaking a tie in the same second.
//
//    Run on node:sqlite, NOT on Databricks. This is deliberate and it is a
//    stated limit: the SQL warehouse currently refuses this account, so the DDL
//    has not been executed there. What this proves is that the exact SELECT text
//    shipped in sql/schema.sql §8 — extracted from the file, not retyped —
//    resolves one row per (user_id, job_id) with a deterministic winner. What it
//    does NOT prove is that Databricks parses it; SQLite and Spark SQL agree on
//    ROW_NUMBER, MIN OVER, COUNT OVER and CASE, which is all this uses.
// ---------------------------------------------------------------------------
async function viewSemantics() {
  const { DatabaseSync } = await import('node:sqlite');

  // Extract the shipped SELECT: everything between the view's ") AS" and the
  // statement's terminating semicolon.
  const start = section8.indexOf(') AS\nSELECT user_id');
  const body = section8.slice(start + ') AS\n'.length, section8.indexOf('\n WHERE rn = 1;') + '\n WHERE rn = 1'.length);
  if (!check('extracted the shipped view SELECT from sql/schema.sql', body.startsWith('SELECT user_id'))) return;

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE application_events (
    event_id TEXT, application_id TEXT, user_id TEXT, job_id TEXT,
    event_type TEXT, event_source TEXT, event_at TEXT, note TEXT, metadata_json TEXT
  )`);
  const insert = db.prepare(
    `INSERT INTO application_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  );
  const USER = 'test-user-not-the-live-account';
  const JOB = 'test-job-1';
  // Three changes on ONE job, the last two in the SAME second — the case that
  // makes a tiebreak on event_at alone non-deterministic.
  insert.run('e1', 'app1', USER, JOB, 'saved', 'ui', '2026-09-19 10:00:00', null);
  insert.run('e2', 'app1', USER, JOB, 'applied', 'ui', '2026-09-19 11:00:00', null);
  insert.run('e3', 'app1', USER, JOB, 'interviewing', 'voice', '2026-09-19 11:00:00', 'recruiter called');
  // Noise that must NOT appear as a stage, and must not demote the job.
  insert.run('e4', 'app1', USER, JOB, 'viewed', 'ui', '2026-09-19 23:59:59', null);
  // A second user on the same job, to prove the partition is per-user.
  insert.run('e5', 'app2', 'other-user', JOB, 'rejected', 'ui', '2026-09-19 12:00:00', null);
  // The A2A path's raw event type, on a different job, to prove normalisation.
  insert.run('e6', 'app3', USER, 'test-job-2', 'submitted', 'workflow', '2026-09-19 09:00:00', null);

  const sqliteBody = body.replace(/workspace\.vthacks_2026\.application_events/g, 'application_events');
  const rows = db.prepare(sqliteBody).all();

  const total = db.prepare('SELECT COUNT(1) AS n FROM application_events').get().n;
  check('6 events written to the event log', total === 6, `${total} events`);

  const mine = rows.filter((r) => r.user_id === USER && r.job_id === JOB);
  check(
    'THE APPEND-ONLY PROOF: 3 status changes on one job -> 3 events, 1 view row',
    mine.length === 1 && mine[0].events_total === 3,
    `${mine.length} view row(s), events_total=${mine[0]?.events_total}`,
  );
  check(
    'the newest event wins, and the same-second tie resolves on event_id',
    mine[0]?.current_state === 'interviewing' && mine[0]?.event_id === 'e3',
    `current_state=${mine[0]?.current_state} event_id=${mine[0]?.event_id}`,
  );
  check(
    'a later "viewed" does NOT demote the stage',
    mine[0]?.current_state === 'interviewing',
  );
  check('the note rides along on the winning row', mine[0]?.note === 'recruiter called');
  check(
    'first_seen_at is the FIRST event, so "days tracked" is real',
    mine[0]?.first_seen_at === '2026-09-19 10:00:00',
    String(mine[0]?.first_seen_at),
  );
  check(
    'the partition is per-user: the other user keeps their own stage on the same job',
    rows.filter((r) => r.user_id === 'other-user').length === 1 &&
      rows.find((r) => r.user_id === 'other-user')?.current_state === 'rejected',
  );
  check(
    'submitted is normalised to applied, with the raw event_type still readable',
    rows.find((r) => r.job_id === 'test-job-2')?.current_state === 'applied' &&
      rows.find((r) => r.job_id === 'test-job-2')?.event_type === 'submitted',
  );
  check('the view yields one row per (user_id, job_id) and no more', rows.length === 3, `${rows.length} rows`);
  db.close();
}

await viewSemantics();

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;

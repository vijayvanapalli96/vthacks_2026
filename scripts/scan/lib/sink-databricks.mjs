// ---------------------------------------------------------------------------
// sink-databricks.mjs — every write this pipeline makes to
// workspace.vthacks_2026, over the SQL Statement Execution API.
//
// AUTH, in priority order — mirrors app/vthacks-career-app/src/lib/databricks.ts
// on purpose, so there is one auth story in the repo and not two:
//   1. DATABRICKS_TOKEN             — a PAT. NOT usable on this workspace: PATs
//                                     are disabled ("User does not have
//                                     permission to use tokens").
//   2. DATABRICKS_CLIENT_ID/_SECRET — OAuth M2M. What a Vultr cron should use.
//   3. `databricks auth token -p TEAM` — the CLI's own OAuth token. What local
//                                     dev actually uses.
//
// HOSTILE INPUT. Job titles, locations, descriptions and URLs come off the open
// internet. NOTHING from a posting is ever interpolated into SQL text. The bulk
// write binds ONE named parameter carrying the whole batch as JSON and lets
// from_json() parse it inside the engine; the only values that ever reach the
// statement string are integers this file produced itself (Number.parseInt'd
// slice sizes and LIMITs).
//
// WRITE-ONCE (CLAUDE.md hard rule 2). Ingest into job_snapshots is
// MERGE ... WHEN NOT MATCHED THEN INSERT — insert-only, no update path.
//
// ONE exception exists, and it is deliberate: reclassifySnapshots() carries a
// WHEN MATCHED THEN UPDATE whose SET list is exactly `is_us` and
// `location_confidence`. Those are derived verdicts, not captured content, and
// being able to recompute them is the whole reason we store every posting instead
// of discarding the ones a filter rejects — a stored verdict you can never correct
// makes "re-examinable later" an empty promise. It took an hour to need it: bare
// city names were being read as non-US and 1,559 rows needed fixing in place.
//
// What rule 2 actually protects is captured content. `description_text` and
// `raw_payload_json` appear in NO SET list in this file and must never be added to
// one. If you extend the update, extend it to derived columns only.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export const CATALOG_SCHEMA = 'workspace.vthacks_2026';

// Defaults are the team workspace from CLAUDE.md, baked in so `npm run scan:us`
// works with no .env at all — these two values are already committed in
// app/vthacks-career-app/.env.example and are not secrets.
const DEFAULT_HOST = 'https://dbc-0bfd7b56-c2eb.cloud.databricks.com';
const DEFAULT_WAREHOUSE = '441b670a0ff475e0';
const DEFAULT_PROFILE = 'TEAM';

// The warehouse is a 2X-Small serverless that stops when idle and cold-starts in
// 20-30s. wait_timeout is the API's own cap (50s max); the poll loop covers the
// rest so a cold start is slow, not a failure.
const WAIT_TIMEOUT = '30s';
const POLL_LIMIT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;

/**
 * Bulk-write batching. One MERGE per chunk; a posting body can be 20KB+, and the
 * whole chunk travels as a single bound parameter.
 *
 * MAX_MERGE_BYTES IS NOT A TUNING KNOB — it is a HARD API LIMIT. Measured on
 * 2026-09-19 with a 2.5MB batch:
 *   INVALID_PARAMETER_VALUE: Parameterized query's parameters are too large:
 *   the combined size of parameters is 2513274, exceeding the limit of
 *   1048576 characters.
 * So the ceiling is 1 MiB of combined parameter text per statement, and this
 * value leaves headroom for the JSON array's own punctuation and for
 * multi-byte characters in a posting body. Raising it past ~1,000,000 will make
 * every large board fail.
 */
const MAX_MERGE_ROWS = 300;
const MAX_MERGE_BYTES = 800_000;

let cachedToken = null;

function host() {
  const value = process.env.DATABRICKS_HOST || DEFAULT_HOST;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, '');
}

function warehouseId() {
  return process.env.DATABRICKS_WAREHOUSE_ID || DEFAULT_WAREHOUSE;
}

/**
 * Windows installs the CLI outside PATH often enough that the app's
 * .env.example documents DATABRICKS_CLI_PATH for it. Honour that variable
 * first, then try the winget shim location, then fall back to bare
 * `databricks` and let execFile report the failure.
 */
function cliPath() {
  if (process.env.DATABRICKS_CLI_PATH) return process.env.DATABRICKS_CLI_PATH;
  const wingetShim = path.join(
    os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'databricks.exe',
  );
  if (process.platform === 'win32' && existsSync(wingetShim)) return wingetShim;
  return 'databricks';
}

async function tokenFromCli() {
  const profile = process.env.DATABRICKS_CONFIG_PROFILE || DEFAULT_PROFILE;
  const { stdout } = await execFileAsync(cliPath(), ['auth', 'token', '-p', profile], {
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  return {
    token: parsed.access_token,
    expiresAt: parsed.expiry ? Date.parse(parsed.expiry) : Date.now() + 10 * 60_000,
  };
}

async function tokenFromClientCredentials(clientId, clientSecret) {
  const res = await fetch(`${host()}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all-apis' }),
  });
  if (!res.ok) throw new Error(`OAuth token request failed: ${res.status} ${await res.text()}`);
  const parsed = await res.json();
  return { token: parsed.access_token, expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000 };
}

async function bearerToken() {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  // 60s of slack so a long statement never runs off the end of its own token.
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.token;
  const id = process.env.DATABRICKS_CLIENT_ID;
  const secret = process.env.DATABRICKS_CLIENT_SECRET;
  cachedToken = id && secret
    ? await tokenFromClientCredentials(id, secret)
    : await tokenFromCli();
  return cachedToken.token;
}

async function api(apiPath, init = {}) {
  const res = await fetch(`${host()}${apiPath}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${await bearerToken()}`,
      'content-type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Databricks ${apiPath} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Run ONE statement. The API takes no scripts — one statement per request — and
 * every untrusted value must arrive as a named parameter.
 *
 * @param {string} statement
 * @param {{name: string, value: string|null, type?: string}[]} [parameters]
 * @returns {Promise<{columns: string[], rows: (string|null)[][]}>}
 */
export async function sql(statement, parameters = []) {
  let response = await api('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify({
      warehouse_id: warehouseId(),
      statement,
      parameters: parameters.map(p => ({
        name: p.name,
        value: p.value,
        type: p.type ?? 'STRING',
      })),
      wait_timeout: WAIT_TIMEOUT,
      on_wait_timeout: 'CONTINUE',
    }),
  });

  const deadline = Date.now() + POLL_LIMIT_MS;
  while (
    (response.status?.state === 'PENDING' || response.status?.state === 'RUNNING')
    && Date.now() < deadline
  ) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    response = await api(`/api/2.0/sql/statements/${response.statement_id}`);
  }

  if (response.status?.state !== 'SUCCEEDED') {
    throw new Error(
      `Databricks statement ${response.status?.state ?? 'unknown'}: `
      + `${response.status?.error?.message ?? 'no error message'}`,
    );
  }
  return {
    columns: response.manifest?.schema?.columns?.map(c => c.name) ?? [],
    rows: response.result?.data_array ?? [],
  };
}

/** First cell of the first row, or null. */
export async function sqlScalar(statement, parameters = []) {
  const { rows } = await sql(statement, parameters);
  return rows.length > 0 ? rows[0][0] : null;
}

/** Rows as objects keyed by column name. */
export async function sqlObjects(statement, parameters = []) {
  const { columns, rows } = await sql(statement, parameters);
  return rows.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

// ── job_snapshots ───────────────────────────────────────────────────────────

// The struct passed through from_json. Field order is irrelevant (JSON is
// keyed), but the names must match the objects built in scan-us-jobs.mjs.
// Timestamps travel as ISO-8601 strings and are CAST inside the engine: one
// bound parameter can only carry one type, and the batch is one parameter.
const SNAPSHOT_STRUCT = [
  'job_snapshot_id:string',
  'job_id:string',
  'source:string',
  'source_url:string',
  'company_name:string',
  'job_title:string',
  'location_text:string',
  'description_text:string',
  'discovered_at:string',
  'captured_at:string',
  'raw_payload_json:string',
  'is_us:boolean',
  'posted_at:string',
  'location_confidence:string',
].join(',');

const MERGE_SNAPSHOTS = `
MERGE INTO ${CATALOG_SCHEMA}.job_snapshots AS t
USING (
  SELECT
    j.job_snapshot_id,
    j.job_id,
    j.source,
    j.source_url,
    j.company_name,
    j.job_title,
    j.location_text,
    j.description_text,
    CAST(j.discovered_at AS TIMESTAMP) AS discovered_at,
    CAST(j.captured_at   AS TIMESTAMP) AS captured_at,
    j.raw_payload_json,
    j.is_us,
    CAST(j.posted_at AS TIMESTAMP) AS posted_at,
    j.location_confidence
  FROM (SELECT explode(from_json(:payload, 'array<struct<${SNAPSHOT_STRUCT}>>')) AS j)
) AS s
ON t.job_id = s.job_id
WHEN NOT MATCHED THEN INSERT (
  job_snapshot_id, job_id, source, source_url, company_name, job_title,
  location_text, description_text, discovered_at, captured_at, raw_payload_json,
  is_us, posted_at, location_confidence
) VALUES (
  s.job_snapshot_id, s.job_id, s.source, s.source_url, s.company_name, s.job_title,
  s.location_text, s.description_text, s.discovered_at, s.captured_at, s.raw_payload_json,
  s.is_us, s.posted_at, s.location_confidence
)`;

/** Split a batch so no single statement carries an unreasonable parameter. */
function chunkRows(rows) {
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (current.length > 0 && (current.length >= MAX_MERGE_ROWS || bytes + size > MAX_MERGE_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * MERGE postings into job_snapshots. Insert-only: a posting already present is
 * left exactly as first captured.
 *
 * The caller MUST have de-duplicated `rows` by job_id first — a MERGE whose
 * source carries the same key twice fails outright, and that is the failure this
 * pipeline is most likely to hit (three hosts of one Workday tenant, one req).
 *
 * @param {object[]} rows
 * @returns {Promise<{attempted: number, inserted: number, statements: number}>}
 */
export async function mergeJobSnapshots(rows) {
  let inserted = 0;
  const chunks = chunkRows(rows);
  for (const chunk of chunks) {
    const result = await sql(MERGE_SNAPSHOTS, [
      { name: 'payload', value: JSON.stringify(chunk) },
    ]);
    // Databricks returns MERGE metrics as a single row of named counters. The
    // exact set has changed across DBR versions, so read it by column name and
    // fall back to 0 rather than trusting a position.
    const idx = result.columns.indexOf('num_inserted_rows');
    if (idx !== -1 && result.rows.length > 0) inserted += Number(result.rows[0][idx] ?? 0);
  }
  return { attempted: rows.length, inserted, statements: chunks.length };
}

/**
 * Which of these job_ids does job_snapshots already hold?
 *
 * This is an OPTIMISATION, not a correctness mechanism — MERGE remains the only
 * write path and is still insert-only, so a posting that slips through this
 * filter is still not duplicated. It exists because in the steady state almost
 * every posting a tick fetches is already stored: without it a tick re-ships
 * ~2,000 postings (several MB of description text) to the warehouse every five
 * minutes just to have the engine decide "matched, do nothing". With it, a
 * no-new-jobs tick costs one cheap SELECT.
 *
 * Ids are bound as one JSON array parameter, never interpolated: a job_id can be
 * a URL that came off the open internet.
 */
export async function existingJobIds(ids) {
  const found = new Set();
  const unique = [...new Set(ids)];
  // Kept well under the 1 MiB combined-parameter ceiling documented above: a
  // job_id can be a full posting URL, so 1,000 of them is ~150KB.
  const PER_QUERY = 1_000;
  for (let i = 0; i < unique.length; i += PER_QUERY) {
    const slice = unique.slice(i, i + PER_QUERY);
    const { rows } = await sql(
      `SELECT DISTINCT job_id FROM ${CATALOG_SCHEMA}.job_snapshots
        WHERE job_id IN (SELECT explode(from_json(:ids, 'array<string>')))`,
      [{ name: 'ids', value: JSON.stringify(slice) }],
    );
    for (const row of rows) found.add(row[0]);
  }
  return found;
}

/**
 * The §3.1 assertion, run every tick. UC PRIMARY KEY is informational and Delta
 * enforces nothing, so uniqueness is something we produce and then verify.
 */
export async function countRowsAndKeys() {
  const [row] = await sqlObjects(
    `SELECT count(*) AS total_rows, count(DISTINCT job_id) AS distinct_job_ids
       FROM ${CATALOG_SCHEMA}.job_snapshots`,
  );
  return {
    totalRows: Number(row?.total_rows ?? 0),
    distinctJobIds: Number(row?.distinct_job_ids ?? 0),
  };
}

// ── Re-classifying the derived location columns ──────────────────────────────

/**
 * Page through the columns needed to recompute a location verdict.
 * ORDER BY job_id so paging is stable across statements.
 */
export async function readLocationInputs(offset, limit) {
  const o = Number.parseInt(String(offset), 10);
  const n = Number.parseInt(String(limit), 10);
  if (!Number.isInteger(o) || o < 0 || !Number.isInteger(n) || n <= 0 || n > 20_000) {
    throw new Error(`bad paging window: ${offset}/${limit}`);
  }
  return sqlObjects(`
    SELECT job_id, location_text, source_url, job_title, is_us, location_confidence
    FROM ${CATALOG_SCHEMA}.job_snapshots
    ORDER BY job_id
    LIMIT ${n} OFFSET ${o}`);
}

const RECLASSIFY_STRUCT = 'job_id:string,is_us:boolean,location_confidence:string';

/**
 * Refresh is_us and location_confidence on rows already stored.
 *
 * THIS IS THE ONLY WHEN-MATCHED-UPDATE AGAINST job_snapshots IN THE REPO, and it
 * touches exactly two columns, both of them DERIVED. `description_text` and
 * `raw_payload_json` — the two the write-once rule names (CLAUDE.md hard rule 2)
 * — are not in the SET list and must never be added to it.
 *
 * Why this exists: the plan's argument for storing every posting is that a
 * dropped row cannot be re-examined when the filter turns out to have been
 * wrong. That promise is empty unless the stored verdict can actually be
 * recomputed when the filter improves — which it did, immediately: the first
 * live sweep marked 834 bare-"San Francisco" postings as non-US.
 */
export async function reclassifyLocations(updates) {
  let changed = 0;
  for (const chunk of chunkRows(updates)) {
    const result = await sql(`
MERGE INTO ${CATALOG_SCHEMA}.job_snapshots AS t
USING (
  SELECT u.job_id, u.is_us, u.location_confidence
  FROM (SELECT explode(from_json(:payload, 'array<struct<${RECLASSIFY_STRUCT}>>')) AS u)
) AS s
ON t.job_id = s.job_id
WHEN MATCHED THEN UPDATE SET
  t.is_us = s.is_us,
  t.location_confidence = s.location_confidence`,
    [{ name: 'payload', value: JSON.stringify(chunk) }]);
    const idx = result.columns.indexOf('num_updated_rows');
    if (idx !== -1 && result.rows.length > 0) changed += Number(result.rows[0][idx] ?? 0);
  }
  return { changed };
}

// ── job_boards ──────────────────────────────────────────────────────────────

const BOARD_STRUCT = [
  'board_id:string',
  'provider:string',
  'company_name:string',
  'board_slug:string',
  'api_url:string',
  'careers_url:string',
  'country_hint:string',
  'enabled:boolean',
].join(',');

/**
 * Seed (or re-seed) job_boards from boards.json. Rotation and health columns are
 * deliberately NOT touched on a re-seed: re-running the seeder must not reset
 * the rotation or clear a backoff that a live board earned.
 */
export async function seedBoards(boards) {
  const statement = `
MERGE INTO ${CATALOG_SCHEMA}.job_boards AS t
USING (
  SELECT b.board_id, b.provider, b.company_name, b.board_slug, b.api_url,
         b.careers_url, b.country_hint, b.enabled
  FROM (SELECT explode(from_json(:payload, 'array<struct<${BOARD_STRUCT}>>')) AS b)
) AS s
ON t.board_id = s.board_id
WHEN MATCHED THEN UPDATE SET
  t.provider = s.provider, t.company_name = s.company_name, t.board_slug = s.board_slug,
  t.api_url = s.api_url, t.careers_url = s.careers_url, t.country_hint = s.country_hint,
  t.enabled = s.enabled
WHEN NOT MATCHED THEN INSERT (
  board_id, provider, company_name, board_slug, api_url, careers_url, country_hint,
  enabled, last_scanned_at, last_ok_at, consecutive_failures, backoff_until
) VALUES (
  s.board_id, s.provider, s.company_name, s.board_slug, s.api_url, s.careers_url,
  s.country_hint, s.enabled, NULL, NULL, 0, NULL
)`;
  const result = await sql(statement, [{ name: 'payload', value: JSON.stringify(boards) }]);
  const idx = result.columns.indexOf('num_inserted_rows');
  return { inserted: idx !== -1 && result.rows.length ? Number(result.rows[0][idx] ?? 0) : 0 };
}

/**
 * The rotating slice: the N least-recently-scanned enabled boards that are not
 * in backoff. NULLS FIRST so a never-scanned board is always picked before an
 * already-scanned one.
 *
 * `limit` is Number.parseInt'd before it touches the statement because LIMIT
 * does not accept a parameter marker. It originates from a config constant in
 * this repo, never from a posting.
 */
export async function claimBoardSlice(limit) {
  const n = Number.parseInt(String(limit), 10);
  if (!Number.isInteger(n) || n <= 0 || n > 1000) throw new Error(`bad slice size: ${limit}`);
  return sqlObjects(`
    SELECT board_id, provider, company_name, board_slug, api_url, careers_url,
           consecutive_failures
    FROM ${CATALOG_SCHEMA}.job_boards
    WHERE enabled AND (backoff_until IS NULL OR backoff_until < current_timestamp())
    ORDER BY last_scanned_at ASC NULLS FIRST, board_id ASC
    LIMIT ${n}`);
}

const HEALTH_STRUCT = [
  'board_id:string',
  'scanned_at:string',
  'ok:boolean',
  'consecutive_failures:int',
  'backoff_until:string',
].join(',');

/**
 * Record the outcome of this tick for each board in the slice. Boards break —
 * without a backoff we would re-hit a dead board every 5 minutes forever
 * (career-ops learned this in dead-boards.mjs).
 */
export async function recordBoardHealth(updates) {
  if (updates.length === 0) return;
  const statement = `
MERGE INTO ${CATALOG_SCHEMA}.job_boards AS t
USING (
  SELECT h.board_id,
         CAST(h.scanned_at AS TIMESTAMP) AS scanned_at,
         h.ok,
         h.consecutive_failures,
         CAST(h.backoff_until AS TIMESTAMP) AS backoff_until
  FROM (SELECT explode(from_json(:payload, 'array<struct<${HEALTH_STRUCT}>>')) AS h)
) AS s
ON t.board_id = s.board_id
WHEN MATCHED THEN UPDATE SET
  t.last_scanned_at = s.scanned_at,
  t.last_ok_at = CASE WHEN s.ok THEN s.scanned_at ELSE t.last_ok_at END,
  t.consecutive_failures = s.consecutive_failures,
  t.backoff_until = s.backoff_until`;
  await sql(statement, [{ name: 'payload', value: JSON.stringify(updates) }]);
}

// ── scan_runs ───────────────────────────────────────────────────────────────

/**
 * One row per tick. This is the "is the pipeline alive?" answer and the home of
 * the uniqueness assertion. A plain INSERT is correct here: run_id is a fresh
 * UUID per tick, so there is nothing to collide with. (job_snapshots is the
 * table that may never take a bare INSERT.)
 */
export async function insertScanRun(run) {
  const statement = `
INSERT INTO ${CATALOG_SCHEMA}.scan_runs (
  run_id, started_at, finished_at, boards_attempted, boards_ok, boards_failed,
  postings_seen, postings_new, postings_us, postings_fresh, postings_undated,
  total_rows, distinct_job_ids, error_message
) VALUES (
  :run_id, CAST(:started_at AS TIMESTAMP), CAST(:finished_at AS TIMESTAMP),
  :boards_attempted, :boards_ok, :boards_failed,
  :postings_seen, :postings_new, :postings_us, :postings_fresh, :postings_undated,
  :total_rows, :distinct_job_ids, :error_message
)`;
  const int = (name, value) => ({ name, value: String(value ?? 0), type: 'INT' });
  const big = (name, value) => ({ name, value: String(value ?? 0), type: 'BIGINT' });
  await sql(statement, [
    { name: 'run_id', value: run.run_id },
    { name: 'started_at', value: run.started_at },
    { name: 'finished_at', value: run.finished_at },
    int('boards_attempted', run.boards_attempted),
    int('boards_ok', run.boards_ok),
    int('boards_failed', run.boards_failed),
    int('postings_seen', run.postings_seen),
    int('postings_new', run.postings_new),
    int('postings_us', run.postings_us),
    int('postings_fresh', run.postings_fresh),
    int('postings_undated', run.postings_undated),
    big('total_rows', run.total_rows),
    big('distinct_job_ids', run.distinct_job_ids),
    // error_message is the one field that can carry text derived from a remote
    // server's response, so it is bound like everything else.
    { name: 'error_message', value: run.error_message ?? null },
  ]);
}

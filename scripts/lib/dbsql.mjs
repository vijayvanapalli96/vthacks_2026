/**
 * dbsql.mjs — Databricks SQL Statement Execution API client for repo scripts.
 *
 * Deliberately a separate, dependency-free copy of the idea in
 * app/vthacks-career-app/src/lib/databricks.ts rather than an import of it:
 *   * the app copy is TypeScript inside the Next build and caps polling at 90s,
 *     which is far too short for the stage-0 embedding statements here;
 *   * scripts must run with plain `node`, no bundler, no npm install.
 *
 * AUTH: shells out to `databricks auth token -p TEAM`, reusing the CLI login.
 * This workspace has PATs disabled, so there is no other local path in.
 *
 * EVERY value that came from outside this repo is bound as a NAMED PARAMETER.
 * Job descriptions and titles come from the open internet; they are hostile
 * input and are never interpolated into a statement.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WAREHOUSE_ID = process.env.DATABRICKS_WAREHOUSE_ID ?? '441b670a0ff475e0';
export const HOST = (
  process.env.DATABRICKS_HOST ?? 'https://dbc-0bfd7b56-c2eb.cloud.databricks.com'
).replace(/\/+$/, '');
export const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE ?? 'TEAM';
export const CATALOG = 'workspace';
export const SCHEMA = 'vthacks_2026';
export const FQ = `${CATALOG}.${SCHEMA}`;

const CLI =
  process.env.DATABRICKS_CLI_PATH ??
  'C:/Users/Tarang/AppData/Local/Microsoft/WinGet/Links/databricks.exe';

/**
 * Hard API limit: 1,048,576 characters of combined bound parameters per
 * statement. The job pipeline hit this. Exported so callers can chunk against a
 * real number instead of a guess; the margin covers the statement text itself.
 */
export const PARAM_CHAR_LIMIT = 1_048_576;
export const PARAM_CHAR_BUDGET = 900_000;

let cachedToken = null;

async function bearerToken() {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.token;
  const { stdout } = await execFileAsync(CLI, ['auth', 'token', '-p', PROFILE], {
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  cachedToken = {
    token: parsed.access_token,
    expiresAt: parsed.expiry ? Date.parse(parsed.expiry) : Date.now() + 10 * 60_000,
  };
  return cachedToken.token;
}

async function api(path, init = {}) {
  const res = await fetch(`${HOST}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${await bearerToken()}`,
      'content-type': 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Databricks ${path} -> ${res.status} ${text}`);
  return JSON.parse(text);
}

export class DbsqlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DbsqlError';
  }
}

/**
 * Run ONE statement. The API takes one statement per request — it does not take
 * scripts — so callers loop, they do not concatenate with semicolons.
 *
 * @param {string} statement
 * @param {{name: string, value: string|null, type?: string}[]} parameters
 * @param {{pollLimitMs?: number, waitTimeout?: string}} [options]
 * @returns {Promise<{columns: string[], rows: (string|null)[][], statementId: string,
 *                    chunkCount: number}>}
 */
export async function sql(statement, parameters = [], options = {}) {
  const pollLimitMs = options.pollLimitMs ?? 20 * 60_000;
  const bound = parameters.map((p) => ({
    name: p.name,
    value: p.value,
    type: p.type ?? 'STRING',
  }));
  const boundChars = bound.reduce((n, p) => n + (p.value ? String(p.value).length : 0), 0);
  if (boundChars > PARAM_CHAR_LIMIT) {
    throw new DbsqlError(
      `bound parameters total ${boundChars} chars, over the ${PARAM_CHAR_LIMIT} API limit — chunk the write`,
    );
  }

  let response = await api('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify({
      warehouse_id: WAREHOUSE_ID,
      statement,
      catalog: CATALOG,
      schema: SCHEMA,
      parameters: bound,
      wait_timeout: options.waitTimeout ?? '30s',
      on_wait_timeout: 'CONTINUE',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
    }),
  });

  const deadline = Date.now() + pollLimitMs;
  // 2s: the warehouse cold-starts in 20-30s and the embedding statements run for
  // minutes. Polling is cheap; do NOT tighten this into a busy loop.
  while (
    (response.status?.state === 'PENDING' || response.status?.state === 'RUNNING') &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 2_000));
    response = await api(`/api/2.0/sql/statements/${response.statement_id}`);
  }

  if (response.status?.state !== 'SUCCEEDED') {
    throw new DbsqlError(
      `statement ${response.status?.state ?? 'unknown'}: ${
        response.status?.error?.message ?? 'no error message'
      }`,
    );
  }

  const columns = response.manifest?.schema?.columns?.map((c) => c.name) ?? [];
  let rows = response.result?.data_array ?? [];
  // Large results arrive as external chunks. Only the first is inline.
  const total = response.manifest?.total_chunk_count ?? 1;
  for (let i = 1; i < total; i += 1) {
    const chunk = await api(`/api/2.0/sql/statements/${response.statement_id}/result/chunks/${i}`);
    rows = rows.concat(chunk.data_array ?? []);
  }
  return { columns, rows, statementId: response.statement_id, chunkCount: total };
}

/** First cell of the first row, or undefined. */
export function cell(result) {
  return result.rows[0]?.[0] ?? undefined;
}

/** Rows as objects keyed by column name. */
export function objects(result) {
  return result.rows.map((row) => {
    const out = {};
    result.columns.forEach((name, i) => {
      out[name] = row[i];
    });
    return out;
  });
}

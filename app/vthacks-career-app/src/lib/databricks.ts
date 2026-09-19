/**
 * databricks.ts — minimal SQL client over the Statement Execution API.
 *
 * AUTH, in priority order:
 *   1. DATABRICKS_TOKEN                          — a PAT, if the workspace allows them
 *   2. DATABRICKS_CLIENT_ID/_SECRET              — OAuth M2M; Databricks Apps injects these
 *   3. `databricks auth token -p <profile>`      — local dev, reuses your CLI login
 *
 * (3) exists because this workspace has PATs disabled ("User does not have
 * permission to use tokens" on Free Edition), so local development has no other
 * way in. It shells out to the CLI, which is fine on a laptop and never used in
 * the app runtime, where (2) applies.
 *
 * All statements are PARAMETERIZED. Email addresses come from user input and must
 * never be concatenated into SQL.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SqlParam = {
  name: string;
  value: string | null;
  type?: 'STRING' | 'TIMESTAMP' | 'INT' | 'BOOLEAN' | 'DOUBLE' | 'BIGINT';
};

/** Thrown for anything Databricks-shaped, so callers can tell it from a parse bug. */
export class DatabricksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabricksError';
  }
}

export type SqlResult = {
  columns: string[];
  rows: (string | null)[][];
};

const WAIT_TIMEOUT = '30s';
const POLL_LIMIT_MS = 90_000;
const POLL_INTERVAL_MS = 1_500;

let cached: { token: string; expiresAt: number } | null = null;

function host(): string {
  const value = process.env.DATABRICKS_HOST;
  if (!value) throw new DatabricksError('DATABRICKS_HOST is not set');
  return value.replace(/\/+$/, '');
}

/** The workspace origin, for callers that need a non-SQL endpoint (the Files API). */
export function databricksHost(): string {
  return host();
}

/**
 * Is there any chance a Databricks call will work?
 *
 * Host and warehouse are required. A credential is NOT checked here because the
 * CLI-token path (local dev) leaves no environment variable to look at — the only
 * way to know it works is to try.
 */
export function hasDatabricks(): boolean {
  return Boolean(process.env.DATABRICKS_HOST && process.env.DATABRICKS_WAREHOUSE_ID);
}

function warehouseId(): string {
  const value = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!value) throw new Error('DATABRICKS_WAREHOUSE_ID is not set');
  return value;
}

async function tokenFromCli(): Promise<{ token: string; expiresAt: number }> {
  const cli = process.env.DATABRICKS_CLI_PATH ?? 'databricks';
  const profile = process.env.DATABRICKS_CONFIG_PROFILE ?? 'TEAM';
  const { stdout } = await execFileAsync(cli, ['auth', 'token', '-p', profile], {
    timeout: 60_000,
    windowsHide: true,
  });
  const parsed = JSON.parse(stdout) as { access_token: string; expiry?: string };
  const expiresAt = parsed.expiry ? Date.parse(parsed.expiry) : Date.now() + 10 * 60_000;
  return { token: parsed.access_token, expiresAt };
}

async function tokenFromClientCredentials(
  clientId: string,
  clientSecret: string,
): Promise<{ token: string; expiresAt: number }> {
  const res = await fetch(`${host()}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all-apis' }),
  });
  if (!res.ok) throw new Error(`OAuth token request failed: ${res.status} ${await res.text()}`);
  const parsed = (await res.json()) as { access_token: string; expires_in?: number };
  return {
    token: parsed.access_token,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
  };
}

export async function bearerToken(): Promise<string> {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;

  // 60s of slack so a long query never runs off the end of its own token.
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const clientId = process.env.DATABRICKS_CLIENT_ID;
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
  cached =
    clientId && clientSecret
      ? await tokenFromClientCredentials(clientId, clientSecret)
      : await tokenFromCli();
  return cached.token;
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${host()}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${await bearerToken()}`,
      'content-type': 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Databricks ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

type StatementResponse = {
  statement_id?: string;
  status?: { state?: string; error?: { message?: string } };
  manifest?: { schema?: { columns?: { name: string }[] } };
  result?: { data_array?: (string | null)[][] };
};

function shape(response: StatementResponse): SqlResult {
  return {
    columns: response.manifest?.schema?.columns?.map((column) => column.name) ?? [],
    rows: response.result?.data_array ?? [],
  };
}

/**
 * Run one statement and return its rows. Polls while the warehouse wakes up —
 * a stopped Serverless Starter warehouse cold-starts in 20-30s, which is exactly
 * why the first sign-in after an idle period feels slow.
 */
export async function sql(statement: string, parameters: SqlParam[] = []): Promise<SqlResult> {
  let response = (await api('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify({
      warehouse_id: warehouseId(),
      statement,
      parameters: parameters.map((parameter) => ({
        name: parameter.name,
        value: parameter.value,
        type: parameter.type ?? 'STRING',
      })),
      wait_timeout: WAIT_TIMEOUT,
      on_wait_timeout: 'CONTINUE',
    }),
  })) as StatementResponse;

  const deadline = Date.now() + POLL_LIMIT_MS;
  while (
    (response.status?.state === 'PENDING' || response.status?.state === 'RUNNING') &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    response = (await api(`/api/2.0/sql/statements/${response.statement_id}`)) as StatementResponse;
  }

  const state = response.status?.state;
  if (state !== 'SUCCEEDED') {
    throw new DatabricksError(
      `Databricks statement ${state ?? 'unknown'}: ${response.status?.error?.message ?? 'no error message'}`,
    );
  }
  return shape(response);
}

/** First cell of the first row, or undefined. Saves the rows[0]?.[0] dance. */
export function firstCell(result: SqlResult): string | undefined {
  return result.rows[0]?.[0] ?? undefined;
}

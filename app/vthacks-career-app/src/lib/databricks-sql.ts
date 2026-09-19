/**
 * databricks-sql.ts — thin client for the Databricks SQL Statement Execution API.
 *
 * Shared by the extraction provider (ai_query) and profile memory (INSERT), so
 * there is exactly one place that knows about auth, cold starts and polling.
 *
 * Two things this file exists to get right:
 *
 *  1. NAMED PARAMETERS, ALWAYS. Resume text goes in as a `:param`, never
 *     interpolated into the statement string. Resume text is untrusted input that
 *     contains apostrophes, semicolons and occasionally literal SQL, and we are
 *     handing it to a SQL engine.
 *  2. COLD STARTS. The Serverless Starter warehouse stops when idle and takes
 *     20-30s to wake. That is a demo-killer if it happens on stage, so we wait
 *     generously, poll, and emit a loud warning telling the caller to warm it.
 *
 * Config: DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID.
 */

const WAIT_TIMEOUT_SECONDS = 30;
const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_MS = 120_000;

export type SqlParameter = {
  name: string;
  value: string | null;
  type?: string;
};

export type SqlResult = {
  rows: string[][];
  /** True when the warehouse had to wake up, so callers can warn the operator. */
  wasColdStart: boolean;
};

export class DatabricksSqlError extends Error {
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = 'DatabricksSqlError';
    this.status = options?.status;
  }
}

export type DatabricksConfig = {
  host: string;
  token: string;
  warehouseId: string;
};

/**
 * Resolve credentials, or null when unconfigured. Callers MUST treat null as
 * "degrade gracefully", never as an error: local dev has no Databricks token and
 * the app still has to run.
 */
export function getDatabricksConfig(): DatabricksConfig | null {
  const host = process.env.DATABRICKS_HOST?.trim().replace(/\/+$/, '');
  const token = process.env.DATABRICKS_TOKEN?.trim();
  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID?.trim();
  if (!host || !token || !warehouseId) return null;
  return { host, token, warehouseId };
}

export function hasDatabricks(): boolean {
  return getDatabricksConfig() !== null;
}

type StatementResponse = {
  statement_id?: string;
  status?: { state?: string; error?: { message?: string } };
  result?: { data_array?: string[][] };
};

async function request(
  config: DatabricksConfig,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<StatementResponse> {
  const response = await fetch(`${config.host}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new DatabricksSqlError(
      `Databricks SQL API returned ${response.status}: ${raw.slice(0, 400)}`,
      { status: response.status },
    );
  }

  try {
    return JSON.parse(raw) as StatementResponse;
  } catch (cause) {
    throw new DatabricksSqlError('Databricks SQL API returned a non-JSON body.', { cause });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute a statement and return its rows. Polls through the warehouse cold
 * start rather than failing, up to MAX_POLL_MS.
 */
export async function executeStatement(
  statement: string,
  parameters: SqlParameter[] = [],
  config: DatabricksConfig | null = getDatabricksConfig(),
): Promise<SqlResult> {
  if (!config) {
    throw new DatabricksSqlError(
      'Databricks is not configured. Set DATABRICKS_HOST, DATABRICKS_TOKEN and DATABRICKS_WAREHOUSE_ID.',
    );
  }

  let payload = await request(config, '/api/2.0/sql/statements', {
    method: 'POST',
    body: {
      statement,
      warehouse_id: config.warehouseId,
      parameters,
      wait_timeout: `${WAIT_TIMEOUT_SECONDS}s`,
      on_wait_timeout: 'CONTINUE',
      format: 'JSON_ARRAY',
      disposition: 'INLINE',
    },
  });

  let wasColdStart = false;
  const startedAt = Date.now();

  while (isPending(payload.status?.state)) {
    wasColdStart = true;
    if (Date.now() - startedAt > MAX_POLL_MS) {
      throw new DatabricksSqlError(
        `Warehouse ${config.warehouseId} did not return within ${Math.round(MAX_POLL_MS / 1000)}s. ` +
          'Warm it before demoing: databricks warehouses get <id> -p TEAM',
      );
    }
    await sleep(POLL_INTERVAL_MS);
    const statementId = payload.statement_id;
    if (!statementId) {
      throw new DatabricksSqlError('Databricks SQL API omitted statement_id while still pending.');
    }
    payload = await request(config, `/api/2.0/sql/statements/${statementId}`, { method: 'GET' });
  }

  const state = payload.status?.state;
  if (state !== 'SUCCEEDED') {
    const detail = payload.status?.error?.message ?? 'no error message returned';
    throw new DatabricksSqlError(`Statement ${state ?? 'UNKNOWN'}: ${detail}`);
  }

  if (wasColdStart) {
    console.warn(
      '[databricks] warehouse cold-started (20-30s). Fire a dummy query ~2 minutes before the demo so it is warm on stage.',
    );
  }

  return { rows: payload.result?.data_array ?? [], wasColdStart };
}

function isPending(state: string | undefined): boolean {
  return state === 'PENDING' || state === 'RUNNING';
}

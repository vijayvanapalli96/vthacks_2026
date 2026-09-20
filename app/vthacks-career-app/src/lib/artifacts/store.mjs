/**
 * store.mjs — the `artifacts` table, read and append.
 *
 * APPEND-ONLY BY CONSTRUCTION. There is no UPDATE and no DELETE in this file,
 * and that is a decision rather than an omission:
 *
 *   * Regenerating a cover letter writes a NEW row. The history of what was
 *     generated for a job survives, which is what makes `verification_json`
 *     worth storing at all — a verdict you can overwrite is not an audit trail.
 *   * `tarangnair98@gmail.com` / `3027b072-2f8c-4960-b3c3-33f63569b50a` is a
 *     live human account. Inserting artifacts rows for it is fine; mutating any
 *     of its rows is not. With no UPDATE path in the module there is nothing to
 *     get wrong under pressure at 3 AM.
 *
 * `volume_path` is written as NULL. The column exists for a rendered PDF in a UC
 * Volume, and we do not produce one: the PDF path here is the browser's own
 * print dialog (see render-html.mjs), so there is no file to point at. Writing a
 * path to a file that does not exist would be worse than NULL. Vijay's
 * `documents` Volume is not touched by anything in this feature.
 */

/** @typedef {import('../match/profile.mjs').SqlFn} SqlFn */

const FQ = 'workspace.vthacks_2026';

/**
 * The closed set of `kind` values. `artifacts.kind` shipped commented
 * `resume | cover_letter | email`; `answers` and `analysis` are additive and no
 * existing value changes meaning. Enforced here because Delta on this warehouse
 * has no CHECK constraint worth the DDL hours before ship, and an unenforced
 * closed set becomes an open one within a week.
 */
export const VALID_KINDS = new Set(['resume', 'cover_letter', 'email', 'answers', 'analysis']);

/**
 * Append one generated document.
 *
 * EVERY value is a NAMED PARAMETER. `content_text` is model output and
 * `source_job_title` is scraped from a job board — both are untrusted strings
 * and neither is ever interpolated into the statement.
 *
 * `created_at` is `current_timestamp()` on the warehouse rather than a
 * client-side ISO string: the app can run on a laptop in one timezone and in
 * Databricks Apps in another, and two rows whose ordering depends on which host
 * wrote them is a bug that only shows up in the demo.
 *
 * @param {SqlFn} sql
 * @param {{userId: string, jobId: string, kind: string, contentText: string,
 *          modelProvider: string|null, modelName: string|null,
 *          verification: unknown, sourceJobTitle: string|null}} row
 * @returns {Promise<string>} the new artifact_id
 */
export async function insertArtifact(sql, row) {
  if (!VALID_KINDS.has(row.kind)) {
    throw new Error(`artifacts.kind must be one of ${[...VALID_KINDS].join(', ')} — got ${row.kind}`);
  }
  const artifactId = crypto.randomUUID();

  await sql(
    `INSERT INTO ${FQ}.artifacts
       (artifact_id, user_id, job_id, kind, volume_path, created_at,
        content_text, model_provider, model_name, verification_json, source_job_title)
     VALUES
       (:artifact_id, :user_id, :job_id, :kind, NULL, current_timestamp(),
        :content_text, :model_provider, :model_name, :verification_json, :source_job_title)`,
    [
      { name: 'artifact_id', value: artifactId },
      { name: 'user_id', value: row.userId },
      { name: 'job_id', value: row.jobId },
      { name: 'kind', value: row.kind },
      { name: 'content_text', value: row.contentText },
      { name: 'model_provider', value: row.modelProvider ?? null },
      { name: 'model_name', value: row.modelName ?? null },
      { name: 'verification_json', value: row.verification == null ? null : JSON.stringify(row.verification) },
      { name: 'source_job_title', value: row.sourceJobTitle ?? null },
    ],
  );
  return artifactId;
}

/**
 * What has already been generated for one job.
 *
 * `content_text` comes back in full: the point of the list is that the student
 * can reopen a letter they generated an hour ago without paying for another
 * model call, and a list that only returns metadata would force one.
 *
 * The verdict is surfaced as its own column via `get_json_object` so a blocked
 * document is identifiable without parsing every verification blob on the client
 * — and so it is impossible to render the list without noticing which rows
 * failed the gate.
 *
 * @param {SqlFn} sql
 * @param {string} userId
 * @param {string} jobId
 */
export async function listArtifacts(sql, userId, jobId) {
  const result = await sql(
    `SELECT artifact_id, kind, model_provider, model_name,
            content_text, verification_json, source_job_title,
            get_json_object(verification_json, '$.verdict') AS verdict,
            CAST(created_at AS STRING) AS created_at
       FROM ${FQ}.artifacts
      WHERE user_id = :user_id AND job_id = :job_id
      ORDER BY created_at DESC
      LIMIT 50`,
    [
      { name: 'user_id', value: userId },
      { name: 'job_id', value: jobId },
    ],
  );

  const index = Object.fromEntries(result.columns.map((c, i) => [c, i]));
  return result.rows.map((row) => {
    let verification = null;
    const rawVerification = row[index.verification_json];
    if (typeof rawVerification === 'string' && rawVerification.trim()) {
      try {
        verification = JSON.parse(rawVerification);
      } catch {
        // A row whose verification blob will not parse is reported as unverified
        // rather than as clean. Defaulting to `null` here and to "no findings" in
        // the UI would render an unreadable verdict as a pass, which is the one
        // direction this feature must never fail in.
        verification = { verdict: 'unreadable', findings: [] };
      }
    }
    return {
      artifact_id: row[index.artifact_id],
      kind: row[index.kind],
      model_provider: row[index.model_provider],
      model_name: row[index.model_name],
      content_text: row[index.content_text],
      source_job_title: row[index.source_job_title],
      created_at: row[index.created_at],
      verdict: row[index.verdict] ?? verification?.verdict ?? null,
      verification,
      downloadable: (row[index.verdict] ?? verification?.verdict) !== 'block',
    };
  });
}

/** One artifact by id, scoped to its owner. Used by the print view. */
export async function getArtifact(sql, userId, artifactId) {
  const result = await sql(
    `SELECT artifact_id, job_id, kind, content_text, verification_json,
            source_job_title, model_name,
            get_json_object(verification_json, '$.verdict') AS verdict,
            CAST(created_at AS STRING) AS created_at
       FROM ${FQ}.artifacts
      WHERE artifact_id = :artifact_id AND user_id = :user_id
      LIMIT 1`,
    [
      { name: 'artifact_id', value: artifactId },
      { name: 'user_id', value: userId },
    ],
  );
  if (result.rows.length === 0) return null;
  const index = Object.fromEntries(result.columns.map((c, i) => [c, i]));
  const row = result.rows[0];

  // The stored verdict is parsed HERE rather than at the call site, so the print
  // route has the findings it needs to explain a refusal without a second query
  // — and so an unparseable blob resolves to `unreadable` in exactly one place.
  // `unreadable` is treated as a refusal, not as a pass: defaulting a verdict we
  // cannot read to "fine" would invert the entire gate.
  let verification = null;
  let verdict = row[index.verdict] ?? null;
  const raw = row[index.verification_json];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      verification = JSON.parse(raw);
      verdict = verdict ?? verification?.verdict ?? null;
    } catch {
      verification = { verdict: 'unreadable', findings: [], sentence: 'The stored verification record for this document could not be read, so it is treated as unverified.' };
      verdict = 'unreadable';
    }
  }

  return {
    artifact_id: row[index.artifact_id],
    job_id: row[index.job_id],
    kind: row[index.kind],
    content_text: row[index.content_text] ?? '',
    source_job_title: row[index.source_job_title],
    model_name: row[index.model_name],
    created_at: row[index.created_at],
    verdict,
    verification,
    downloadable: verdict !== 'block' && verdict !== 'unreadable',
  };
}

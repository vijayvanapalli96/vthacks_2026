#!/usr/bin/env node
/**
 * embed-jobs.mjs — STAGE 0 of the match agent: populate `job_embeddings`.
 *
 * `job_embeddings` is deliberately a separate table so `job_snapshots` stays
 * WRITE-ONCE (hard rule 2). Nothing here writes to `job_snapshots`;
 * `description_text` and `raw_payload_json` never appear in an UPDATE SET list
 * because there is no UPDATE at all.
 *
 * SHAPE, and why:
 *   * BATCHED IN SQL, never a call per row. One INSERT ... SELECT does
 *     ai_query('databricks-gte-large-en', ...) over a whole batch of rows; the
 *     warehouse fans it out. A per-row loop over 16k rows would take hours of
 *     warehouse time at ~$2.80/hour and is the single most expensive mistake
 *     available here.
 *   * INCREMENTAL. Only `job_snapshots` rows with no `job_embeddings` row are
 *     selected (NOT EXISTS), so the script is re-runnable and a partial run is
 *     simply resumed. There is no state file.
 *   * failOnError => false. One malformed description must not abort a 2,000-row
 *     batch. Rows whose embedding errored are NOT inserted and ARE counted and
 *     printed, so a silent hole is impossible.
 *   * ORDERED is_us DESC, posted_at DESC. Stage 1 only ever retrieves fresh US
 *     roles, so the rows that make the product work land first and an
 *     interrupted run is still useful.
 *
 * Usage:
 *   node scripts/embed-jobs.mjs --status              # counts only, no writes
 *   node scripts/embed-jobs.mjs                       # run to completion
 *   node scripts/embed-jobs.mjs --batch 500 --max-batches 2
 *   node scripts/embed-jobs.mjs --dry-run             # print the plan, write nothing
 */
import { sql, objects, cell, FQ } from './lib/dbsql.mjs';

/**
 * Rows per ai_query statement. Measured on the 2X-Small serverless warehouse:
 * see the RUN LOG at the bottom of this file for the throughput this was chosen
 * from. Larger batches amortise statement overhead; too large and one failure
 * costs a lot of re-work, since a batch is all-or-nothing at the statement level.
 */
const DEFAULT_BATCH = 2_000;

/**
 * Character cap on the text handed to the embedding model. `databricks-gte-large-en`
 * has an 8,192-token window (~32k characters), and the longest description in the
 * corpus today is 12,506 characters, so this is a guard against a future outlier
 * rather than something that fires now — truncation changes an embedding silently,
 * which is exactly why the cap sits well above the observed maximum instead of at
 * a round number near it.
 */
const MAX_EMBED_CHARS = 16_000;

const EMBEDDING_MODEL = 'databricks-gte-large-en';

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * The text we embed. Title and company carry real signal a bare description can
 * miss (many ATS bodies never restate the title), and they are cheap.
 */
const EMBED_TEXT_SQL = `SUBSTR(
        CONCAT_WS('\\n',
          s.job_title,
          s.company_name,
          COALESCE(s.location_text, ''),
          COALESCE(s.description_text, '')
        ), 1, ${MAX_EMBED_CHARS})`;

async function status() {
  const r = await sql(`
    SELECT
      (SELECT COUNT(*) FROM ${FQ}.job_snapshots)                      AS snapshots,
      (SELECT COUNT(*) FROM ${FQ}.job_embeddings)                     AS embedded,
      (SELECT COUNT(*) FROM ${FQ}.job_snapshots s
        WHERE NOT EXISTS (SELECT 1 FROM ${FQ}.job_embeddings e WHERE e.job_id = s.job_id)
          AND s.description_text IS NOT NULL AND LENGTH(s.description_text) > 0) AS pending,
      (SELECT COUNT(*) FROM ${FQ}.job_snapshots s
        WHERE s.description_text IS NULL OR LENGTH(s.description_text) = 0)      AS no_text`);
  return objects(r)[0];
}

/**
 * Embed one batch. Returns how many rows were inserted.
 *
 * The named parameter is the batch size — an integer we generated — but it is
 * still BOUND rather than interpolated, because that is the house rule and an
 * exception is how the rule erodes. No job text is ever interpolated: it never
 * leaves the warehouse.
 */
async function embedBatch(limit) {
  const before = Number(cell(await sql(`SELECT COUNT(*) FROM ${FQ}.job_embeddings`)));
  const started = Date.now();
  const result = await sql(
    `
    INSERT INTO ${FQ}.job_embeddings (job_id, embedding, embedded_at)
    SELECT job_id, CAST(scored.result AS ARRAY<FLOAT>), current_timestamp()
    FROM (
      SELECT job_id,
             ai_query('${EMBEDDING_MODEL}', embed_text, failOnError => false) AS scored
      FROM (
        SELECT s.job_id, ${EMBED_TEXT_SQL} AS embed_text
        FROM ${FQ}.job_snapshots s
        WHERE s.description_text IS NOT NULL
          AND LENGTH(s.description_text) > 0
          AND NOT EXISTS (
            SELECT 1 FROM ${FQ}.job_embeddings e WHERE e.job_id = s.job_id
          )
        ORDER BY s.is_us DESC, s.posted_at DESC
        LIMIT :batch
      )
    ) AS scored_rows
    WHERE scored.errorMessage IS NULL`,
    [{ name: 'batch', value: String(limit), type: 'INT' }],
    { pollLimitMs: 45 * 60_000 },
  );
  const after = Number(cell(await sql(`SELECT COUNT(*) FROM ${FQ}.job_embeddings`)));
  return {
    inserted: after - before,
    seconds: (Date.now() - started) / 1000,
    statementId: result.statementId,
  };
}

async function main(args) {
  const batch = Number(flag(args, 'batch') ?? DEFAULT_BATCH);
  const maxBatches = Number(flag(args, 'max-batches') ?? Infinity);
  const dryRun = args.includes('--dry-run');

  const before = await status();
  console.log(
    `job_snapshots=${before.snapshots} embedded=${before.embedded} pending=${before.pending} no_text=${before.no_text}`,
  );
  if (args.includes('--status')) return 0;
  if (dryRun) {
    console.log(
      `[dry-run] would run ceil(${before.pending}/${batch}) = ` +
        `${Math.ceil(Number(before.pending) / batch)} INSERT statements against ${EMBEDDING_MODEL}`,
    );
    return 0;
  }

  const wall = Date.now();
  let statements = 0;
  let inserted = 0;
  let pending = Number(before.pending);

  while (pending > 0 && statements < maxBatches) {
    const r = await embedBatch(Math.min(batch, pending));
    statements += 1;
    inserted += r.inserted;
    // A batch that inserts nothing means every row in it errored, or the
    // NOT EXISTS set is empty. Either way, looping again would spin.
    if (r.inserted === 0) {
      console.log(`batch ${statements}: inserted 0 in ${r.seconds.toFixed(1)}s — stopping`);
      break;
    }
    const now = await status();
    const errored = Math.min(batch, pending) - r.inserted;
    pending = Number(now.pending);
    console.log(
      `batch ${statements}: +${r.inserted} in ${r.seconds.toFixed(1)}s` +
        `${errored > 0 ? ` (${errored} rows errored and were NOT inserted)` : ''}` +
        ` — embedded=${now.embedded} pending=${pending}`,
    );
  }

  const after = await status();
  const mins = (Date.now() - wall) / 60_000;
  console.log(
    `\nSTAGE 0 DONE — inserted ${inserted} embeddings in ${statements} statements, ` +
      `${mins.toFixed(1)} min wall clock (~$${(mins * (2.8 / 60)).toFixed(2)} of warehouse time at $2.80/hr).\n` +
      `job_embeddings=${after.embedded} pending=${after.pending} rows_with_no_description=${after.no_text}`,
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });

// ─────────────────────────────────────────────────────────────────────────────
// RUN LOG — real numbers, so the next person does not have to re-measure.
//
// 2026-09-19, warehouse 441b670a0ff475e0 (Serverless Starter, 2X-Small), cold start:
//
//   batch  10 ->   7.1s   (statement overhead dominates at this size)
//   batch 500 ->  12.2s   (~41 rows/s)
//   batch 2000 -> 18.8-23.4s each, 8 statements (~90 rows/s)
//
//   TOTAL: 16,206 embeddings, 10 statements, ~4.0 min wall clock end to end,
//          ~$0.19 of warehouse time at $2.80/hour.
//
//   16,207 job_snapshots rows in, 16,206 embedded. The one row not embedded has
//   an EMPTY description_text and is excluded by the LENGTH(...) > 0 guard, not
//   dropped by an error. Zero ai_query errors across the whole corpus.
//
//   Verified after the run: COUNT(*) = COUNT(DISTINCT job_id) = 16,206, every
//   SIZE(embedding) = 1024, zero NULL embeddings.
//
// 2,000 is the batch size to keep: throughput is flat from there and a failure
// costs at most ~23s of re-work.
// ─────────────────────────────────────────────────────────────────────────────

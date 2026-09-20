-- ============================================================================
-- schema-artifacts.sql — the generated-document columns on `artifacts`.
--
-- WHY THIS IS A SEPARATE FILE AND NOT SECTION 8 OF sql/schema.sql:
-- `feat/pipeline` is appending its own SECTION 8 to `schema.sql` on a parallel
-- branch right now. Two agents appending to the end of the same file on the
-- same afternoon is a guaranteed conflict with no upside. FOLD THIS INTO
-- sql/schema.sql AFTER BOTH BRANCHES LAND — it is a section, not a schema.
--
-- WHY THE ALTER IS NOT GUARDED:
-- `ALTER TABLE ... ADD COLUMNS IF NOT EXISTS` is a PARSE ERROR on this
-- warehouse (Databricks SQL, serverless 2X-Small). There is no idempotent form.
-- So: run `DESCRIBE TABLE workspace.vthacks_2026.artifacts` FIRST and only run
-- the ALTER if the five columns are absent. Re-running it fails with
-- "Cannot add column, because <name> already exists" — annoying, not harmful.
--
-- Applied against workspace `dbc-0bfd7b56-c2eb` on 2026-09-19. Confirmed before
-- the ALTER that `artifacts` held exactly the original six columns
-- (artifact_id, user_id, job_id, kind, volume_path, created_at) and zero rows.
-- ============================================================================

-- ── Step 1: look before you leap ────────────────────────────────────────────
-- DESCRIBE TABLE workspace.vthacks_2026.artifacts;

-- ── Step 2: the columns a generated document needs ──────────────────────────
--
-- `artifacts` shipped with `volume_path` and no text column. A UC Volume path
-- is the right long-term home for a rendered PDF, but it is the wrong home for
-- the thing this feature actually produces: a document that must be READ BACK
-- to be displayed, and — the load-bearing reason — re-read to be VERIFIED. The
-- fact gate compares claim-by-claim against `profile_current`, so the text has
-- to be addressable in SQL, not behind a file fetch.
--
-- `verification_json` is the column that makes this feature honest rather than
-- dangerous. It stores the full `verify-cv-facts` verdict — every claim and
-- whether the profile supports it — alongside the text it judged. Without it
-- there is no way to answer "was this document checked?" after the fact, and a
-- cover-letter generator whose verification you cannot audit is a cover-letter
-- generator with no verification.

ALTER TABLE workspace.vthacks_2026.artifacts ADD COLUMNS (
  content_text      STRING  COMMENT 'The generated document itself. Plain text; the print view renders it.',
  model_provider    STRING  COMMENT 'databricks | none. "none" for a Tier 1 analysis persisted as an artifact.',
  model_name        STRING  COMMENT 'e.g. databricks-llama-4-maverick. NULL when model_provider = none.',
  verification_json STRING  COMMENT 'verify-cv-facts verdict: {verdict, invented[], unsupportedFacts[], forbidden[], warnings[], coverage, findings[]}. A row whose verdict is "block" was shown to the user WITH its failing claims and offered no download.',
  source_job_title  STRING  COMMENT 'job_title as it read at generation time. job_snapshots is write-once so this is redundant today, but a document is a point-in-time artifact and should carry the title it was written against.'
);

-- ── Step 3: what the app relies on, stated so it is testable ────────────────
--
-- Nothing here is enforced by a constraint (Delta has no CHECK on this
-- warehouse worth the DDL at T-minus-hours), so it is enforced in
-- `src/lib/artifacts/store.mjs` and written down here:
--
--   * `kind` ∈ {'resume', 'cover_letter', 'email', 'answers', 'analysis'}.
--     The original comment on the column said `resume | cover_letter | email`.
--     'answers' is the application-answers document; 'analysis' is a persisted
--     Tier 1 read. Both are additive — no existing value changes meaning.
--   * `artifact_id` is a UUID minted by the app.
--   * Rows are INSERT-only. Nothing in this feature UPDATEs or DELETEs an
--     artifacts row: a regenerated document is a NEW row, so the history of
--     what was generated for a job survives. That also means the live human
--     account (tarangnair98@gmail.com / 3027b072-2f8c-4960-b3c3-33f63569b50a)
--     is never mutated, only appended to.
--   * `job_id` is validated against `job_snapshots` before any insert. An
--     artifact for a job that does not exist is unreadable later.

-- ── Step 4: read it back ────────────────────────────────────────────────────
-- SELECT artifact_id, kind, model_provider, model_name,
--        LENGTH(content_text) AS chars,
--        get_json_object(verification_json, '$.verdict') AS verdict,
--        source_job_title, CAST(created_at AS STRING) AS created_at
--   FROM workspace.vthacks_2026.artifacts
--  WHERE user_id = :user_id
--  ORDER BY created_at DESC;

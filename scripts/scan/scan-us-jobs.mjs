#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scan-us-jobs.mjs — ONE TICK of the HIREWIRE job discovery pipeline.
//
// Every 5 minutes: fetch the least-recently-scanned slice of employer boards
// over their public JSON APIs, and MERGE every posting found into
// workspace.vthacks_2026.job_snapshots, one row per posting, forever.
//
// ZERO TOKENS. No LLM, no Playwright, no scraping, no headless browser. Provider
// modules lifted from career-ops hit each ATS's own public JSON endpoint. That
// property is what makes a 5-minute cadence affordable at all; do not break it.
//
// STORE EVERYTHING. US-ness and freshness are COLUMNS (is_us, posted_at,
// location_confidence), never a discard. A dropped row cannot be re-examined
// when the filter turns out to have been wrong, and the US filter being subtly
// wrong is the most likely silent failure here (plan §6.3).
//
// Usage:
//   node scan-us-jobs.mjs                 one tick against the live workspace
//   node scan-us-jobs.mjs --seed-boards   upsert boards.json into job_boards
//   node scan-us-jobs.mjs --dry-run       fetch + classify, write NOTHING
//   node scan-us-jobs.mjs --dry-run --all fetch EVERY board in boards.json
//                                         (this is how the seed list is verified)
//   node scan-us-jobs.mjs --slice 20      override the slice size for one run
//   node scan-us-jobs.mjs --json          machine-readable summary on stdout
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeHttpCtx } from './lib/providers/_http.mjs';
import ashby from './lib/providers/ashby.mjs';
import greenhouse from './lib/providers/greenhouse.mjs';
import lever from './lib/providers/lever.mjs';
import workday from './lib/providers/workday.mjs';
import icims from './lib/providers/icims.mjs';
import normalizeUrl from './lib/url-key.mjs';
import { classifyLocation } from './lib/location-us.mjs';
import { acquireTickLock } from './lib/lock.mjs';
import {
  claimBoardSlice,
  countRowsAndKeys,
  existingJobIds,
  insertScanRun,
  mergeJobSnapshots,
  recordBoardHealth,
  seedBoards,
} from './lib/sink-databricks.mjs';

// ── Config ──────────────────────────────────────────────────────────────────

// Boards per tick. THIS NUMBER STARTED AS A GUESS (docs/JOB_PIPELINE_PLAN.md
// §7.3) — "10 boards should finish in ~90s" was written before anything had been
// timed. Measured on 2026-09-19 against the live warehouse, 74 seeded boards:
//
//   all 74 boards, fetch only ............  30s   (16,206 postings)
//   10-board tick, first capture .........  51-144s (dominated by MERGE round
//                                           trips, not by fetching)
//   10-board tick, steady state ..........  15-18s
//
// Kept at 10: steady state is what the 5-minute cron actually sees, and the only
// ticks that exceed 90s are the ones capturing a big board (Anduril alone is
// ~2,400 postings) for the FIRST time. An overrun is safe rather than harmful,
// because the next tick exits on the lock instead of running alongside. If ticks
// start routinely overrunning, lower this rather than lengthening the cron.
// 74 boards at 10 per tick = every board revisited about every 40 minutes.
const SLICE_SIZE = 10;

// "Open right now" is a claim about the source, not a fact (plan §6.1). 3 days
// is career-ops' default and what the open_us_jobs view uses.
const FRESHNESS_DAYS = 3;

// Global cap on boards in flight. Ashby gets a tighter one of its own: its
// public posting-api has a ~10s server-side latency floor and rate-limits
// repeated anonymous hits, so hammering it in parallel is how a tick starts
// failing for reasons that look like our bug (see lib/providers/ashby.mjs).
const CONCURRENCY = 6;
const PROVIDER_CONCURRENCY = { ashby: 2 };

// Per-request ceiling for board fetches. See the ctx construction in main() for
// why this is not the 10s default the lifted providers would otherwise use.
const BOARD_TIMEOUT_MS = 25_000;

// A board that fails backs off exponentially: 5m, 10m, 20m … capped at 6h.
// Without this we re-hit a dead board every 5 minutes forever.
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;

// Write-once means a truncation here is permanent, so these are generous. A
// typical JD is 3-8k characters.
const DESCRIPTION_MAX = 60_000;
const RAW_PAYLOAD_MAX = 20_000;

const PROVIDERS = { ashby, greenhouse, lever, workday, icims };

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── Small helpers ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
function flagValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

function truncate(text, max, marker) {
  if (typeof text !== 'string') return '';
  return text.length <= max ? text : `${text.slice(0, max)}${marker}`;
}

/**
 * Run tasks with a global cap AND an optional tighter per-provider cap. The
 * per-provider cap is not decoration: one provider (Ashby) rate-limits repeated
 * anonymous hits, and a global-only limit would happily put six of them in
 * flight at once. `keyOf(task)` reads the provider id attached to the closure.
 */
async function pooled(tasks, limit, keyOf, perKeyLimit) {
  const queue = [...tasks];
  const inFlight = new Map();
  async function worker() {
    for (;;) {
      let index = -1;
      for (let i = 0; i < queue.length; i += 1) {
        const key = keyOf(queue[i]);
        const cap = perKeyLimit[key];
        if (cap === undefined || (inFlight.get(key) ?? 0) < cap) {
          index = i;
          break;
        }
      }
      if (index === -1) {
        // Either nothing left, or everything left is at its provider's cap.
        if (queue.length === 0) return;
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      const [task] = queue.splice(index, 1);
      const key = keyOf(task);
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      try {
        await task();
      } finally {
        inFlight.set(key, (inFlight.get(key) ?? 0) - 1);
      }
    }
  }
  const workers = Math.max(1, Math.min(limit, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
}

/**
 * The job identity. Provider key first — Workday exposes a requisition id, so
 * the same posting served under several hosts of one tenant collapses to ONE
 * key, which a URL alone can never do. urlKey() is the fallback, and it
 * UNDER-normalises on purpose (see lib/url-key.mjs): leaving two spellings of
 * one posting as two visible rows beats silently merging two different postings.
 *
 * Returns '' when there is nothing to key on. '' is NOT a key — such a posting
 * is skipped rather than stored under a shared empty id.
 */
export function jobIdFor(provider, job) {
  const providerKey = typeof provider?.dedupKey === 'function' ? provider.dedupKey(job) : null;
  if (typeof providerKey === 'string' && providerKey.trim() !== '') return providerKey.trim();
  return normalizeUrl(job?.url ?? '');
}

/** boards.json entry → the PortalEntry shape the lifted providers expect. */
function portalEntryFor(board) {
  return {
    name: board.company_name,
    provider: board.provider,
    api: board.api_url || undefined,
    careers_url: board.careers_url || undefined,
    enabled: true,
  };
}

// ── One tick ────────────────────────────────────────────────────────────────

async function scanBoard(board, ctx) {
  const provider = PROVIDERS[board.provider];
  if (!provider) throw new Error(`no provider module for "${board.provider}"`);
  const jobs = await provider.fetch(portalEntryFor(board), ctx);
  if (!Array.isArray(jobs)) throw new Error(`${board.provider}: fetch() did not return an array`);
  return { provider, jobs };
}

function snapshotRowFor(board, provider, job, nowIso, freshCutoffMs) {
  const jobId = jobIdFor(provider, job);
  if (!jobId) return null;
  const { isUs, confidence } = classifyLocation(job.location, job.url, job.title);
  const postedAtMs = Number.isFinite(job.postedAt) ? job.postedAt : null;
  // raw_payload_json carries the provider-normalised posting MINUS its body,
  // because the body already has its own column and storing it twice doubles
  // every write. This is the normalised Job, not the ATS's own bytes — the
  // pipeline never keeps those (plan §5: no per-job detail fetches).
  const { description, ...withoutBody } = job;
  return {
    row: {
      job_snapshot_id: randomUUID(),
      job_id: jobId,
      source: `${provider.id}-api`,
      source_url: typeof job.url === 'string' ? job.url : '',
      company_name: job.company || board.company_name || '',
      job_title: typeof job.title === 'string' ? job.title : '',
      location_text: typeof job.location === 'string' ? job.location : '',
      description_text: truncate(description ?? '', DESCRIPTION_MAX, '\n\n[truncated by scan-us-jobs.mjs]'),
      discovered_at: nowIso,
      captured_at: nowIso,
      raw_payload_json: truncate(JSON.stringify(withoutBody), RAW_PAYLOAD_MAX, '"}'),
      is_us: isUs,
      posted_at: postedAtMs === null ? null : new Date(postedAtMs).toISOString(),
      location_confidence: confidence,
    },
    isUs,
    fresh: postedAtMs !== null && postedAtMs >= freshCutoffMs,
    undated: postedAtMs === null,
  };
}

async function main() {
  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  const runId = randomUUID();
  const dryRun = hasFlag('--dry-run');
  const scanAll = hasFlag('--all');
  const asJson = hasFlag('--json');
  const sliceSize = Number.parseInt(flagValue('--slice', String(SLICE_SIZE)), 10);
  const freshCutoffMs = startedAt.getTime() - FRESHNESS_DAYS * 24 * 60 * 60_000;

  const boardsFile = JSON.parse(await readFile(path.join(HERE, 'boards.json'), 'utf8'));
  const seeded = boardsFile.boards;

  if (hasFlag('--seed-boards')) {
    const result = await seedBoards(seeded.map(b => ({
      board_id: b.board_id,
      provider: b.provider,
      company_name: b.company_name,
      board_slug: b.board_slug ?? null,
      api_url: b.api_url ?? null,
      careers_url: b.careers_url ?? null,
      country_hint: b.country_hint ?? 'US',
      enabled: b.enabled !== false,
    })));
    console.log(`seeded job_boards: ${seeded.length} entries in boards.json, ${result.inserted} newly inserted`);
    return;
  }

  // The lock guards the WRITE path only. A dry run touches nothing, so it must
  // not be able to block a real tick (and must not be blocked by one).
  const lock = dryRun
    ? { acquired: true, holder: 'dry-run', release: async () => {} }
    : await acquireTickLock();
  if (!lock.acquired) {
    console.log(`⏭  tick ${runId} exiting WITHOUT scanning: ${lock.reason}`);
    console.log('   (this is the single-writer guarantee working — two concurrent MERGEs can both insert the same job_id)');
    process.exitCode = 0;
    return;
  }

  // --boards pins an explicit set and bypasses the rotation. Needed to re-scan
  // the SAME boards a second time on purpose, which is how idempotency is
  // proved: the rotation would otherwise hand the next tick a different slice.
  const pinned = flagValue('--boards', '').split(',').map(s => s.trim()).filter(Boolean);

  let boards;
  if (pinned.length > 0) {
    const wanted = new Set(pinned);
    boards = seeded.filter(b => wanted.has(b.board_id));
    const missing = pinned.filter(id => !boards.some(b => b.board_id === id));
    if (missing.length > 0) throw new Error(`--boards: unknown board_id(s): ${missing.join(', ')}`);
  } else if (scanAll || dryRun) {
    boards = (scanAll ? seeded : seeded.slice(0, sliceSize))
      .filter(b => b.enabled !== false);
  } else {
    boards = await claimBoardSlice(sliceSize);
  }

  // _http.mjs defaults to a 10s timeout, which the biggest Greenhouse boards
  // (Anduril ~2,400 postings, Stripe ~670 with content=true) genuinely exceed —
  // measured: Robinhood, Instacart and Asana all aborted at 10s on the first
  // full sweep, and all three are live boards. A default is injected here rather
  // than editing the lifted provider, and it is spread FIRST so a provider that
  // pins its own timeout (ashby and lever both pass 30s) still wins.
  const http = makeHttpCtx();
  const withTimeout = fn => (url, opts = {}) => fn(url, { timeoutMs: BOARD_TIMEOUT_MS, ...opts });
  const ctx = {
    ...http,
    fetchJson: withTimeout(http.fetchJson),
    fetchText: withTimeout(http.fetchText),
    fetchResponse: withTimeout(http.fetchResponse),
    // workday.mjs reads this: "do not pre-empt the caller's date decision".
    // Postings with no date are stored too — posted_at is simply NULL.
    includeUndated: true,
  };
  const okBoards = [];
  const failedBoards = [];
  const health = [];
  const perBoard = [];
  let postingsSeen = 0;
  let unkeyed = 0;
  const byJobId = new Map();

  const tasks = boards.map((board) => {
    const task = async () => {
      try {
        const { provider, jobs } = await scanBoard(board, ctx);
        postingsSeen += jobs.length;
        let kept = 0;
        for (const job of jobs) {
          const built = snapshotRowFor(board, provider, job, startedIso, freshCutoffMs);
          if (!built) {
            unkeyed += 1;
            continue;
          }
          // De-duplicate by job_id IN MEMORY, before the MERGE. A MERGE whose
          // source carries one key twice errors out, and it happens for real:
          // one Workday requisition served under three hosts of a tenant.
          if (!byJobId.has(built.row.job_id)) byJobId.set(built.row.job_id, built);
          kept += 1;
        }
        okBoards.push(board.board_id);
        perBoard.push({
          board_id: board.board_id, provider: board.provider, postings: jobs.length, kept,
        });
        health.push({
          board_id: board.board_id,
          scanned_at: startedIso,
          ok: true,
          consecutive_failures: 0,
          backoff_until: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failures = Number(board.consecutive_failures ?? 0) + 1;
        const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
        failedBoards.push({ board_id: board.board_id, error: message });
        perBoard.push({ board_id: board.board_id, provider: board.provider, error: message });
        health.push({
          board_id: board.board_id,
          scanned_at: startedIso,
          ok: false,
          consecutive_failures: failures,
          backoff_until: new Date(Date.now() + backoffMs).toISOString(),
        });
        console.error(`✖ ${board.board_id}: ${message}`);
      }
    };
    // pooled() cannot infer a closure's provider, so carry it on the function.
    task.providerId = board.provider;
    return task;
  });

  await pooled(tasks, CONCURRENCY, task => task.providerId ?? 'default', PROVIDER_CONCURRENCY);

  const rows = [...byJobId.values()];
  const postingsUs = rows.filter(r => r.isUs).length;
  const postingsFresh = rows.filter(r => r.fresh).length;
  const postingsUndated = rows.filter(r => r.undated).length;

  let inserted = 0;
  let totals = { totalRows: 0, distinctJobIds: 0 };
  const errors = [];
  if (failedBoards.length > 0) {
    errors.push(`${failedBoards.length} board(s) failed: ${failedBoards.map(f => f.board_id).join(', ')}`);
  }

  let alreadyStored = 0;
  if (!dryRun) {
    try {
      // Ask which keys we already hold and ship only the rest. Purely an
      // optimisation — the MERGE below is still insert-only, so nothing here can
      // create a duplicate even if this set is stale. Setting
      // HIREWIRE_SCAN_FORCE_MERGE=1 skips the pre-filter and sends everything to
      // the MERGE, which is how you demonstrate that the MERGE (not the filter)
      // is what makes a re-scan a no-op.
      const known = process.env.HIREWIRE_SCAN_FORCE_MERGE === '1'
        ? new Set()
        : await existingJobIds(rows.map(r => r.row.job_id));
      const fresh = rows.filter(r => !known.has(r.row.job_id));
      alreadyStored = rows.length - fresh.length;
      const merged = await mergeJobSnapshots(fresh.map(r => r.row));
      inserted = merged.inserted;
      await recordBoardHealth(health);
      totals = await countRowsAndKeys();
      if (totals.totalRows !== totals.distinctJobIds) {
        const loud = `UNIQUENESS ASSERTION FAILED: job_snapshots has ${totals.totalRows} rows `
          + `but only ${totals.distinctJobIds} distinct job_id values `
          + `(${totals.totalRows - totals.distinctJobIds} duplicate rows)`;
        console.error(`\n🚨 ${loud}`);
        console.error('   Something wrote job_snapshots without the MERGE, or two ticks ran at once.');
        errors.push(loud);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`write failed: ${message}`);
      console.error(`✖ write failed: ${message}`);
      process.exitCode = 1;
    }

    try {
      await insertScanRun({
        run_id: runId,
        started_at: startedIso,
        finished_at: new Date().toISOString(),
        boards_attempted: boards.length,
        boards_ok: okBoards.length,
        boards_failed: failedBoards.length,
        postings_seen: postingsSeen,
        postings_new: inserted,
        postings_us: postingsUs,
        postings_fresh: postingsFresh,
        postings_undated: postingsUndated,
        total_rows: totals.totalRows,
        distinct_job_ids: totals.distinctJobIds,
        error_message: errors.length > 0 ? errors.join(' | ') : null,
      });
    } catch (err) {
      // A tick that scanned and wrote but could not record itself is still worth
      // more than one that throws away its work, so this is logged, not fatal.
      console.error(`✖ could not record scan_runs row: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }

    await lock.release();
  }

  const durationMs = Date.now() - startedAt.getTime();
  const summary = {
    run_id: runId,
    dry_run: dryRun,
    duration_ms: durationMs,
    boards_attempted: boards.length,
    boards_ok: okBoards.length,
    boards_failed: failedBoards.length,
    postings_seen: postingsSeen,
    postings_unique: rows.length,
    postings_unkeyed: unkeyed,
    postings_already_stored: alreadyStored,
    postings_new: inserted,
    postings_us: postingsUs,
    postings_fresh: postingsFresh,
    postings_undated: postingsUndated,
    total_rows: totals.totalRows,
    distinct_job_ids: totals.distinctJobIds,
    uniqueness_ok: dryRun ? null : totals.totalRows === totals.distinctJobIds,
    failures: failedBoards,
    per_board: perBoard,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('');
    console.log(`tick ${runId}${dryRun ? ' (DRY RUN — nothing written)' : ''}`);
    console.log(`  boards       ${boards.length} attempted / ${okBoards.length} ok / ${failedBoards.length} failed`);
    console.log(`  postings     ${postingsSeen} seen → ${rows.length} unique job_ids → ${inserted} newly stored`);
    if (!dryRun) console.log(`  idempotency  ${alreadyStored} already held (skipped before the MERGE)`);
    console.log(`  of those     ${postingsUs} US · ${postingsFresh} fresh (≤${FRESHNESS_DAYS}d) · ${postingsUndated} undated`);
    if (unkeyed > 0) console.log(`  unkeyed      ${unkeyed} posting(s) had no usable URL and were skipped`);
    if (!dryRun) {
      console.log(`  uniqueness   ${totals.totalRows} rows / ${totals.distinctJobIds} distinct job_id → `
        + `${totals.totalRows === totals.distinctJobIds ? 'OK' : 'FAILED'}`);
    }
    console.log(`  wall clock   ${(durationMs / 1000).toFixed(1)}s`);
    for (const f of failedBoards) console.log(`  ✖ ${f.board_id}: ${f.error}`);
  }
}

// Only tick when run as a program. test/pipeline.test.mjs imports jobIdFor from
// here, and importing this file must not fire a scan.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

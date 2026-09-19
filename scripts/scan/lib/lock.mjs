// ---------------------------------------------------------------------------
// lock.mjs — single-writer tick lock.
//
// WHY THIS EXISTS, in one paragraph, because it is the least obvious part of the
// whole pipeline: Delta's optimistic concurrency does NOT serialise two MERGEs.
// Two ticks running at once can each evaluate "job_id not matched" against their
// own snapshot and each insert the same posting, and nothing in Unity Catalog
// will stop them — PRIMARY KEY there is informational. A 5-minute cron with
// ~90s ticks overlaps the moment one tick runs long. So there is exactly one
// writer, enforced here.
//
// A tick that cannot take the lock EXITS. It does not wait, and it does not run
// anyway: waiting just moves the overlap later, and the next cron tick is 5
// minutes away, which is cheaper than a duplicated job list.
//
// Locks EXPIRE. A tick killed mid-run (VM reboot, Ctrl-C, OOM) must not wedge
// the pipeline until a human notices, so every lock carries expires_at and a
// later tick may steal an expired one.
//
// TWO LAYERS, cheapest first:
//   1. A local file lock. Catches the common case — two cron ticks on the same
//      box — for free, with no warehouse round trip.
//   2. A row in workspace.vthacks_2026.scan_locks. This is the one that matters:
//      it also covers "the Vultr cron is running while Tarang runs npm run
//      scan:us on his laptop", which no file on either machine can see.
//
// Prior art: career-ops/pipeline-lock.mjs (MIT, (c) 2026 Santiago Fernandez de
// Valderrama) does the file-lock half for its tracker writes. This is not a copy
// of it — that module locks a markdown file on one machine, and the hard part
// here is the cross-machine half — but the stale-lock-must-expire rule and the
// "refuse rather than queue" posture are taken from it.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql, sqlObjects, CATALOG_SCHEMA } from './sink-databricks.mjs';

/** Long enough for a slow tick against a cold warehouse, short enough that a
 *  crashed tick costs at most this much pipeline downtime. */
export const LOCK_TTL_MS = 10 * 60_000;

const LOCK_NAME = 'us-scan';

function filelockPath(lockName) {
  return path.join(os.tmpdir(), `hirewire-scan-${lockName}.lock`);
}

/**
 * @returns {{ok: true, release: () => void} | {ok: false, heldBy: string}}
 */
function acquireFileLock(lockName, holder, ttlMs) {
  const file = filelockPath(lockName);
  const payload = JSON.stringify({ holder, pid: process.pid, expiresAt: Date.now() + ttlMs });
  const release = () => {
    // Only ever delete OUR lock: a lock we stole-then-lost must not be removed
    // from under its new owner.
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.holder === holder) fs.unlinkSync(file);
    } catch {
      /* already gone, or unreadable — nothing to release */
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, payload, { flag: 'wx' });
      return { ok: true, release };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        existing = null; // unparseable → treat as stale
      }
      const expired = !existing || !Number.isFinite(existing.expiresAt)
        || existing.expiresAt <= Date.now();
      if (!expired) return { ok: false, heldBy: `${existing.holder} (pid ${existing.pid})` };
      try {
        fs.unlinkSync(file);
      } catch {
        /* someone else stole it first; the next attempt will find out */
      }
    }
  }
  return { ok: false, heldBy: 'unknown (lost the steal race)' };
}

/**
 * Take the cross-machine lock.
 *
 * The MERGE is the acquire attempt; the SELECT that follows is the part that
 * makes it trustworthy. Two concurrent MERGEs on one Delta row normally end with
 * one of them failing to commit, but "normally" is not a guarantee we are
 * willing to write a pipeline on, so ownership is CONFIRMED by reading the row
 * back. If both inserts somehow landed, the lock_name has two rows and the
 * tie-break is deterministic — lowest holder UUID wins, everyone else deletes
 * their own row and exits — so the outcome is still exactly one writer.
 */
async function acquireDeltaLock(lockName, holder, ttlMs) {
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + ttlMs).toISOString();
  await sql(`
MERGE INTO ${CATALOG_SCHEMA}.scan_locks AS t
USING (
  SELECT :lock_name AS lock_name, :holder AS holder,
         CAST(:acquired_at AS TIMESTAMP) AS acquired_at,
         CAST(:expires_at AS TIMESTAMP) AS expires_at
) AS s
ON t.lock_name = s.lock_name
WHEN MATCHED AND t.expires_at <= current_timestamp() THEN UPDATE SET
  t.holder = s.holder, t.acquired_at = s.acquired_at, t.expires_at = s.expires_at
WHEN NOT MATCHED THEN INSERT (lock_name, holder, acquired_at, expires_at)
VALUES (s.lock_name, s.holder, s.acquired_at, s.expires_at)`, [
    { name: 'lock_name', value: lockName },
    { name: 'holder', value: holder },
    { name: 'acquired_at', value: nowIso },
    { name: 'expires_at', value: expiresIso },
  ]);

  const rows = await sqlObjects(
    `SELECT holder, acquired_at, expires_at FROM ${CATALOG_SCHEMA}.scan_locks
      WHERE lock_name = :lock_name ORDER BY holder ASC`,
    [{ name: 'lock_name', value: lockName }],
  );

  const release = async () => {
    await sql(
      `DELETE FROM ${CATALOG_SCHEMA}.scan_locks
        WHERE lock_name = :lock_name AND holder = :holder`,
      [{ name: 'lock_name', value: lockName }, { name: 'holder', value: holder }],
    );
  };

  if (rows.length === 0) return { ok: false, heldBy: 'nobody (lock row vanished mid-acquire)' };
  const winner = rows[0].holder;
  if (winner !== holder) {
    // Either someone else holds an unexpired lock (the normal refusal), or we
    // tied and lost. Both mean: clean up anything of ours and get out.
    if (rows.some(r => r.holder === holder)) await release();
    return { ok: false, heldBy: `${winner} (until ${rows[0].expires_at})` };
  }
  if (rows.length > 1) {
    // We won the tie-break, but the losers' rows are still there. They delete
    // their own on their way out; nothing else to do.
    console.warn(`⚠️  scan_locks has ${rows.length} rows for "${lockName}" — won tie-break as ${holder}`);
  }
  return { ok: true, release };
}

/**
 * @typedef {object} TickLock
 * @property {boolean} acquired
 * @property {string}  holder     This tick's id, also written into scan_locks.
 * @property {string}  [reason]   Why the lock was refused, ready to log.
 * @property {() => Promise<void>} release
 */

/**
 * @param {{lockName?: string, ttlMs?: number}} [options]
 * @returns {Promise<TickLock>}
 */
export async function acquireTickLock(options = {}) {
  const lockName = options.lockName ?? LOCK_NAME;
  const ttlMs = options.ttlMs ?? LOCK_TTL_MS;
  const holder = randomUUID();

  // Escape hatch so the Databricks lock can be exercised on its own — without
  // it, two ticks on one laptop never get past layer 1 and layer 2 is untested.
  const skipFileLock = process.env.HIREWIRE_SCAN_SKIP_FILE_LOCK === '1';

  let releaseFile = () => {};
  if (!skipFileLock) {
    const local = acquireFileLock(lockName, holder, ttlMs);
    if (!local.ok) {
      return {
        acquired: false,
        holder,
        reason: `local file lock held by ${local.heldBy} — another tick is running on this machine`,
        release: async () => {},
      };
    }
    releaseFile = local.release;
  }

  let delta;
  try {
    delta = await acquireDeltaLock(lockName, holder, ttlMs);
  } catch (err) {
    releaseFile();
    throw err;
  }
  if (!delta.ok) {
    releaseFile();
    return {
      acquired: false,
      holder,
      reason: `scan_locks row held by ${delta.heldBy} — another tick is running somewhere`,
      release: async () => {},
    };
  }

  let released = false;
  return {
    acquired: true,
    holder,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await delta.release();
      } finally {
        releaseFile();
      }
    },
  };
}

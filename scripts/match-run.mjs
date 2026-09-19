#!/usr/bin/env node
/**
 * match-run.mjs — run the match agent from the command line, against the live
 * workspace.
 *
 * It imports the SAME `runMatch()` the `/api/match` route calls and injects the
 * scripts' longer-polling SQL client. There is no second implementation of the
 * pipeline here: this file is argument parsing and printing.
 *
 * Usage:
 *   node scripts/match-run.mjs --email tarangnair98@gmail.com
 *   node scripts/match-run.mjs --user-id <uuid> --refresh
 *   node scripts/match-run.mjs --email x@y.z --freshness 7 --limit 10
 *   node scripts/match-run.mjs --email x@y.z --refresh --no-persist
 *   node scripts/match-run.mjs --email x@y.z --refresh --goals '{"clearance":"none"}'
 *
 * --goals exists because `workspace.vthacks_2026.goals` is EMPTY: it is owned by
 * the voice lane and no account has a row yet. Without an override there is no way
 * to exercise the eligibility gate against real postings other than writing a
 * teammate's preferences row, which is not mine to write. The override is merged
 * in memory and never persisted.
 */
import { sql } from './lib/dbsql.mjs';
import { runMatch } from '../app/vthacks-career-app/src/lib/match/run.mjs';

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function resolveUserId(email) {
  const r = await sql(
    `SELECT user_id FROM workspace.vthacks_2026.users WHERE LOWER(email) = :email LIMIT 1`,
    [{ name: 'email', value: email.trim().toLowerCase() }],
  );
  const id = r.rows[0]?.[0];
  if (!id) throw new Error(`no users row for email ${email}`);
  return id;
}

function bar(label, value) {
  return `  ${label.padEnd(26, '.')} ${value}`;
}

async function main(args) {
  const email = flag(args, 'email');
  let userId = flag(args, 'user-id');
  if (!userId && !email) {
    console.error('need --email or --user-id');
    return 1;
  }
  if (!userId) userId = await resolveUserId(email);

  const goalsRaw = flag(args, 'goals');
  const goalsOverride = goalsRaw ? JSON.parse(goalsRaw) : null;

  const t0 = Date.now();
  const out = await runMatch({
    sql,
    userId,
    refresh: args.includes('--refresh'),
    persist: !args.includes('--no-persist'),
    freshnessDays: flag(args, 'freshness') ? Number(flag(args, 'freshness')) : undefined,
    pool: flag(args, 'pool') ? Number(flag(args, 'pool')) : undefined,
    limit: flag(args, 'limit') ? Number(flag(args, 'limit')) : undefined,
    goalsOverride,
    onProgress: (m) => console.log(`  · ${m}`),
  });

  const s = out.stats;
  console.log(`\n=== MATCH RUN ${out.run_id}${out.cached ? ' (CACHED — no model calls)' : ''} ===`);
  console.log(bar('user_id', userId));
  console.log(bar('candidates considered', s.candidates_total));
  if (!out.cached) console.log(bar('after hard SQL filters', s.after_sql_filters));
  if (!out.cached) console.log(bar('cosine pool', s.cosine_pool));
  console.log(bar('eligible after the gate', s.after_filters));
  console.log(bar('dropped INELIGIBLE', s.dropped_ineligible));
  if (!out.cached) console.log(bar('eligibility unknown (kept)', s.unknown_eligibility));
  console.log(bar('reranked (model calls)', s.reranked));
  if (!out.cached) console.log(bar('dropped: score, no reason', s.dropped_no_reason));
  console.log(bar('written to match_evaluations', s.written));
  console.log(bar('model calls this request', s.model_calls_this_request));
  console.log(bar('wall clock (s)', s.wall_clock_seconds ?? ((Date.now() - t0) / 1000).toFixed(1)));

  if (out.filtered_ineligible?.length) {
    console.log(`\n--- DROPPED INELIGIBLE (${out.filtered_ineligible.length}), with reasons ---`);
    for (const r of out.filtered_ineligible.slice(0, 10)) {
      console.log(`  ${r.company} — ${r.title}\n     ${r.reason}`);
    }
    if (out.filtered_ineligible.length > 10) {
      console.log(`  ... ${out.filtered_ineligible.length - 10} more`);
    }
  }
  if (out.dropped_no_reason?.length) {
    console.log(`\n--- DROPPED, SCORE WITH NO USABLE REASON ---`);
    for (const r of out.dropped_no_reason) console.log(`  ${r.job_id}: ${r.why}`);
  }

  const showTop = Number(flag(args, 'show') ?? 3);
  console.log(`\n--- TOP ${Math.min(showTop, out.matches.length)} OF ${out.matches.length} ---`);
  for (const m of out.matches.slice(0, showTop)) {
    console.log(`\n#${m.retrieval_rank}  ${m.company} — ${m.title}`);
    console.log(`  score ${m.score} (${m.recommendation})   similarity ${m.similarity.toFixed(4)}   ${m.location ?? ''}`);
    console.log(`  eligibility: ${m.eligibility} — ${m.eligibility_reason}`);
    console.log(`  matched:  ${m.matched_skills.join(', ') || '(none)'}`);
    console.log(`  missing:  ${m.missing_skills.join(', ') || '(none)'}`);
    console.log(`  courses:  ${m.courses_matched.join('; ') || '(none)'}`);
    console.log(`  reason:   ${m.reason}`);
    console.log(`  url:      ${m.source_url ?? ''}`);
  }
  console.log('');
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err?.stack ?? err?.message ?? err);
    process.exit(1);
  });

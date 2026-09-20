/**
 * MatchList — the ranked matches, with the percentage.
 *
 * A SERVER COMPONENT ON PURPOSE. Everything it renders comes from
 * `readMatches()`, which reads the cached run for zero model calls, so there is
 * nothing here for a client bundle to do. No 'use client', no hooks, no fetch.
 *
 * THE NUMBER NEVER APPEARS WITHOUT THE SENTENCE. `reason` is rendered on every
 * single row, unconditionally, directly under the score. That is CLAUDE.md hard
 * rule 4 — a score without a reason is a bug — and `match-read.ts` withholds any
 * row that somehow has no reason rather than letting this component print a bare
 * number.
 *
 * `score` IS THE PERCENTAGE. `rerank.mjs` clamps it to 0-100 before storing, so
 * it is rendered as `{score}%` with no arithmetic. `similarity` is a different
 * number — a 0-1 cosine from stage 1 — and appears only in the per-row small
 * print, labelled as retrieval similarity, never as the match percentage.
 *
 * ACCESSIBILITY, as typed rather than as a later pass (hard rule 6):
 *   * The percentage is NEVER carried by colour. It is digits in text, plus the
 *     model's own word for it ("strong" / "possible" / "weak"), plus a
 *     role="meter" with aria-valuenow/valuemin/valuemax. Remove every colour from
 *     the page and the number is still there three times.
 *   * The filled part of the bar carries no role and no label: the meter element
 *     around it already announces the value, and announcing the same number twice
 *     is noise rather than access.
 *   * Skill chips live in real lists under visible text labels, so "matches" and
 *     "gaps" are not conveyed by chip colour either. The labels are paragraphs and
 *     not headings on purpose — three headings per row would bury the page's real
 *     heading outline under forty entries.
 *   * Every colour pair used here is ink or a signal colour on paper, which is
 *     the palette's 4.5:1 body-contrast pair.
 *
 * DENOMINATOR HONESTY (hard rule 8). The footer says how many EMBEDDED postings
 * the run actually scanned and where they came from. It does not say "all US
 * jobs", because they are fresh US roles from the boards the scanner reads.
 */
import { ExternalLink } from 'lucide-react';

import type { CachedMatches, MatchRow, MatchRunFacts, RemovedRole } from '@/lib/match-read';

import './match.css';

/**
 * The model's own word for the score, as text.
 *
 * Falls back to a band derived from the number when `recommendation` is missing,
 * because the WORD is what makes the percentage readable without colour and it
 * cannot be allowed to simply vanish.
 */
function band(row: MatchRow): string {
  const recommendation = row.recommendation?.trim().toLowerCase();
  if (recommendation === 'strong' || recommendation === 'possible' || recommendation === 'weak') {
    return recommendation;
  }
  if (row.score >= 75) return 'strong';
  if (row.score >= 50) return 'possible';
  return 'weak';
}

/** `2026-09-18T14:02:11.000` -> `2026-09-18`. Left alone if it is not a timestamp. */
function dateOnly(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : value;
}

function MatchRowView({ row, rank }: { row: MatchRow; rank: number }) {
  const score = Math.round(row.score);
  const word = band(row);
  const posted = dateOnly(row.posted_at);

  return (
    <li className="match-row">
      <div className="match-head">
        <span className="match-rank" aria-hidden="true">
          {rank}
        </span>
        <span className="match-who">
          <strong>{row.title ?? 'Untitled role'}</strong>
          <small>{row.company ?? 'Unnamed employer'}</small>
        </span>

        {/* The percentage, three ways: digits, word, meter. None of them is a colour. */}
        <span className="match-score">
          <span className="match-score-digits">
            {score}%<span className="sr-only"> match</span>
          </span>
          <span className={`match-score-word is-${word}`}>{word} match</span>
          <span
            role="meter"
            aria-valuenow={score}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${score} percent — ${word} match`}
            aria-label={`Match score for ${row.title ?? 'this role'} at ${row.company ?? 'this employer'}`}
            className="match-meter"
          >
            <span className={`match-meter-fill is-${word}`} style={{ width: `${score}%` }} />
          </span>
        </span>
      </div>

      {/* Hard rule 4. Unconditional, and directly under the number it explains. */}
      <p className="match-reason">{row.reason}</p>

      {row.eligibility === 'unknown' && row.eligibility_reason ? (
        <p className="match-caution">
          <strong>Worth checking:</strong> {row.eligibility_reason}
        </p>
      ) : null}

      <div className="match-skills">
        {row.matched_skills.length ? (
          <div className="match-skillset">
            <p className="match-skillset-label">Matches your profile</p>
            <ul>
              {row.matched_skills.map((skill) => (
                <li key={skill} className="match-chip is-have">
                  {skill}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {row.missing_skills.length ? (
          <div className="match-skillset">
            <p className="match-skillset-label">Not on your profile yet</p>
            <ul>
              {row.missing_skills.map((skill) => (
                <li key={skill} className="match-chip is-gap">
                  {skill}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {row.courses_matched.length ? (
          <div className="match-skillset">
            <p className="match-skillset-label">Covered by your coursework</p>
            <ul>
              {row.courses_matched.map((course) => (
                <li key={course} className="match-chip is-course">
                  {course}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <p className="match-meta">
        {row.location ? <span>{row.location}</span> : null}
        {posted ? <span>Posted {posted}</span> : null}
        {row.source ? <span>via {row.source}</span> : null}
        <span>retrieval similarity {row.similarity.toFixed(3)}</span>
        {row.source_url ? (
          <a href={row.source_url} target="_blank" rel="noopener noreferrer">
            Original posting
            <span className="sr-only"> for {row.title ?? 'this role'} at {row.company ?? 'this employer'}</span>
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        ) : null}
      </p>
    </li>
  );
}

function RunFooter({ run, removed }: { run: MatchRunFacts; removed?: RemovedRole[] }) {
  return (
    <div className="match-footer">
      {/* HARD RULE 8, and the numbers are the ones match_runs actually stores.
          `candidates_total` is every embedded posting the scanner has captured — it
          is NOT a count of fresh roles, and it is certainly not "all US jobs". The
          freshness window and the cosine cut happen between it and
          `after_filters`, which is how many of the shortlist cleared the
          eligibility gate. Saying "scored against 16,206 fresh roles" would be an
          overclaim by a factor of about fifty. */}
      <p className="match-provenance">
        Ranked out of <strong>{run.candidates_total}</strong> embedded US postings — everything the
        discovery pipeline has scraped and embedded, which is not every job in the country. A
        freshness window and your stated preferences narrow that down, then a cosine cut takes a
        shortlist, of which <strong>{run.after_filters}</strong> cleared the eligibility gate. The
        model read the top <strong>{run.reranked}</strong> of those and{' '}
        <strong>{run.written}</strong> were stored.
        {run.started_at ? ` Run at ${run.started_at.replace('T', ' ').slice(0, 19)}.` : ''}
      </p>

      {run.dropped_ineligible > 0 ? (
        <details className="match-removed">
          <summary>
            {run.dropped_ineligible} role{run.dropped_ineligible === 1 ? '' : 's'} removed — why
          </summary>
          {removed && removed.length ? (
            <ul>
              {removed.map((role) => (
                <li key={role.job_id}>
                  <strong>
                    {role.title ?? 'Untitled role'} · {role.company ?? 'Unnamed employer'}
                  </strong>
                  <span>{role.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              The eligibility gate removed {run.dropped_ineligible} of these postings because the
              posting itself states a requirement this profile cannot meet — a clearance, US
              citizenship, or a refusal to sponsor a visa. It is a gate, not a score penalty: a role
              that will not sponsor you is not a weak match, it is not a match.
              {' '}
              The per-role sentences are produced by the run and are not stored, so they are shown at
              the moment a run happens rather than read back here.
            </p>
          )}
        </details>
      ) : null}
    </div>
  );
}

/**
 * Render the ranked matches for one user.
 *
 * `result` is whatever `readMatches()` returned, passed through undigested, so
 * this component is the single place that decides how each of the three outcomes
 * looks. `emptyNote` is the caller's sentence for "a run happened and found
 * nothing", because the dashboard and the jobs page want to say different things
 * about what to do next.
 */
export function MatchList({
  result,
  removed,
  emptyNote,
  limit,
}: {
  result: CachedMatches;
  removed?: RemovedRole[];
  emptyNote?: string;
  /** Show only the first N rows. The count of the rest is stated, never hidden. */
  limit?: number;
}) {
  if (result.state === 'error') {
    // NEVER "no matches". The truth is that the read failed, and saying anything
    // else invents an answer on the user's behalf.
    return (
      <p className="match-problem" role="alert">
        <strong>I could not load your matches just now.</strong> That is the warehouse refusing or
        timing out, not an empty result — your previous run is still stored. {result.message}
      </p>
    );
  }

  if (result.state === 'none') {
    return null;
  }

  if (result.matches.length === 0) {
    return (
      <div className="match-empty">
        <p>
          {emptyNote ??
            'The last run finished and nothing cleared the bar. That is a real answer, not a failure.'}
        </p>
        <RunFooter run={result.run} removed={removed} />
      </div>
    );
  }

  const shown =
    limit && limit > 0 && result.matches.length > limit ? result.matches.slice(0, limit) : result.matches;
  const hidden = result.matches.length - shown.length;

  return (
    <div className="match-wrap">
      <ol className="match-list">
        {shown.map((row, index) => (
          <MatchRowView key={row.job_id} row={row} rank={index + 1} />
        ))}
      </ol>

      {hidden > 0 ? (
        <p className="match-provenance match-more">
          Showing the top {shown.length} of {result.matches.length} scored roles. The other {hidden}{' '}
          are on the jobs page, ranked the same way.
        </p>
      ) : null}

      {result.withheldNoReason > 0 ? (
        <p className="match-problem" role="status">
          {result.withheldNoReason} scored role{result.withheldNoReason === 1 ? ' was' : 's were'}{' '}
          held back for arriving without an explanation. A score with no reason is a bug, so it is
          not shown rather than shown bare.
        </p>
      ) : null}

      <RunFooter run={result.run} removed={removed} />
    </div>
  );
}

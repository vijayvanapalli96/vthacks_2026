/**
 * A2ATranscript — the chain of messages between the two agents, as it happens.
 *
 * The apply screen used to show a start state and an end state: "checking the
 * employer", then "application sent". Everything that makes the handshake worth
 * anything happened in between and was invisible — the registry lookup, the
 * published card, the trust gate, the signed envelope, the employer's own check
 * on us coming back. This renders those, one row per message, in order.
 *
 * Each row carries the deterministic facts written by the code that performed
 * the turn. Where a line from Gemini exists it is shown as the applicant agent
 * SPEAKING, attributed and visibly distinct, never as the record itself: it is
 * written after the fact from these same facts and is marked as such on screen,
 * because a narrated line sitting unlabelled next to a signature claim would be
 * the overclaim the rest of this product exists to avoid.
 *
 * Used live (streaming, `live` true) and for a saved transcript, which is the
 * same list with the timing removed.
 */
import { BadgeCheck, Building2, Cpu, Radio, ShieldAlert, Sparkles } from 'lucide-react';

import type { Turn, TurnParty } from '@/lib/a2a/transcript';

const partyLabel: Record<TurnParty, string> = {
  applicant_agent: 'Your agent',
  employer_agent: 'Employer agent',
  ans_registry: 'ANS registry',
};

function PartyIcon({ party }: { party: TurnParty }) {
  if (party === 'applicant_agent') return <Cpu size={14} aria-hidden="true" />;
  if (party === 'employer_agent') return <Building2 size={14} aria-hidden="true" />;
  return <Radio size={14} aria-hidden="true" />;
}

function time(at: string): string {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : '';
}

export function A2ATranscript({
  turns,
  live = false,
  narrator = 'none',
  transcriptId = null,
}: {
  turns: Turn[];
  /** True while the exchange is still running, so the list can say so. */
  live?: boolean;
  narrator?: 'gemini' | 'none';
  /** Set once the transcript is saved, which is what makes it linkable. */
  transcriptId?: string | null;
}) {
  if (turns.length === 0 && !live) return null;

  return (
    <section className="panel a2a-panel" aria-labelledby="a2a-chain-h">
      <header>
        <div>
          <small>THE EXCHANGE</small>
          <h2 id="a2a-chain-h">What the two agents said to each other</h2>
        </div>
        {live ? <span className="job-tag checking-tag">Live</span> : null}
      </header>
      <div className="trust-body">
        <p className="muted">
          Every message in order: the registry lookup, the published card, the trust gate, the signed envelope,
          and the employer&rsquo;s own verdict on your agent coming back. Field names are recorded, never their
          values.
        </p>

        {/* aria-live so a screen reader hears each message as it lands rather
            than only the final verdict. */}
        <ol className="a2a-chain" aria-live="polite" aria-busy={live}>
          {turns.map((turn) => (
            <li
              key={turn.seq}
              className={`a2a-turn a2a-from-${turn.from} ${
                turn.outcome === 'ok' ? 'is-ok' : turn.outcome === 'refused' ? 'is-refusing' : 'is-failed'
              }`}
            >
              <div className="a2a-turn-head">
                <span className="a2a-party">
                  <PartyIcon party={turn.from} />
                  {partyLabel[turn.from]}
                  <span aria-hidden="true"> → </span>
                  <span className="sr-only">to</span>
                  {partyLabel[turn.to]}
                </span>
                <span className="a2a-time">{time(turn.at)}</span>
              </div>
              <p className="a2a-label">
                {turn.outcome === 'ok' ? (
                  <BadgeCheck size={14} aria-hidden="true" />
                ) : (
                  <ShieldAlert size={14} aria-hidden="true" />
                )}
                {turn.label}
              </p>
              <p className="a2a-detail">{turn.detail}</p>
              {turn.said ? (
                <p className="a2a-said">
                  <Sparkles size={13} aria-hidden="true" />
                  <span>
                    <q>{turn.said}</q>
                    <small> — your agent, narrated by Gemini after the fact</small>
                  </span>
                </p>
              ) : null}
              {turn.data ? (
                <details className="a2a-data">
                  <summary>What was on the wire</summary>
                  <pre>{JSON.stringify(turn.data, null, 2)}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>

        {live && turns.length === 0 ? <p className="muted">Opening the exchange…</p> : null}

        {transcriptId ? (
          <p className="job-source-link">
            <a href={`/applicant/transcript/${encodeURIComponent(transcriptId)}`}>
              Saved transcript · {transcriptId.slice(0, 8)}
            </a>
            {narrator === 'none' ? (
              <span className="muted"> · saved without narration; the record is complete either way</span>
            ) : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}

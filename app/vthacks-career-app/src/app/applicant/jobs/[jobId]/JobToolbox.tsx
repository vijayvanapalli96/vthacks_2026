'use client';

/**
 * JobToolbox — every option career-ops offers for one job, in one panel.
 *
 * TWO GROUPS, LABELLED BY WHAT THEY COST. The user asked for all the options to
 * be present. They are. But a grid of eight identical buttons where four are
 * instant and free and three take twenty seconds and spend money is a bad
 * control panel, so the cost is part of each button's accessible name — not a
 * tooltip, not an icon. A screen-reader user hears "Cover letter, one model
 * call, about twenty to forty seconds" before they activate it.
 *
 * NO CLIENT-SIDE LOGIC. Every option is an HTTP call to a real endpoint
 * (`/api/jobs/[jobId]/analyze`, `/generate`, `/artifacts`). Hard rule 5: voice
 * and UI call the same endpoints, and that can only be true if the UI has no
 * private path. This component fetches and renders; it computes nothing.
 *
 * ACCESSIBILITY, as typed and not as a later pass:
 *   * Real `<button>`s with real text labels. No div-with-onClick anywhere.
 *   * Tab order is DOM order, which is reading order: context, free tools, paid
 *     tools, results, history.
 *   * `aria-live="polite"` status line that is ALWAYS in the DOM (a live region
 *     inserted at the moment it gets content is often never announced).
 *   * A long action announces that it STARTED, with its cost, before it
 *     finishes — "Generating a cover letter. One model call, usually twenty to
 *     forty seconds." Silence for thirty seconds reads as a broken button.
 *   * `aria-busy` and `aria-expanded` on the controls, so state is not conveyed
 *     by the trailing ellipsis alone.
 *   * A disabled option carries a VISIBLE sentence saying why. An option that
 *     renders and does nothing is worse than an absent option.
 */

import { useCallback, useId, useState } from 'react';

type Finding = {
  claim: string;
  kind: string;
  severity: 'block' | 'warn';
  reason: string;
};

type Verification = {
  verdict: 'pass' | 'warn' | 'block' | 'unreadable';
  invented: string[];
  unsupportedFacts: { kind: string; value: string }[];
  forbidden: string[];
  warnings: string[];
  coverage: { reason: string; message: string; spans: string[] } | null;
  findings: Finding[];
  claims_checked: number;
  facts_available: number;
  sentence: string;
};

type Tool = {
  id: string;
  label: string;
  reason: string;
  [key: string]: unknown;
};

type Analysis = {
  tools: Tool[];
  model_calls: number;
  description_available: boolean;
  description_chars: number;
};

type GeneratedDoc = {
  artifact_id: string | null;
  persist_error: string | null;
  kind: string;
  text: string;
  approach_reason: string;
  posting_anomaly: string | null;
  verification: Verification;
  downloadable: boolean;
  cost: { model_calls: number; model_name: string; ms: number };
};

export type Artifact = {
  artifact_id: string;
  kind: string;
  model_name: string | null;
  content_text: string | null;
  created_at: string;
  verdict: string | null;
  downloadable: boolean;
};

type Props = {
  jobId: string;
  jobTitle: string | null;
  companyName: string | null;
  hasDescription: boolean;
  descriptionChars: number;
  factCount: number;
  initialArtifacts: Artifact[];
};

/** Tier 1. Every one of these is free, instant, and deterministic. */
const FREE_TOOLS: { id: string; label: string; what: string }[] = [
  {
    id: 'skill_gap',
    label: 'Skill gap for this job',
    what: 'Which requirements you cover, which you do not, and which of your courses covers a gap.',
  },
  {
    id: 'resume_optimizer',
    label: 'Resume optimizer',
    what: 'Ranks your own bullets for this posting and names the keywords none of them mention. It never writes a bullet for you.',
  },
  {
    id: 'role_tier',
    label: 'Role tier / seniority read',
    what: 'Is this actually entry level, or does the body ask for five years?',
  },
  {
    id: 'text_similarity',
    label: 'Fit similarity (text overlap)',
    what: 'Word overlap between this posting and your profile. Not the match score — a different number.',
  },
  {
    id: 'eligibility',
    label: 'Eligibility read',
    what: 'Sponsorship, clearance and graduation-date signals in the posting text, with the reason.',
  },
];

/** Tier 2. One `ai_query` model call each, and each one goes through the fact gate. */
const PAID_TOOLS: { id: 'cover_letter' | 'answers' | 'resume'; label: string; what: string }[] = [
  {
    id: 'cover_letter',
    label: 'Cover letter',
    what: '350 to 420 words, built only from facts in your profile, then checked claim by claim before you see it.',
  },
  {
    id: 'answers',
    label: 'Application answers',
    what: '"Why this company", "why you", and one question you type. Refuses to guess at sponsorship or salary.',
  },
  {
    id: 'resume',
    label: 'Tailored resume bullets',
    what: 'Rewrites your top bullets in this posting\'s vocabulary. Numbers are never changed.',
  },
];

const PAID_COST = '1 model call · usually 20–40s';
const FREE_COST = 'Free · instant · no model call';

/**
 * When a document was generated, as an ABSOLUTE time in UTC.
 *
 * Deliberately not "5 min ago". A relative time needs `Date.now()` during
 * render, and `Date.now()` on the server and `Date.now()` in the browser are
 * different numbers by construction — so the server sends "just now", the client
 * hydrates "1 min ago", and React reports a hydration mismatch. The honest
 * options are a client-only effect or an absolute timestamp, and for a list of
 * documents you might print, the absolute timestamp is the more useful one
 * anyway.
 *
 * Formatted from the ISO string by slicing, not by `toLocaleString`: the
 * server's ICU locale and the browser's are not guaranteed to agree either, and
 * that is the same bug wearing a different hat.
 */
function generatedAt(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, year, month, day, hour, minute] = match;
  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}

/**
 * A digit-grouped integer, computed rather than localised — see `generatedAt`
 * above for why `toLocaleString()` is not used in a component that renders on
 * both sides.
 */
function grouped(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** A labelled chip list, or an honest "none" rather than an empty gap. */
function Chips({ title, items, variant }: { title: string; items: string[]; variant?: 'have' | 'gap' }) {
  return (
    <div>
      <small>{title}</small>
      {items.length ? (
        <ul className={`jd-chips${variant ? ` jd-chips--${variant}` : ''}`}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="jd-empty">None.</p>
      )}
    </div>
  );
}

function VerificationPanel({ verification }: { verification: Verification }) {
  const verdict = verification.verdict;
  const blocking = verification.findings.filter((f) => f.severity === 'block');
  const advisory = verification.findings.filter((f) => f.severity === 'warn');

  return (
    <section className={`jd-verdict jd-verdict--${verdict === 'unreadable' ? 'block' : verdict}`}>
      <h4>
        Fact verification against your profile — {verdict.toUpperCase()}
      </h4>
      {/* Hard rule 4: the verdict carries its sentence, always. */}
      <p className="jd-reason">{verification.sentence}</p>
      <p className="jd-reason">
        {verification.claims_checked} checkable claim
        {verification.claims_checked === 1 ? '' : 's'} extracted from the document;{' '}
        {verification.facts_available} facts available in your profile to check them against.
      </p>
      {blocking.length ? (
        <ul className="jd-findings">
          {blocking.map((finding) => (
            <li key={`${finding.kind}:${finding.claim}`} className="is-block">
              <code>{finding.claim}</code> {finding.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {advisory.length ? (
        <ul className="jd-findings">
          {advisory.map((finding) => (
            <li key={`${finding.kind}:${finding.claim}`}>
              <code>{finding.claim}</code> {finding.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function JobToolbox({
  jobId,
  jobTitle,
  companyName,
  hasDescription,
  descriptionChars,
  factCount,
  initialArtifacts,
}: Props) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<GeneratedDoc | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>(initialArtifacts);
  const [angle, setAngle] = useState('');
  const [question, setQuestion] = useState('');

  const angleId = useId();
  const questionId = useId();
  const resultsId = useId();

  const encodedJobId = encodeURIComponent(jobId);

  /**
   * Why every Tier 1 button hits the SAME endpoint: the five reads share the
   * requirement extraction and the profile load, which are the expensive parts.
   * Five endpoints would run them five times on a warehouse that bills by the
   * second. The first click pays for all five; the rest are instant.
   */
  const runAnalyze = useCallback(
    async (toolId: string) => {
      if (openTool === toolId) {
        setOpenTool(null);
        return;
      }
      if (analysis) {
        setOpenTool(toolId);
        setStatus(`Showing ${FREE_TOOLS.find((t) => t.id === toolId)?.label ?? toolId}. No model call.`);
        return;
      }
      setBusy(toolId);
      setError(null);
      setStatus('Running the five zero-cost reads. No model call — this is text analysis against the warehouse.');
      try {
        const response = await fetch(`/api/jobs/${encodedJobId}/analyze`, { method: 'POST' });
        const payload = (await response.json()) as Analysis & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        setAnalysis(payload);
        setOpenTool(toolId);
        setStatus(
          `All five reads are ready, with zero model calls. Showing ${
            FREE_TOOLS.find((t) => t.id === toolId)?.label ?? toolId
          }.`,
        );
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setStatus(`That read failed: ${message}`);
      } finally {
        setBusy(null);
      }
    },
    [analysis, encodedJobId, openTool],
  );

  const runGenerate = useCallback(
    async (kind: 'cover_letter' | 'answers' | 'resume') => {
      const label = PAID_TOOLS.find((t) => t.id === kind)?.label ?? kind;
      setBusy(kind);
      setError(null);
      setDoc(null);
      // Announced BEFORE the await. A 30-second silence reads as a dead button,
      // and the cost is restated here because this is the moment it is spent.
      setStatus(
        `Generating ${label.toLowerCase()}. One model call, usually 20 to 40 seconds. ` +
          `It will be checked claim by claim against your profile before it is shown.`,
      );
      try {
        const response = await fetch(`/api/jobs/${encodedJobId}/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind,
            angle: angle.trim() || undefined,
            question: question.trim() || undefined,
          }),
        });
        const payload = (await response.json()) as GeneratedDoc & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        setDoc(payload);
        setStatus(payload.verification.sentence);
        // Refresh the history so the new row is visible without a reload, and so
        // a persist failure is obvious (the document is on screen but absent
        // from the list).
        try {
          const list = await fetch(`/api/jobs/${encodedJobId}/artifacts`);
          const listed = (await list.json()) as { artifacts?: Artifact[] };
          if (list.ok && Array.isArray(listed.artifacts)) setArtifacts(listed.artifacts);
        } catch {
          // The document is already on screen. A failed history refresh is not
          // worth replacing that with an error.
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setStatus(`${label} failed: ${message}`);
      } finally {
        setBusy(null);
      }
    },
    [angle, encodedJobId, question],
  );

  /** The single visible sentence explaining why a paid option is unavailable. */
  const paidBlockedBecause = !hasDescription
    ? `This posting stored only ${descriptionChars} characters of description text. There is nothing to tailor to, and a generic letter is worse than none.`
    : factCount === 0
      ? 'Your profile has no saved facts yet, so there is nothing to write from and nothing to verify against. Run resume intake first.'
      : null;

  const openToolData = analysis?.tools.find((t) => t.id === openTool) ?? null;

  return (
    <div className="jd-wrap">
      {/* ── Tier 1 ─────────────────────────────────────────────────────── */}
      <section className="jd-group" aria-labelledby="jd-free-h">
        <small>FREE — ZERO MODEL CALLS</small>
        <h2 id="jd-free-h">Read this posting against your profile</h2>
        <p>
          Five deterministic reads, lifted from career-ops. Nothing here calls a model, so it is
          instant, it costs nothing, and it returns the same answer every time. The first one you
          open computes all five.
        </p>
        <ul className="jd-tools">
          {FREE_TOOLS.map((tool) => (
            <li key={tool.id}>
              <button
                type="button"
                className={`jd-tool${busy === tool.id ? ' jd-tool--busy' : ''}`}
                onClick={() => void runAnalyze(tool.id)}
                disabled={busy !== null}
                aria-busy={busy === tool.id}
                aria-expanded={openTool === tool.id}
                aria-controls={resultsId}
              >
                <strong>{tool.label}</strong>
                <span className="jd-cost">{FREE_COST}</span>
                <span className="jd-what">{tool.what}</span>
              </button>
            </li>
          ))}
          <li>
            {/* A real link, not a button: it navigates, and a middle-click or
                Ctrl+click should work the way the user expects. */}
            <a
              className="jd-tool"
              href={`/api/jobs/${encodedJobId}/print/resume`}
              target="_blank"
              rel="noreferrer"
            >
              <strong>Resume print view</strong>
              <span className="jd-cost">{FREE_COST} · opens a new tab</span>
              <span className="jd-what">
                Your profile as a clean, print-styled resume. Opens a print view — use your
                browser&rsquo;s Print to save a PDF. We do not run a headless browser, so we cannot
                hand you a file.
              </span>
            </a>
          </li>
        </ul>
      </section>

      {/* ── Tier 2 ─────────────────────────────────────────────────────── */}
      <section className="jd-group" aria-labelledby="jd-paid-h">
        <small>ONE MODEL CALL EACH — AND A FACT CHECK BEFORE YOU SEE IT</small>
        <h2 id="jd-paid-h">Draft a document for this posting</h2>
        <p>
          Each of these spends one <code>ai_query</code> call on{' '}
          <code>databricks-llama-4-maverick</code> and then runs career-ops&rsquo;{' '}
          <code>verify-cv-facts</code> gate over the result. A claim with no support in your profile
          is shown to you and the document is <strong>not</strong> offered for download. Generating
          is not sending: nothing here submits an application.
        </p>

        <div className="jd-field">
          <label htmlFor={angleId}>
            Your own angle for this company, in your words (optional). Without it the draft builds an
            angle from the posting&rsquo;s stated priorities and says so.
          </label>
          <textarea
            id={angleId}
            value={angle}
            onChange={(event) => setAngle(event.target.value)}
            maxLength={600}
            placeholder="e.g. I want to work on retrieval at their scale — my last two roles were both hybrid search."
          />
        </div>
        <div className="jd-field">
          <label htmlFor={questionId}>
            One extra application question to answer (optional). Used by &ldquo;Application
            answers&rdquo;.
          </label>
          <input
            id={questionId}
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={400}
            placeholder="e.g. Describe a time you shipped something under a hard deadline."
          />
        </div>

        <ul className="jd-tools" style={{ marginTop: 20 }}>
          {PAID_TOOLS.map((tool) => (
            <li key={tool.id}>
              <button
                type="button"
                className={`jd-tool jd-tool--paid${busy === tool.id ? ' jd-tool--busy' : ''}`}
                onClick={() => void runGenerate(tool.id)}
                disabled={busy !== null || paidBlockedBecause !== null}
                aria-busy={busy === tool.id}
                aria-controls={resultsId}
              >
                <strong>{tool.label}</strong>
                <span className="jd-cost">{PAID_COST}</span>
                <span className="jd-what">{paidBlockedBecause ?? tool.what}</span>
              </button>
            </li>
          ))}
        </ul>
        {paidBlockedBecause ? (
          <p className="jd-empty" style={{ marginTop: 14 }}>
            <strong>These three are disabled.</strong> {paidBlockedBecause}
          </p>
        ) : null}
      </section>

      {/* ── Status. Always in the DOM. ─────────────────────────────────── */}
      <p className="jd-status" role="status" aria-live="polite">
        {status}
      </p>

      {/* ── Results ────────────────────────────────────────────────────── */}
      <div id={resultsId} aria-live="polite" aria-atomic="false">
        {error ? (
          <section className="jd-result">
            <h3>That did not work</h3>
            <p className="jd-reason">{error}</p>
            <p className="jd-reason">
              If that mentions a permission or a warehouse, it is the platform and a retry usually
              fixes it. If it mentions <code>ai_query</code>, it is the model endpoint and the
              option genuinely failed.
            </p>
          </section>
        ) : null}

        {openToolData ? (
          <section className="jd-result">
            <h3>{openToolData.label}</h3>
            {/* Hard rule 4: the reason, always, right under the heading. */}
            <p className="jd-reason">{openToolData.reason}</p>

            {openToolData.id === 'skill_gap' ? (
              <div className="jd-lists">
                <Chips
                  title="You list these"
                  items={asStringArray(openToolData.claimed)}
                  variant="have"
                />
                <Chips
                  title="Your own bullets prove these"
                  items={asStringArray(openToolData.proven_by_your_bullets)}
                  variant="have"
                />
                <Chips
                  title="No trace in your profile"
                  items={asStringArray(openToolData.missing)}
                  variant="gap"
                />
                <Chips
                  title="Courses covering a gap"
                  items={asStringArray(openToolData.courses_covering_a_gap)}
                />
              </div>
            ) : null}

            {openToolData.id === 'resume_optimizer' ? (
              <>
                <p className="jd-reason">{String(openToolData.honesty_note ?? '')}</p>
                <Chips
                  title="Requirements none of your bullets mention"
                  items={asStringArray(openToolData.requirements_no_bullet_mentions)}
                  variant="gap"
                />
                <ul className="jd-bullets">
                  {(
                    (openToolData.bullets as
                      | { text: string; role: string; score: number; reason: string }[]
                      | undefined) ?? []
                  ).map((bullet, index) => (
                    <li key={`${bullet.role}-${index}`} className={bullet.score > 0 ? 'is-lead' : undefined}>
                      {bullet.text}
                      <span className="jd-why">
                        {bullet.role} — {bullet.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {openToolData.id === 'role_tier' ? (
              <div className="jd-score">
                <b>{String(openToolData.tier_label ?? '')}</b>
                <span className="muted">
                  {openToolData.years_required
                    ? `posting asks for ${String(openToolData.years_required)}+ years`
                    : 'no explicit years requirement in the text'}
                </span>
              </div>
            ) : null}

            {openToolData.id === 'text_similarity' ? (
              <div className="jd-score">
                <b>{String(openToolData.percent ?? '')}%</b>
                <span className="muted">word overlap ({String(openToolData.decision ?? '')})</span>
              </div>
            ) : null}

            {openToolData.id === 'eligibility' ? (
              <div className="jd-score">
                <b
                  className={
                    openToolData.eligibility === 'pass'
                      ? 'is-success'
                      : openToolData.eligibility === 'fail'
                        ? 'is-failure'
                        : 'is-pending'
                  }
                >
                  {String(openToolData.eligibility ?? '').toUpperCase()}
                </b>
              </div>
            ) : null}
          </section>
        ) : null}

        {doc ? (
          <section className="jd-result">
            <h3>{PAID_TOOLS.find((t) => t.id === doc.kind)?.label ?? doc.kind}</h3>
            <p className="jd-reason">
              <strong>How this was built:</strong> {doc.approach_reason}
            </p>
            <p className="jd-reason">
              {doc.cost.model_calls} model call on <code>{doc.cost.model_name}</code>,{' '}
              {(doc.cost.ms / 1000).toFixed(1)}s wall clock.
              {doc.artifact_id ? ' Saved to your workspace.' : ''}
              {doc.persist_error
                ? ` It was NOT saved — ${doc.persist_error} — so it will be gone when you reload.`
                : ''}
            </p>

            {doc.posting_anomaly ? (
              <section className="jd-verdict jd-verdict--warn">
                <h4>This posting contained text aimed at an AI reader</h4>
                <p className="jd-reason">
                  The model was told to report it rather than obey it, and it did. Quoted exactly:
                </p>
                <p className="jd-doc">{doc.posting_anomaly}</p>
              </section>
            ) : null}

            <VerificationPanel verification={doc.verification} />

            <p className="jd-doc">{doc.text}</p>

            <div className="jd-actions">
              {doc.downloadable && doc.artifact_id ? (
                <a
                  className="primary"
                  href={`/api/jobs/${encodedJobId}/print/${encodeURIComponent(doc.artifact_id)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open print view (new tab — then use your browser&rsquo;s Print)
                </a>
              ) : (
                <p className="jd-empty">
                  <strong>No download.</strong> This document did not pass the fact check, so there
                  is no print view for it. Fix the flagged claims — correct the draft, or add the
                  missing evidence to your profile if it is genuinely yours — and generate again.
                </p>
              )}
            </div>
          </section>
        ) : null}
      </div>

      {/* ── History ────────────────────────────────────────────────────── */}
      <section className="jd-group" aria-labelledby="jd-history-h">
        <small>ALREADY GENERATED FOR THIS JOB — ZERO MODEL CALLS TO READ</small>
        <h2 id="jd-history-h">Your documents for this posting</h2>
        {artifacts.length === 0 ? (
          <p className="jd-empty">
            Nothing generated for this posting yet. Anything you generate is stored with its
            verification verdict, so you can see later what was checked and what was flagged.
          </p>
        ) : (
          <ul className="jd-history">
            {artifacts.map((artifact) => (
              <li key={artifact.artifact_id}>
                <strong>{artifact.kind.replace(/_/g, ' ')}</strong>
                <span className="jd-when">{generatedAt(artifact.created_at)}</span>
                <span
                  className={
                    artifact.verdict === 'pass'
                      ? 'is-success'
                      : artifact.verdict === 'block' || artifact.verdict === 'unreadable'
                        ? 'is-failure'
                        : 'is-pending'
                  }
                >
                  verification: {artifact.verdict ?? 'not recorded'}
                </span>
                {artifact.downloadable ? (
                  <a
                    href={`/api/jobs/${encodedJobId}/print/${encodeURIComponent(artifact.artifact_id)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    print view
                  </a>
                ) : (
                  <span className="jd-when">withheld — failed the fact check</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="jd-empty" style={{ marginTop: 28 }}>
        {jobTitle || companyName ? (
          <>
            Everything above was computed for <strong>{jobTitle ?? 'this role'}</strong>
            {companyName ? <> at <strong>{companyName}</strong></> : null}, from the posting text we
            actually stored ({grouped(descriptionChars)} characters) and the{' '}
            {factCount} facts in your profile.
          </>
        ) : null}
      </p>
    </div>
  );
}

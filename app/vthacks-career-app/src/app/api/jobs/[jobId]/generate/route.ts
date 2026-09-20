/**
 * POST /api/jobs/[jobId]/generate — TIER 2. ONE model call, then the fact gate.
 *
 * Body: { kind: 'cover_letter' | 'answers' | 'resume', angle?: string, question?: string }
 *
 * THE ORDER IS THE POINT: generate -> VERIFY -> persist -> return. A document
 * that fails verification comes back with its failing claims and
 * `downloadable: false`, and the print route refuses it independently rather
 * than trusting this flag to have been honoured by the UI.
 *
 * GENERATING IS NOT SENDING (hard rule 3). This endpoint writes one row to
 * `artifacts` and returns text. It does not submit an application, does not
 * email anyone, and moves no PII outward — the document never leaves the
 * warehouse and the student's own browser.
 *
 * POST only. Unlike `analyze`, this one SPENDS MONEY and writes a row, so it is
 * not safe to hit from an address bar and there is deliberately no GET.
 */
import { generateDocument, KINDS } from '@/lib/artifacts/generate.mjs';
import { loadContext } from '@/lib/artifacts/context.mjs';
import { analyze } from '@/lib/artifacts/analyze.mjs';
import { insertArtifact } from '@/lib/artifacts/store.mjs';
import { sql } from '@/lib/databricks';
import { requireRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * A cover letter is ~450 output tokens through `ai_query` on a warehouse that may
 * be asleep. 20-40s warm, up to ~90s cold. 300 is the same ceiling `/api/match`
 * uses and for the same reason.
 */
export const maxDuration = 300;

type Body = { kind?: unknown; angle?: unknown; question?: unknown };

/** Free text the student typed. Trimmed and capped; it reaches a prompt. */
function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Capped, not trusted. This lands in the instruction half of the prompt, so an
  // unbounded value is both an unbounded bill and a place to hide an injection
  // attempt long enough to push the rules out of the model's attention. The fact
  // gate still runs on whatever comes back either way.
  return trimmed.slice(0, max);
}

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const user = await requireRole('applicant');
  const { jobId } = await params;

  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    // An empty POST is not a usable request here — there is no sensible default
    // document to generate — so it falls through to the kind check below.
  }

  const kind = typeof body.kind === 'string' ? body.kind : '';
  if (!(kind in KINDS)) {
    return Response.json(
      {
        error: `kind must be one of ${Object.keys(KINDS).join(', ')}`,
        // Named explicitly so a caller (including the voice router) can recover
        // rather than guess.
        valid_kinds: Object.keys(KINDS),
      },
      { status: 400 },
    );
  }

  try {
    const context = await loadContext(sql, user.id, decodeURIComponent(jobId));
    if (!context.ok) {
      return Response.json({ error: context.error }, { status: context.status });
    }

    if (!context.job.has_description) {
      // Refuse out loud rather than spending a model call on nothing. A letter
      // written against an empty posting is a generic letter, which is the one
      // thing career-ops' cover mode forbids outright: "Do not generate a
      // generic or placeholder cover letter under any circumstances."
      return Response.json(
        {
          error:
            `This posting has only ${context.job.description_chars} characters of description text, ` +
            `which is not enough to tailor anything to. Generating from it would produce a generic ` +
            `letter, and a generic letter is worse than none.`,
        },
        { status: 422 },
      );
    }

    if (context.facts.factCount === 0) {
      return Response.json(
        {
          error:
            'Your profile has no saved facts yet, so there is nothing to write from and nothing to ' +
            'verify against. Run resume intake first.',
        },
        { status: 422 },
      );
    }

    // Tier 1 runs first and for free, and its output is handed to the model as
    // pre-computed truth — the same "trust these, they were computed with no
    // model" block `rerank.mjs` uses. It is cheaper and more accurate than
    // letting the model re-derive which requirements the student covers.
    const analysis = analyze(context);

    const result = await generateDocument({
      sql,
      kind: kind as 'cover_letter' | 'answers' | 'resume',
      job: context.job,
      facts: context.facts,
      profile: context.profile,
      analysis,
      angle: shortText(body.angle, 600),
      question: shortText(body.question, 400),
    });

    if (!result.ok) {
      return Response.json(
        { error: result.why, model_calls: result.model_calls, ms: result.ms },
        { status: 502 },
      );
    }

    // PERSISTED EITHER WAY, verdict included. A blocked document is kept so the
    // refusal is auditable: `verification_json` records that a document was
    // generated and what it was blocked for. Nothing is ever updated or deleted
    // here — a regeneration is a new row.
    let artifactId: string | null = null;
    let persistError: string | null = null;
    try {
      artifactId = await insertArtifact(sql, {
        userId: user.id,
        jobId: context.job.job_id,
        kind: KINDS[kind as keyof typeof KINDS].kind,
        contentText: result.text,
        modelProvider: result.model_provider,
        modelName: result.model_name,
        verification: result.verification,
        sourceJobTitle: context.job.job_title,
      });
    } catch (error) {
      // The document and its verdict are still returned. Losing the row is a
      // storage problem; withholding a verified document the student is looking
      // at because of a storage problem would be a worse one. Reported, not
      // swallowed — the UI says the copy was not saved.
      persistError = error instanceof Error ? error.message : String(error);
    }

    return Response.json({
      artifact_id: artifactId,
      persist_error: persistError,
      kind: result.kind,
      text: result.text,
      detail: result.detail,
      approach_reason: result.approach_reason,
      // Non-null only when the posting contained text aimed at an AI. Surfaced
      // rather than logged: a posting trying to steer the model is a finding the
      // student should see.
      posting_anomaly: result.posting_anomaly,
      verification: result.verification,
      downloadable: result.downloadable,
      cost: {
        model_calls: result.model_calls,
        model_provider: result.model_provider,
        model_name: result.model_name,
        ms: result.ms,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 502 });
  }
}

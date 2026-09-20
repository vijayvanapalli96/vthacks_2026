/**
 * GET /api/jobs/[jobId]/print/[artifactId] — the print view. HTML, not PDF.
 *
 * `artifactId` is either a real `artifacts.artifact_id`, or the literal
 * `resume`, which renders the student's profile as a resume with no model call
 * at all.
 *
 * WHY THIS IS AN HTML ROUTE HANDLER AND NOT A PAGE: a print view must not
 * inherit the app shell. A nav bar printed onto page one of a cover letter is
 * the exact failure the `@media print` stylesheet exists to prevent, and a route
 * handler runs no layout. It also means the whole document is one string that
 * `render-html.mjs` owns, which is what lets `cv-sections-core.mjs`'s
 * marker-based section stripping work at all.
 *
 * ── THE SECOND GATE ─────────────────────────────────────────────────────────
 *
 * This route re-reads the stored verdict and REFUSES a blocked document on its
 * own authority. It does not trust `downloadable` to have been honoured by the
 * UI, and it does not trust the client not to have guessed a URL. A fact gate
 * that only runs in the component is a fact gate that stops existing the moment
 * someone types the URL by hand — and the URL is guessable, because the artifact
 * id is in the page's own markup.
 *
 * Ownership is enforced in SQL: `getArtifact` filters on `user_id` as well as
 * `artifact_id`, so one student cannot print another's document by id.
 */
import { getArtifact } from '@/lib/artifacts/store.mjs';
import { loadFactSource } from '@/lib/artifacts/facts.mjs';
import { loadJob } from '@/lib/artifacts/job.mjs';
import {
  renderDocumentHtml,
  renderResumeHtml,
  renderBlockedHtml,
  renderNoticeHtml,
} from '@/lib/artifacts/render-html.mjs';
import { sql } from '@/lib/databricks';
import { requireRole } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const HTML = {
  // `no-store`: the verdict can change between generations and a cached print
  // view of a since-superseded document is a document nobody checked.
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // A print view is our own markup plus escaped text, but it is escaped text
  // that came from a model that read a scraped posting. Belt and braces.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  'x-content-type-options': 'nosniff',
} as const;

const KIND_TITLE: Record<string, string> = {
  cover_letter: 'Cover letter',
  answers: 'Application answers',
  resume: 'Tailored resume bullets',
  email: 'Email draft',
  analysis: 'Analysis',
};

function htmlResponse(body: string, status = 200) {
  return new Response(body, { status, headers: HTML });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string; artifactId: string }> },
) {
  const user = await requireRole('applicant');
  const { jobId, artifactId } = await params;
  const decodedJobId = decodeURIComponent(jobId);
  const decodedArtifactId = decodeURIComponent(artifactId);

  try {
    // Same validation as every other endpoint in this feature. A print view for
    // a posting that does not exist is a 404, not a blank page.
    const job = await loadJob(sql, decodedJobId);
    if (!job) {
      // renderNoticeHtml, NOT renderBlockedHtml: a missing posting is not a
      // document that failed the fact gate, and the refusal page's copy ("fix
      // the claims above") is nonsense here.
      return htmlResponse(
        renderNoticeHtml({
          title: 'Unknown posting',
          message: 'No posting with that id exists in job_snapshots, so there is nothing to print against it.',
        }),
        404,
      );
    }

    // ── The free path: the student's own profile as a resume. Zero model
    // calls, nothing generated, nothing to verify — every word of it is a fact
    // they gave us, so there is no claim to check.
    if (decodedArtifactId === 'resume') {
      const facts = await loadFactSource(sql, user.id);
      if (facts.factCount === 0) {
        return htmlResponse(
          renderNoticeHtml({
            title: 'Resume',
            message:
              'Your profile has no saved facts yet, so there is no resume to render. Run resume intake first.',
          }),
          422,
        );
      }
      return htmlResponse(
        renderResumeHtml({
          structured: facts.structured,
          generatedAt: new Date().toISOString().slice(0, 10),
          note:
            `Assembled from the ${facts.factCount} facts in your profile with no model call. ` +
            `Every line is something you told us; nothing here was written for you.`,
        }),
      );
    }

    const artifact = await getArtifact(sql, user.id, decodedArtifactId);
    if (!artifact || artifact.job_id !== job.job_id) {
      // Same answer for "does not exist" and "belongs to someone else" — the
      // distinction is exactly what an id-guessing probe is trying to learn.
      return htmlResponse(
        renderNoticeHtml({
          title: 'Not found',
          message: 'No document with that id exists for this posting in your workspace.',
        }),
        404,
      );
    }

    // ── THE REFUSAL. Independent of the client. ─────────────────────────────
    if (!artifact.downloadable) {
      // The STORED verdict decides, not a fresh run of the gate. The question
      // this route answers is "what did we decide when we showed it to you?",
      // and re-verifying here could quietly disagree with the verdict the
      // student was shown — which would mean the refusal they saw and the
      // refusal they get are two different decisions.
      return htmlResponse(
        renderBlockedHtml({
          title: KIND_TITLE[artifact.kind] ?? artifact.kind,
          findings: artifact.verification?.findings ?? [],
          sentence:
            artifact.verification?.sentence ??
            'This document did not pass the fact check against your profile, so no printable version exists.',
        }),
        403,
      );
    }

    return htmlResponse(
      renderDocumentHtml({
        title: KIND_TITLE[artifact.kind] ?? artifact.kind,
        subtitle: [artifact.source_job_title, job.company_name].filter(Boolean).join(' · '),
        text: artifact.content_text,
        generatedAt: artifact.created_at,
        modelName: artifact.model_name,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return htmlResponse(
      renderNoticeHtml({
        title: 'Could not open the print view',
        message: `${message} The warehouse cold-starts in 20 to 30 seconds; reloading usually fixes it.`,
      }),
      502,
    );
  }
}

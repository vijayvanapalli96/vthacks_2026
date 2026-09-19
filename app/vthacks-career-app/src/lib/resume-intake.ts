/**
 * resume-intake.ts — upload -> extract -> append to memory, in one place.
 *
 * The API route and the server action both call this so they cannot drift. It
 * validates the file, extracts, appends facts, and reports the gaps.
 *
 * The SKIP path lives here too, and it is a first-class outcome rather than an
 * absence: skipping records that every field is still open, which is exactly the
 * list the voice agent works through. "Upload or skip" only works as a product if
 * skipping produces something.
 */
import {
  detectGaps,
  emptyProfile,
  extractProfile,
  providerLabel,
  type ExtractOutcome,
  type ProfileGap,
} from '@/lib/extract';
import { PdfParseError } from '@/lib/extract/pdf';
import { NoProviderError } from '@/lib/extract';
import { appendFacts, toFacts } from '@/lib/profile-memory';
import type { ExtractedProfile, ExtractProvider } from '@/lib/extract/types';

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

export type IntakeSuccess = {
  ok: true;
  profile: ExtractedProfile;
  provider: ExtractProvider | null;
  providerLabel: string | null;
  model: string | null;
  warnings: string[];
  gaps: ProfileGap[];
  factsAppended: number;
  backend: 'databricks' | 'dev-file';
  sourceRef: string;
  pages: number;
};

export type IntakeFailure = {
  ok: false;
  /** Safe to show a user verbatim. */
  error: string;
};

export type IntakeResult = IntakeSuccess | IntakeFailure;

/** Validate an uploaded file before we spend a model call on it. */
export function validateUpload(file: File | null): IntakeFailure | null {
  if (!file || file.size === 0) {
    return { ok: false, error: 'Choose a PDF resume to upload.' };
  }
  if (file.size > MAX_RESUME_BYTES) {
    return {
      ok: false,
      error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`,
    };
  }
  // Browsers lie about type often enough that pdfToText re-checks the magic bytes.
  if (file.type && file.type !== 'application/pdf') {
    return { ok: false, error: 'That file is not a PDF. Export your resume as a PDF and try again.' };
  }
  return null;
}

/** Full intake for an uploaded resume. Returns a discriminated result, never throws. */
export async function ingestResume(file: File | null, userId: string): Promise<IntakeResult> {
  const invalid = validateUpload(file);
  if (invalid) return invalid;
  // validateUpload rejects null, so this is safe.
  file = file as File;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sourceRef = file.name || 'resume.pdf';

  let outcome: ExtractOutcome;
  try {
    outcome = await extractProfile(bytes);
  } catch (error) {
    if (error instanceof PdfParseError) return { ok: false, error: error.message };
    if (error instanceof NoProviderError) return { ok: false, error: error.message };
    return {
      ok: false,
      error: `Extraction failed: ${(error as Error).message}`,
    };
  }

  const facts = toFacts(outcome.profile, {
    userId,
    provider: outcome.provider,
    model: outcome.model,
    sourceRef,
  });
  const appended = await appendFacts(facts);

  return {
    ok: true,
    profile: outcome.profile,
    provider: outcome.provider,
    providerLabel: providerLabel(outcome.provider),
    model: outcome.model,
    warnings: [...outcome.warnings, ...appended.warnings],
    gaps: outcome.gaps,
    factsAppended: appended.appended,
    backend: appended.backend,
    sourceRef,
    pages: outcome.totalPages,
  };
}

/**
 * The skip path. No resume, so every field is a gap and the voice agent has a
 * complete agenda. Nothing is written to memory: we have learned nothing yet, and
 * writing an empty fact would be recording a claim we cannot source.
 */
export function skipResume(): IntakeSuccess {
  const profile = emptyProfile();
  return {
    ok: true,
    profile,
    provider: null,
    providerLabel: null,
    model: null,
    warnings: [],
    gaps: detectGaps(profile),
    factsAppended: 0,
    backend: 'dev-file',
    sourceRef: 'skipped',
    pages: 0,
  };
}

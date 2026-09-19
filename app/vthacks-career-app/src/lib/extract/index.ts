/**
 * index.ts — one entry point for resume extraction, two sponsor paths behind it.
 *
 * Provider selection (EXTRACT_PROVIDER):
 *   databricks  force ai_query. No external key, no rate limit, already smoke-tested.
 *   gemini      force Gemini multimodal. Best on two-column layouts.
 *   auto        (default) Gemini when a key is present, otherwise Databricks.
 *
 * Whichever runs first, the other is the fallback. A provider failure becomes a
 * warning on a successful result, not an error page: the student uploaded a
 * resume and is owed an answer.
 *
 * `provider` and `model` ride along on every result because
 * workspace.vthacks_2026.match_evaluations already has model_provider/model_name
 * columns — so a Gemini-vs-Databricks comparison costs us nothing later.
 */
import { pdfToText, PdfParseError } from './pdf';
import { extractWithDatabricks, DATABRICKS_MODEL } from './databricks';
import { extractWithGemini, hasGemini } from './gemini';
import { hasDatabricks } from '@/lib/databricks';
import { detectGaps, type ExtractProvider, type ExtractionResult, type ProfileGap } from './types';

export type ExtractOutcome = ExtractionResult & {
  gaps: ProfileGap[];
  /** Characters of text recovered from the PDF. 0 on the Gemini-only path. */
  textLength: number;
  totalPages: number;
};

/** Seams for tests: swap either provider without env vars or network. */
export type ExtractDeps = {
  fromText: (text: string) => Promise<ExtractionResult>;
  fromPdf: (bytes: Uint8Array) => Promise<ExtractionResult>;
  databricksAvailable: () => boolean;
  geminiAvailable: () => boolean;
};

const defaultDeps: ExtractDeps = {
  fromText: extractWithDatabricks,
  fromPdf: extractWithGemini,
  databricksAvailable: hasDatabricks,
  geminiAvailable: hasGemini,
};

export class NoProviderError extends Error {
  constructor() {
    super(
      'No extraction provider is configured. Set DATABRICKS_HOST + DATABRICKS_TOKEN + ' +
        'DATABRICKS_WAREHOUSE_ID, or GOOGLE_GENERATIVE_AI_API_KEY.',
    );
    this.name = 'NoProviderError';
  }
}

function resolveOrder(deps: ExtractDeps): ExtractProvider[] {
  const requested = (process.env.EXTRACT_PROVIDER ?? 'auto').trim().toLowerCase();
  const databricks = deps.databricksAvailable();
  const gemini = deps.geminiAvailable();

  if (requested === 'databricks') return databricks ? ['databricks'] : [];
  if (requested === 'gemini') return gemini ? ['gemini'] : [];

  // auto: prefer the multimodal path when we can, fall back to the always-there one.
  const order: ExtractProvider[] = [];
  if (gemini) order.push('gemini');
  if (databricks) order.push('databricks');
  return order;
}

/**
 * Extract a profile from PDF bytes.
 *
 * Throws only when nothing can possibly work: an unreadable PDF (PdfParseError),
 * no configured provider (NoProviderError), or every provider failing (the last
 * provider's error). Everything softer lands in `warnings`.
 */
export async function extractProfile(
  bytes: Uint8Array,
  deps: ExtractDeps = defaultDeps,
): Promise<ExtractOutcome> {
  const order = resolveOrder(deps);
  if (order.length === 0) throw new NoProviderError();

  const warnings: string[] = [];
  let textLength = 0;
  let totalPages = 0;
  let lastError: unknown;

  for (const provider of order) {
    try {
      if (provider === 'gemini') {
        const result = await deps.fromPdf(bytes);
        return finish(result, warnings, textLength, totalPages);
      }

      // Databricks path needs text. A PDF we cannot read is fatal for every
      // text-based provider, so surface it rather than trying the next one.
      const parsed = await pdfToText(bytes);
      textLength = parsed.text.length;
      totalPages = parsed.totalPages;
      const result = await deps.fromText(parsed.text);
      return finish(result, warnings, textLength, totalPages);
    } catch (error) {
      if (error instanceof PdfParseError) throw error;
      lastError = error;
      warnings.push(`${providerLabel(provider)} failed: ${(error as Error).message}`);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Every extraction provider failed for an unknown reason.');
}

function finish(
  result: ExtractionResult,
  warnings: string[],
  textLength: number,
  totalPages: number,
): ExtractOutcome {
  const merged = [...warnings, ...result.warnings];
  if (merged.length > 0) {
    // A fallback happened. Say which model actually produced the data so the UI
    // never attributes a profile to the wrong provider.
    merged.unshift(`Extracted with ${providerLabel(result.provider)} (${result.model}).`);
  }
  return {
    ...result,
    warnings: merged,
    gaps: detectGaps(result.profile),
    textLength,
    totalPages,
  };
}

export function providerLabel(provider: ExtractProvider): string {
  return provider === 'databricks' ? 'Databricks ai_query' : 'Gemini';
}

export function providerModel(provider: ExtractProvider): string {
  return provider === 'databricks' ? DATABRICKS_MODEL : 'gemini-2.5-flash';
}

// Re-export the schema, types and gap helpers so callers import from one place.
export * from './types';

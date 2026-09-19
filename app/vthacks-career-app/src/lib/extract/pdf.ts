/**
 * pdf.ts — PDF bytes -> plain text.
 *
 * unpdf wraps a serverless build of PDF.js: pure JS, no native addons, no
 * system poppler. That matters because this has to run unchanged on a Windows
 * laptop and inside a Databricks App container.
 *
 * Page boundaries are preserved as blank lines. Resumes are overwhelmingly
 * one page, but when they are two the page break is a genuine section signal
 * and collapsing it loses information the model can use.
 */
import { extractText } from 'unpdf';

/** PDF files begin with "%PDF-". Checked before we hand bytes to any parser. */
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

export type PdfText = {
  text: string;
  totalPages: number;
};

export class PdfParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfParseError';
  }
}

/**
 * Extract text from a PDF. Throws PdfParseError for anything unreadable so the
 * caller can distinguish "this file is broken" (user's problem, show a message)
 * from "the model failed" (our problem, fall back to another provider).
 */
export async function pdfToText(bytes: Uint8Array): Promise<PdfText> {
  if (!looksLikePdf(bytes)) {
    throw new PdfParseError('That file is not a PDF. Upload a PDF resume.');
  }

  let pages: string[];
  let totalPages: number;
  try {
    const result = await extractText(bytes, { mergePages: false });
    pages = result.text;
    totalPages = result.totalPages;
  } catch (cause) {
    throw new PdfParseError('That PDF could not be read. It may be corrupt or password-protected.', { cause });
  }

  const text = pages
    .map((page) => page.replace(/[ \t]+\n/g, '\n').trim())
    .filter((page) => page.length > 0)
    .join('\n\n');

  if (text.length === 0) {
    throw new PdfParseError(
      'That PDF has no selectable text — it is probably a scan. A text-based PDF export works best.',
    );
  }

  return { text, totalPages };
}

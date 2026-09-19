/**
 * json.ts — pull a JSON object out of whatever a language model actually returned.
 *
 * Instruction-following on "reply with JSON only" is good but not perfect. In
 * practice you get: fenced code blocks, a "Here is the extracted profile:"
 * preamble, trailing commentary, or smart quotes pasted from the resume. Rather
 * than tighten the prompt forever, parse defensively — this is ~30 lines and it
 * removes a whole class of demo failure.
 */

export class ModelOutputError extends Error {
  /** The unparsed model output, kept for logging. */
  raw: string;

  // Written out longhand rather than as a TS parameter property so this module
  // also runs under `node --experimental-strip-types` for quick harness scripts.
  constructor(message: string, raw: string) {
    super(message);
    this.name = 'ModelOutputError';
    this.raw = raw;
  }
}

/**
 * Best-effort extraction of the first complete JSON object in `raw`.
 * Brace-matching rather than a regex, because resume bullets contain braces.
 */
export function parseJsonObject(raw: string): unknown {
  const stripped = stripFences(raw).trim();

  // Fast path: the whole thing is already JSON.
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through to brace scanning
  }

  const candidate = firstBalancedObject(stripped);
  if (candidate === null) {
    throw new ModelOutputError('Model output contained no JSON object.', raw);
  }

  try {
    return JSON.parse(candidate);
  } catch (cause) {
    throw new ModelOutputError(
      `Model output looked like JSON but did not parse: ${(cause as Error).message}`,
      raw,
    );
  }
}

function stripFences(raw: string): string {
  // ```json ... ``` or ``` ... ```
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : raw;
}

function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

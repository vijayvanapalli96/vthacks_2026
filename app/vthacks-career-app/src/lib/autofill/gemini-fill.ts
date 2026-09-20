/**
 * gemini-fill.ts — map a real application form, field by field, onto real facts.
 *
 * WHAT THIS REPLACES. Autofill knew eight selectors per provider: name, email,
 * phone, resume, cover letter, location, linkedin, website. Every Ashby form also
 * carries the questions that actually take time — "why this team", "which of these
 * describes your experience with X", "when could you start" — and those were left
 * blank, so "autofill" meant filling the boring half of the form.
 *
 * The worker now enumerates every control on the live page (Ashby's form is
 * entirely client-rendered: its HTML contains zero <input> and zero <label>, so
 * nothing server-side can see the fields). This file takes that list and asks
 * Gemini for a value per field.
 *
 * THE RULE THAT MATTERS MORE THAN FILLING THE FORM. This writes into a real
 * employer's application under the candidate's name. apply.md's refusal rule is
 * lifted intact and hard-coded below: never answer work authorisation, visa,
 * sponsorship, salary, demographic, disability, veteran or background-check
 * questions. Those come back `needs_confirmation` with an empty value and the
 * human answers them. A confidently wrong answer to "will you now or in the
 * future require sponsorship" can cost somebody a job offer, and a blank box
 * costs them ten seconds.
 *
 * NOTHING IS INVENTED. Every value has to come from the EVIDENCE block. A field
 * the profile cannot answer comes back empty with a reason, which the review
 * screen shows — "your profile has no phone number" beats a silently empty box
 * and beats a plausible fabricated one by a mile.
 *
 * NOTHING IS SUBMITTED. This produces a PLAN. The worker types it in and stops;
 * hard rule 3 puts a human between a filled form and a sent one.
 */
import { GEMINI_MODEL, GeminiError, getGeminiKey } from '@/lib/extract/gemini';
import { parseJsonObject } from '@/lib/extract/json';

const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/**
 * The flash tier, not the lite one used for interview questions.
 *
 * Reading a form's own wording and deciding which stored fact answers it is a
 * comprehension task on someone's real application. The few cents of difference
 * is not where this feature should economise.
 */
const FILL_MODEL = process.env.GEMINI_AUTOFILL_MODEL ?? GEMINI_MODEL;

/** A long form on a slow model, inside a request a human is waiting on. */
const TIMEOUT_MS = 45_000;

/** One control on the page, as the worker found it. */
export type DiscoveredField = {
  /** CSS selector the worker will fill. Round-tripped untouched. */
  selector: string;
  /** The visible label, or the placeholder, or the name attribute. */
  label: string;
  type: string;
  required: boolean;
  /** For a select or a radio group. Empty for free text. */
  options?: string[];
  maxLength?: number | null;
};

export type PlannedField = {
  selector: string;
  label: string;
  /** Empty string means "leave it blank", and `reason` says why. */
  value: string;
  /** True for anything a human must answer themselves. Never auto-filled. */
  needsConfirmation: boolean;
  /** One sentence, shown on the review screen next to the field. */
  reason: string;
};

/**
 * Questions we never answer, whatever the profile happens to contain.
 *
 * Matched here as well as instructed in the prompt, because a model told not to
 * answer something will occasionally answer it anyway, and this is the class of
 * mistake that is expensive for the candidate rather than embarrassing for us.
 * Belt and braces, same pattern as the fact gate on generated documents.
 */
const NEVER_ANSWER =
  /(sponsor|visa|work authoriz|work authoris|right to work|citizen|immigration|salary|compensation|pay expect|desired pay|race|ethnic|gender|sex |pronoun|disab|veteran|military|felony|conviction|background check|date of birth|age\b|age range|sexual orientation|prefer not to (say|answer)|decline to)/i;

/**
 * Age bands, which name no protected word at all.
 *
 * A real Ashby form asks this as radio options reading "Under 30", "30-39",
 * "40-49", "50-59" - found while testing discovery against a live posting. The
 * worker now prefixes a radio with its group question so the word "age" usually
 * arrives with it; this catches the case where the question is worded without.
 */
const AGE_BAND = /(^|\s)(under|over)\s*\d{2}(\s|$)|(^|\s)\d{2}\s*[-–]\s*\d{2}(\s|$)/i;

export function requiresHuman(label: string): boolean {
  return NEVER_ANSWER.test(label) || AGE_BAND.test(label);
}

export function hasAutofillModel(): boolean {
  return getGeminiKey() !== null;
}

export type FillInputs = {
  jobTitle: string;
  company: string;
  /** The same evidence text the document generators verify against. */
  evidence: string;
  fields: DiscoveredField[];
};

/**
 * Plan a value for every field. Throws when Gemini is unusable; the caller falls
 * back to the deterministic header mapping, which is the old eight fields.
 */
export async function planFieldValues(input: FillInputs): Promise<PlannedField[]> {
  const key = getGeminiKey();
  if (!key) throw new GeminiError('GOOGLE_GENERATIVE_AI_API_KEY is not set.');

  // Gated before the model sees them, so a sponsorship question cannot come back
  // answered even if the prompt is ignored.
  const forHuman = input.fields.filter((field) => requiresHuman(field.label));
  const forModel = input.fields.filter((field) => !requiresHuman(field.label));

  const planned: PlannedField[] = forHuman.map((field) => ({
    selector: field.selector,
    label: field.label,
    value: '',
    needsConfirmation: true,
    reason: 'You answer this one. We never answer work authorisation, pay, demographic or background questions for you.',
  }));

  if (forModel.length === 0) return planned;

  const response = await fetch(ENDPOINT(FILL_MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt({ ...input, fields: forModel }) }] }],
      // Zero: this is transcription of facts into boxes, not writing. A creative
      // answer here is a fabricated claim on a real application.
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });

  const raw = await response.text();
  if (!response.ok) throw new GeminiError(`Gemini returned ${response.status}: ${raw.slice(0, 300)}`);

  let payload: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  try {
    payload = JSON.parse(raw);
  } catch (cause) {
    throw new GeminiError('Gemini returned a non-JSON body.', { cause });
  }
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  if (!text.trim()) throw new GeminiError('Gemini returned an empty candidate.');

  const parsed = parseJsonObject(text) as { fields?: unknown };
  const list = Array.isArray(parsed?.fields) ? parsed.fields : [];
  const bySelector = new Map(forModel.map((field) => [field.selector, field]));

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const selector = typeof record.selector === 'string' ? record.selector : '';
    const field = bySelector.get(selector);
    // A selector the model invented is dropped rather than typed into a page.
    if (!field) continue;
    bySelector.delete(selector);

    const value = typeof record.value === 'string' ? record.value : '';
    const reason = typeof record.reason === 'string' ? record.reason : '';
    planned.push({
      selector,
      label: field.label,
      // Last line of defence: a value for a question we said we would not answer
      // is discarded even if the model produced one.
      value: requiresHuman(field.label) ? '' : trim(value, field.maxLength),
      needsConfirmation: requiresHuman(field.label) || value.trim() === '',
      reason: reason || (value.trim() ? 'Filled from your profile.' : 'Your profile does not answer this one.'),
    });
  }

  // Anything the model skipped is reported as skipped rather than silently absent.
  for (const field of bySelector.values()) {
    planned.push({
      selector: field.selector,
      label: field.label,
      value: '',
      needsConfirmation: true,
      reason: 'Not filled: nothing in your profile answers this.',
    });
  }

  return planned;
}

function trim(value: string, maxLength?: number | null): string {
  const clean = value.trim();
  return maxLength && maxLength > 0 ? clean.slice(0, maxLength) : clean;
}

function prompt(input: FillInputs): string {
  return [
    'You are filling in one real job application form for one real candidate. A human reviews',
    'everything you produce before anything is sent. Nothing you write is submitted by you.',
    '',
    'RULES — each one exists because breaking it harms the candidate:',
    '1. Use ONLY the EVIDENCE block. Never state a fact, a number, an employer, a tool or a date',
    '   that is not in it. A fabricated claim on a real application is the worst outcome here,',
    '   worse by far than an empty box.',
    '2. If the evidence does not answer a field, return an EMPTY value and say so in `reason`.',
    '   An empty box takes the candidate ten seconds. A wrong one can cost them the job.',
    '3. Never answer questions about work authorisation, visa or sponsorship, salary or pay',
    '   expectations, race, ethnicity, gender, age, disability, veteran status, criminal record',
    '   or background checks. Those fields have already been removed from the list below; if one',
    '   reaches you anyway, return an empty value.',
    '4. For a field with OPTIONS, the value must be EXACTLY one of the given options, copied',
    '   character for character. If none of them is supported by the evidence, return empty.',
    '5. For free-text questions ("why do you want to work here", "tell us about a project"),',
    '   write in the first person, plainly, 60 to 120 words, using only what the evidence',
    '   supports. No filler openers, no "I am excited to", no em dashes.',
    '6. Respect maxLength when it is given.',
    '7. `reason` is one short sentence for the candidate, telling them where the value came from',
    '   or why the box is empty. Address them as "you".',
    '',
    `ROLE: ${input.jobTitle || '(not recorded)'} at ${input.company || '(not recorded)'}`,
    '',
    '=== EVIDENCE (everything known about this candidate) ===',
    input.evidence.slice(0, 12_000) || '(no profile facts recorded)',
    '=== END EVIDENCE ===',
    '',
    '=== FIELDS ===',
    JSON.stringify(
      input.fields.map((field) => ({
        selector: field.selector,
        label: field.label,
        type: field.type,
        required: field.required,
        options: field.options?.length ? field.options : undefined,
        maxLength: field.maxLength ?? undefined,
      })),
      null,
      1,
    ),
    '=== END FIELDS ===',
    '',
    'Return exactly this JSON and nothing else. One entry per field above, same selectors:',
    '{"fields":[{"selector":"...","value":"...","reason":"..."}]}',
  ].join('\n');
}

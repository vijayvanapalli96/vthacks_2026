/**
 * scribe.ts — speech to text for the interview room. ElevenLabs Scribe.
 *
 * WHY SCRIBE AND NOT WHISPER. One key instead of two. The room already needs
 * ELEVENLABS_API_KEY for persona 2's voice, and the hosted Whisper API is OpenAI's,
 * so using it would have made a second vendor, a second account and a second bill a
 * hard requirement for one half of one feature. Same key, same vendor, same dashboard.
 *
 * WHY STT AT ALL WHEN THE AGENT ALREADY HEARS THE CANDIDATE. Two different jobs. The
 * conversational agent transcribes in order to decide what to say next, and what it
 * heard lives in ElevenLabs' conversation store. The critique needs a verbatim record
 * WE hold, attached to a question id, in a table we can read back next week. It also
 * has to work when the voice hop is off entirely: a student can hit record, speak,
 * and still get a transcript and a critique with no agent in the loop.
 *
 * THE KEY NEVER REACHES THE BROWSER. Read here, used server-side, and the browser
 * only ever posts audio to /api/interview/[jobId]/transcribe and gets text back. It
 * never learns which vendor transcribed it. Same discipline as elevenlabs.ts, and
 * deliberately NOT named NEXT_PUBLIC_* — Next inlines that prefix into the client
 * bundle at build time.
 */

const API = 'https://api.elevenlabs.io/v1/speech-to-text';

/** A three-minute answer on hotel wifi, transcribed by a cold endpoint. */
const TIMEOUT_MS = 60_000;

/**
 * Scribe accepts files up to 5 GB. This limit is ours and is much smaller: an
 * interview answer is minutes, and anything past this is a broken recorder rather
 * than a talkative student.
 */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/**
 * `scribe_v2` is the current model in the API reference.
 *
 * Overridable because of exactly what happened to us with Gemini: a pinned
 * `gemini-2.5-flash` started returning 404 "no longer available to new users" on a
 * fresh project mid-build. A model id in an environment variable is a one-line fix
 * at 3 AM instead of a redeploy. If `scribe_v2` is not enabled on the account, set
 * ELEVENLABS_STT_MODEL=scribe_v1 — the request shape is identical.
 */
export const STT_MODEL = process.env.ELEVENLABS_STT_MODEL ?? 'scribe_v2';

function apiKey(): string | null {
  return process.env.ELEVENLABS_API_KEY?.trim() || null;
}

/**
 * Whether POST .../transcribe will do anything.
 *
 * Note this is the SAME key that gates persona 2's voice, and the two are still
 * reported separately in the room: an account with a key but no interviewer agent id
 * gets spoken answers transcribed while the questions stay on screen.
 */
export function sttReady(): boolean {
  return apiKey() !== null;
}

export class ScribeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScribeError';
  }
}

export type Transcription = {
  text: string;
  /**
   * Seconds of actual speech, from the last word's end timestamp.
   *
   * MEASURED, NOT TIMED BY THE CLIENT. The browser can only time from "record
   * pressed" to "stop pressed", which includes the student reading the question,
   * thinking, and fumbling for the stop button. Pacing feedback computed from that
   * would tell a careful speaker they were slow. Null when the response carried no
   * word timings.
   */
  seconds: number | null;
};

/**
 * Audio in, text and duration out.
 *
 * `language_code: 'eng'` is passed deliberately. Left to auto-detect, a quiet and
 * nervous first answer occasionally comes back as another language, fluently
 * translated — and the critique would then be run against words the student did not
 * say. The app is English-only today; when that stops being true this becomes a
 * parameter rather than a constant.
 *
 * `diarize` is off: there is one speaker, and speaker labels in the stored answer
 * would be noise. `tag_audio_events` is off for the same reason — "[laughter]" in
 * the middle of a rehearsal answer is not something the critique should count as a
 * word.
 */
export async function transcribe(audio: Blob, filename: string): Promise<Transcription> {
  const key = apiKey();
  if (!key) throw new ScribeError('ELEVENLABS_API_KEY is not set.');
  if (audio.size === 0) throw new ScribeError('The recording was empty.');
  if (audio.size > MAX_AUDIO_BYTES) {
    throw new ScribeError(`That recording is ${Math.round(audio.size / 1_000_000)} MB, which is past the limit.`);
  }

  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model_id', STT_MODEL);
  form.append('language_code', 'eng');
  form.append('diarize', 'false');
  form.append('tag_audio_events', 'false');
  // Word timings are what `seconds` is computed from. Without this the pacing half
  // of the critique silently goes quiet.
  form.append('timestamps_granularity', 'word');

  const response = await fetch(API, {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const raw = await response.text();
  if (!response.ok) {
    // Summarised by the caller before it reaches the browser: the upstream body can
    // echo request detail.
    throw new ScribeError(`Scribe returned ${response.status}: ${raw.slice(0, 300)}`);
  }

  let parsed: { text?: unknown; words?: unknown };
  try {
    parsed = JSON.parse(raw) as { text?: unknown; words?: unknown };
  } catch (cause) {
    throw new ScribeError('Scribe returned a non-JSON body.', { cause });
  }

  // An empty transcript is a real outcome — silence, a muted microphone, a mic the
  // browser granted but the OS did not. Returned as an empty string so the caller
  // can say "we heard nothing", rather than thrown as a failure.
  return {
    text: typeof parsed.text === 'string' ? parsed.text.trim() : '',
    seconds: lastWordEnd(parsed.words),
  };
}

/**
 * The end timestamp of the last spoken word, in seconds.
 *
 * Scans for the maximum rather than reading the final element: the array also
 * carries `spacing` entries, and a trailing one would report the end of the silence
 * after the answer as part of it.
 */
function lastWordEnd(words: unknown): number | null {
  if (!Array.isArray(words)) return null;
  let end = 0;
  for (const word of words) {
    if (!word || typeof word !== 'object') continue;
    const record = word as Record<string, unknown>;
    if (record.type !== undefined && record.type !== 'word') continue;
    const value = Number(record.end);
    if (Number.isFinite(value) && value > end) end = value;
  }
  return end > 0 ? end : null;
}

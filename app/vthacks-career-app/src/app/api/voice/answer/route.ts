/**
 * POST /api/voice/answer — THE write path. One endpoint, two ways in.
 *
 * The ElevenLabs client tool `record_answer` posts here. The typed input in the
 * transcript panel posts here. There is no second implementation, no "voice
 * variant", and no shortcut around this handler — that is hard rule 5,
 * "everything you can say, you can type", made true at the API layer rather than
 * approximated by two similar functions.
 *
 * It is a CLIENT tool and not an ElevenLabs server tool for a concrete reason: a
 * server tool needs a public HTTPS URL to call, and `localhost:3001` has none.
 * Running the tool in the browser also means the request carries the session cookie
 * already, so the answer is attributed to the signed-in user by the same guard every
 * other route uses — rather than by a user id the model was told to pass, which a
 * conversation could get wrong or be talked into changing.
 *
 * WHICH IS TO SAY: user_id comes from requireRole(), never from the request body.
 * Everything else in the body is user input — literally transcribed speech — and is
 * bound as a named parameter or matched against a whitelist. Nothing is concatenated.
 */
import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/session';
import { recordAnswer, VoiceAnswerError } from '@/lib/voice';
import type { VoiceAnswerRequest, VoiceAnswerResponse } from '@/lib/voice-contract';

export const dynamic = 'force-dynamic';

function fail(message: string, status: number): NextResponse {
  const body: VoiceAnswerResponse = {
    ok: false,
    action: message,
    actionKind: 'profile_updated',
    fieldKey: '',
    storedValue: '',
    confidence: 0,
    gapsRemaining: -1,
    error: message,
  };
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  const user = await requireRole('applicant');

  let body: Partial<VoiceAnswerRequest>;
  try {
    body = (await request.json()) as Partial<VoiceAnswerRequest>;
  } catch {
    return fail('That request body was not JSON.', 400);
  }

  // field_key AND fieldKey are both accepted. The client tool's parameter names are
  // written in the agent's configuration in snake_case (which is what the model
  // produces naturally), and the typed form sends camelCase like the rest of the
  // app. Normalising here is one line; making the model guess is a live failure
  // mid-conversation.
  const raw = body as Record<string, unknown>;
  const fieldKey = String(raw.fieldKey ?? raw.field_key ?? '').trim();
  const value = String(raw.value ?? '').trim();
  const spokenText = raw.spokenText ?? raw.spoken_text;
  const rawSource = String(raw.source ?? 'voice');
  const rawTurnIndex = raw.turnIndex ?? raw.turn_index;

  if (!fieldKey) return fail('No field_key was given, so there is nothing to record.', 400);
  if (!value) return fail('No value was given, so there is nothing to record.', 400);

  // Client-asserted, and only two values are legal. It decides the confidence we
  // store (speech can be misheard, typing cannot) and what answer_source records.
  const source: 'voice' | 'form' = rawSource === 'form' ? 'form' : 'voice';

  // No conversation id means this did not come from a conversation — the typed
  // fallback with the microphone never touched. It still needs an id so the turns
  // group, and the `typed:` prefix keeps it obviously distinguishable from an
  // ElevenLabs one in voice_turns.
  const conversationId = String(raw.conversationId ?? raw.conversation_id ?? '').trim() || `typed:${randomUUID()}`;

  const turnIndex =
    typeof rawTurnIndex === 'number' && Number.isInteger(rawTurnIndex) && rawTurnIndex >= 0
      ? rawTurnIndex
      : undefined;

  try {
    const outcome = await recordAnswer({
      userId: user.id,
      fieldKey,
      value,
      conversationId,
      source,
      spokenText: typeof spokenText === 'string' ? spokenText : undefined,
      turnIndex,
    });

    const response: VoiceAnswerResponse = { ok: true, ...outcome };
    return NextResponse.json(response, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof VoiceAnswerError) return fail(error.message, error.status);

    // Everything here is a Databricks failure in practice. The message goes back
    // because the agent reads it out and the user deserves to know their answer did
    // not land — a silently dropped answer is worse than an audible failure.
    console.error('voice: recordAnswer failed', error);
    return fail(
      `I could not save that just now — ${(error as Error).message}. Nothing was changed; try again or type it.`,
      502,
    );
  }
}

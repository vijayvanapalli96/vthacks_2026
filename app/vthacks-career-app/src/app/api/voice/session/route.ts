/**
 * GET /api/voice/session — everything the browser needs to start talking, minus the key.
 *
 * Three things happen here and the order matters:
 *
 *   1. Read the question queue from profile_gaps. This is the agent's script; it is
 *      not generated, not inferred, and not held in the prompt.
 *   2. Mint a SIGNED conversation URL server-side. ELEVENLABS_API_KEY is read in
 *      src/lib/elevenlabs.ts and never leaves the server — the browser gets a URL
 *      whose signature expires in minutes.
 *   3. Warm the write path, so the first answer of the conversation is not the one
 *      that pays the warehouse's 20-30 second cold start.
 *
 * A FAILED VOICE HOP IS NOT A FAILED REQUEST. If ElevenLabs is unconfigured or
 * unreachable this still returns 200 with `signedUrl: null` and a sentence saying
 * why. The transcript and the typed input are the product; the microphone is one
 * way into them. Returning 500 here would take the working half of the feature down
 * with the broken half.
 *
 * GET is correct: this reads the queue and mints a short-lived credential. It writes
 * nothing.
 */
import { NextResponse } from 'next/server';

import { elevenLabsConfig, signedConversationUrl } from '@/lib/elevenlabs';
import { requireRole } from '@/lib/session';
import { buildFirstMessage, openGaps, voiceContext, warmWritePath, answerableFields } from '@/lib/voice';
import type { VoiceSessionPayload } from '@/lib/voice-contract';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireRole('applicant');

  // Independent reads, so they go out together. Serialising them against a
  // warehouse where each round trip is tens of milliseconds at best (and 30
  // seconds when cold) is the difference between a button that responds and one
  // that looks broken. warmWritePath never rejects.
  const [gaps, context] = await Promise.all([
    openGaps(user.id),
    voiceContext(user.id),
    warmWritePath(user.id),
  ]);

  const firstMessage = buildFirstMessage(context, gaps);

  let signedUrl: string | null = null;
  let unavailableReason: string | null = null;

  const configured = elevenLabsConfig();
  if ('reason' in configured) {
    unavailableReason = configured.reason;
  } else {
    try {
      signedUrl = await signedConversationUrl(configured.config);
    } catch (error) {
      // Logged in full server-side; summarised for the browser. The upstream body
      // can echo request detail and there is no reason to put it on a page.
      console.error('voice: signed URL request failed', (error as Error).message);
      unavailableReason =
        'ElevenLabs would not give us a conversation URL just now, so the microphone is unavailable. You can still type your answers below.';
    }
  }

  const payload: VoiceSessionPayload = {
    signedUrl,
    unavailableReason,
    gaps,
    firstMessage,
    // Substituted into the agent's prompt as {{name}}. Every value here is read by
    // the model and spoken out loud, so nothing secret belongs in it.
    dynamicVariables: {
      first_message: firstMessage,
      known_name: context.knownName ?? 'there',
      gap_count: String(gaps.length),
      gap_queue: gaps.length
        ? gaps.map((gap, i) => `${i + 1}. [${gap.fieldKey}] ${gap.question}`).join('\n')
        : '(nothing outstanding — thank them and offer to stop)',
      answerable_fields: answerableFields().join(', '),
      known_facts: String(context.factCount),
    },
  };

  return NextResponse.json(payload, {
    // A signed URL is a short-lived credential scoped to one user. It must never
    // land in a shared cache, a CDN, or the browser's back-forward cache.
    headers: { 'cache-control': 'no-store, private' },
  });
}

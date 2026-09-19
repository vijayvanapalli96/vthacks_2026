/**
 * Server-Sent Events stream for the intake analysis.
 *
 * Why SSE and not a plain POST that returns when it finishes: the work takes 30-60
 * seconds and the interesting part is WHAT it is doing. A single response can only
 * report the outcome; a stream reports each step as it happens, which is the whole
 * point of the processing page. SSE over WebSockets because this is one-directional
 * and needs no extra infrastructure.
 *
 * This route is a dumb pipe. All sequencing lives in analyzeIntake() so the same
 * steps run identically whether a browser, the voice agent, or a test drains them —
 * the "voice and UI call the same endpoints" rule.
 */
import { analyzeIntake } from '@/lib/intake';
import { requireRole } from '@/lib/session';

/** Streaming responses must not be cached or statically rendered. */
export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await requireRole('applicant');

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        for await (const event of analyzeIntake(user.id)) {
          send(event);
        }
      } catch (error) {
        // analyzeIntake yields its own errors, so reaching here means the stream
        // itself broke. Report it in-band: the client is watching this channel and
        // has no other way to learn the run died.
        send({ type: 'error', message: (error as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells any proxy in front of us not to buffer, which would defeat the point.
      'x-accel-buffering': 'no',
    },
  });
}

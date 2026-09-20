/**
 * POST /api/apply/stream — the same application, watched as it happens.
 *
 * Server-sent events over a POST response. The body is identical to /api/apply's
 * and so is the gate, because both call `runApplyExchange`: this route only adds
 * a `turn` event per message the agents exchange, pushed the moment it is
 * recorded rather than replayed afterwards.
 *
 *   event: turn    one message in the chain (see lib/a2a/transcript.ts)
 *   event: result  the same JSON /api/apply returns, including the saved
 *                  transcript with Gemini's lines for the applicant agent
 *   event: error   the exchange threw; nothing was sent
 *
 * A client that cannot stream loses nothing by using /api/apply instead — the
 * transcript is in that response too, just all at once at the end.
 */
import { auth } from '../../../../auth';
import { runApplyExchange, type ApplyBody } from '../../../../lib/a2a/apply-exchange';

export const dynamic = 'force-dynamic';

/** The ANS lookups, the employer round-trip and the narration, with headroom. */
export const maxDuration = 120;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: 'Authentication required.' }, { status: 401 });
  if (session.user.role !== 'applicant') return Response.json({ error: 'Applicant role required.' }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as ApplyBody;
  const userId = session.user.id ?? null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The student navigated away mid-handshake. The exchange itself is
          // already past the point of being cancellable and must finish and be
          // audited regardless; only the narration of it is lost.
        }
      };
      try {
        const result = await runApplyExchange(body, userId, (turn) => send('turn', turn));
        send('result', result.body);
      } catch (error) {
        console.error('The streamed apply exchange failed', error);
        send('error', {
          error: error instanceof Error ? error.message : 'The application could not be completed.',
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Caddy sits in front of this on the Vultr box; without it the whole
      // stream arrives at once when the handshake ends, which is the one thing
      // this route exists not to do.
      'x-accel-buffering': 'no',
    },
  });
}

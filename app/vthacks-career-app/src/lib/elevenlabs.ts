/**
 * elevenlabs.ts — the only file that touches ELEVENLABS_API_KEY.
 *
 * THE KEY NEVER REACHES THE BROWSER. It is read from the environment here, used to
 * mint a short-lived signed WebSocket URL, and the URL — not the key — is what the
 * client gets. Keeping that hop in one small file is the point: reviewing "no secret
 * escapes" means reading this file, not auditing every route.
 *
 * Deliberately NOT named NEXT_PUBLIC_*. Next.js inlines anything with that prefix
 * into the client bundle at build time, which would publish the key to every visitor
 * with no error and no warning.
 *
 * The signed URL carries a `conversation_signature` that expires in minutes, so it
 * is safe to hand to a browser: worst case someone re-uses a link that is about to
 * die, rather than an account credential that is not.
 */

const API = 'https://api.elevenlabs.io/v1';

/** Signed URLs are short-lived; no point holding one open longer than a fetch. */
const TIMEOUT_MS = 10_000;

export type ElevenLabsConfig = { agentId: string; apiKey: string };

/**
 * Configuration, or the reason there is none.
 *
 * Returns a reason string rather than throwing because a missing agent id is a
 * legitimate deployment state — the typed fallback still works — and the UI has to
 * say THAT the microphone is unavailable instead of silently offering a dead button.
 * The reason is deliberately vague to the visitor and specific in the server log:
 * which environment variable is missing is our problem, not theirs.
 */
export function elevenLabsConfig(): { config: ElevenLabsConfig } | { reason: string } {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;

  if (!apiKey) {
    console.warn('[voice] ELEVENLABS_API_KEY is not set; the microphone is disabled.');
    return { reason: 'Voice is not switched on for this deployment. You can still type your answers below.' };
  }
  if (!agentId) {
    console.warn('[voice] ELEVENLABS_AGENT_ID is not set; run `npm run voice:agent` to create one.');
    return { reason: 'Voice is not switched on for this deployment. You can still type your answers below.' };
  }
  return { config: { agentId, apiKey } };
}

/**
 * Mint a signed conversation URL for the configured agent.
 *
 * Throws on anything other than a 200 with a signed_url. The caller turns that into
 * `unavailableReason` — there is no offline fallback for the voice hop itself, and
 * pretending otherwise would be the exact "claim it works when only the mock ran"
 * failure this build is meant to avoid.
 */
export async function signedConversationUrl(config: ElevenLabsConfig): Promise<string> {
  const res = await fetch(
    `${API}/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(config.agentId)}`,
    {
      headers: { 'xi-api-key': config.apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    },
  );

  if (!res.ok) {
    // The body can echo request detail, so it is summarised rather than forwarded
    // verbatim to the browser by the caller.
    throw new Error(`ElevenLabs get-signed-url failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  const parsed = (await res.json()) as { signed_url?: string };
  if (!parsed.signed_url) throw new Error('ElevenLabs returned no signed_url.');

  // Belt and braces: if the key ever ended up in the URL we hand to the browser,
  // fail loudly here rather than ship it. This has never fired; it exists so that
  // an upstream change to the response shape cannot quietly leak.
  if (parsed.signed_url.includes(config.apiKey)) {
    throw new Error('Refusing to return a signed URL that contains the API key.');
  }

  return parsed.signed_url;
}

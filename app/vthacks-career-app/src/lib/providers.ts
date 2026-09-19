/**
 * Which sign-in methods are actually usable in this environment.
 *
 * Google is optional: it needs an OAuth client, and the app has to stay fully
 * usable without one (email/password is the baseline). Rather than render a
 * button that throws when pressed, every surface asks here first.
 *
 * Server-only — these read process.env and must not reach the client bundle.
 */
export function isGoogleConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

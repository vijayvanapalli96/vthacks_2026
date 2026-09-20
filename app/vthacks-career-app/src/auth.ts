/**
 * auth.ts — Auth.js v5 configuration.
 *
 * Two providers, because we have two kinds of principal and both sides of the
 * agent-to-agent handshake have to be a real signed-in account:
 *   - Credentials (email + password) for anyone, including employers who are
 *     external to our Databricks workspace
 *   - Google for the one-click path
 *
 * JWT sessions, no database adapter: the user store is a swappable module (see
 * lib/users.ts), not a Prisma/Drizzle schema.
 *
 * There is deliberately NO middleware. Route protection lives in the route-group
 * layouts via lib/session.ts, which keeps every auth call on the Node runtime —
 * bcrypt and the fs-backed store cannot run on the edge.
 */
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';

import { isGoogleConfigured } from '@/lib/providers';
import { createUser, findUserByEmail, verifyPassword } from '@/lib/users';

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Required off-Vercel. Databricks Apps terminates TLS in front of us and we
  // cannot rely on Auth.js inferring the host.
  trustHost: true,
  session: { strategy: 'jwt' },
  pages: { signIn: '/signin' },
  providers: [
    // Registered only when AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are both present.
    // Including it unconfigured makes any Google sign-in attempt throw hard enough
    // to take the dev server down with it.
    ...(isGoogleConfigured() ? [Google] : []),
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(raw) {
        const email = typeof raw?.email === 'string' ? raw.email : '';
        const password = typeof raw?.password === 'string' ? raw.password : '';
        if (!email || !password) return null;

        const user = await findUserByEmail(email);
        if (!user) return null;
        if (!(await verifyPassword(user, password))) return null;

        return { id: user.id, email: user.email, name: user.name ?? null, role: user.role };
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      // A Google user may be brand new. Create the record now with no role:
      // Google cannot tell us which side of the handshake they are on. The role
      // arrives separately at /continue, carried from the landing page.
      if (account?.provider === 'google' && user.email) {
        const existing = await findUserByEmail(user.email);
        if (!existing) {
          await createUser({
            email: user.email,
            name: user.name ?? undefined,
            provider: 'google',
          });
        }
      }
      return true;
    },
    async jwt({ token }) {
      // Re-read the store on every call so a role written at /continue takes
      // effect on the very next request, with no session-refresh dance.
      //
      // It was NOT a cheap lookup — it is a Databricks statement, 0.6-1.1s on a
      // warm warehouse, and it runs on every auth() call, of which a single
      // navigation makes at least two (route-group layout, then the page).
      // findUserByEmail now holds the row for a few seconds and drops it the
      // moment a write touches that user, so this callback keeps its guarantee
      // and stops being the slowest thing on the page. See lib/users.ts.
      if (token.email) {
        const user = await findUserByEmail(token.email);
        token.uid = user?.id;
        token.role = user?.role;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.uid ?? '';
      session.user.role = token.role;
      return session;
    },
  },
});

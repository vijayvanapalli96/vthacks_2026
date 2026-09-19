import type { DefaultSession } from 'next-auth';

import type { Role } from '@/lib/users';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role?: Role;
    } & DefaultSession['user'];
  }

  interface User {
    role?: Role;
  }
}

// NOTE: augment '@auth/core/jwt', NOT 'next-auth/jwt'. The latter is only a
// `export * from '@auth/core/jwt'` re-export, so declaring into it does not reach
// the JWT interface and `token.uid` silently stays `unknown`.
declare module '@auth/core/jwt' {
  interface JWT {
    uid?: string;
    role?: Role;
  }
}

-- workspace.vthacks_2026.users — accounts for both sides of the handshake.
--
-- Auth.js writes here through src/lib/users.ts. Sessions are stateless JWTs, so
-- there is deliberately no sessions table.
--
-- Caveat worth knowing before you debug a duplicate: Unity Catalog PRIMARY KEY /
-- UNIQUE constraints are INFORMATIONAL — Delta does not enforce them. Signup
-- checks for an existing email first, which closes the common case but is not
-- race-proof. Acceptable for the demo; a real deployment wants Postgres here.

CREATE TABLE IF NOT EXISTS workspace.vthacks_2026.users (
  user_id       STRING  NOT NULL COMMENT 'UUID, also the JWT subject',
  email         STRING  NOT NULL COMMENT 'Lowercased, trimmed. Natural key.',
  name          STRING          COMMENT 'Display name, optional',
  password_hash STRING          COMMENT 'bcrypt, 10 rounds. NULL for Google accounts.',
  role          STRING          COMMENT 'applicant | employer. NULL until chosen.',
  provider      STRING  NOT NULL COMMENT 'credentials | google',
  created_at    TIMESTAMP NOT NULL,
  CONSTRAINT users_pk PRIMARY KEY (user_id)
)
USING DELTA
COMMENT 'User accounts for HireWire sign-in (email/password + Google).';

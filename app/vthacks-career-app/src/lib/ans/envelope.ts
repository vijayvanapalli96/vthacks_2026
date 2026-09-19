/**
 * envelope.ts — signs outbound A2A messages with our ANS identity key.
 *
 * The receiving agent (agents/shared/signed-envelope.mjs) accepts a message only
 * if the embedded certificate's fingerprint is one ANS attests for the sender,
 * the ES256 signature verifies, `aud` is the receiver, and `jti` is unused.
 * Keep the two files in step.
 *
 * Key material, per agent (APPLICANT_ / EMPLOYER_ prefix):
 *   *_IDENTITY_KEY / *_IDENTITY_CERT            — PEM text (Databricks secrets)
 *   *_IDENTITY_KEY_FILE / *_IDENTITY_CERT_FILE  — paths, for local development
 */
import { createPrivateKey, randomUUID, sign, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ENVELOPE_TYPE = 'hirewire-a2a+jws';
const MAX_AGE_SECONDS = 120;

type Signer = 'APPLICANT' | 'EMPLOYER';

function material(signer: Signer, kind: 'KEY' | 'CERT'): string {
  const inline = process.env[`${signer}_IDENTITY_${kind}`];
  if (inline) return inline.replace(/\\n/g, '\n');
  const file = process.env[`${signer}_IDENTITY_${kind}_FILE`];
  if (file) return readFileSync(file, 'utf8');
  throw new Error(`The ${signer.toLowerCase()} ANS identity ${kind.toLowerCase()} is not configured, so the message cannot be signed.`);
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export function signEnvelope(input: {
  signer: Signer;
  issuer: string;
  audience: string;
  payload: Record<string, unknown>;
}): string {
  const certificate = new X509Certificate(material(input.signer, 'CERT'));
  const header = { alg: 'ES256', typ: ENVELOPE_TYPE, x5c: [certificate.raw.toString('base64')] };
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    ...input.payload,
    iss: input.issuer,
    aud: input.audience,
    jti: randomUUID(),
    iat,
    exp: iat + MAX_AGE_SECONDS,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(material(input.signer, 'KEY')),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signature)}`;
}

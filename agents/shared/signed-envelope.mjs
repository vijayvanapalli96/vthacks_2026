// Signed A2A envelope: proves which ANS agent sent a message, to whom, and once.
//
// The sender signs a compact JWS (ES256) with its ANS *identity* key and embeds
// the identity certificate. The receiver trusts that certificate only if its
// SHA-256 fingerprint is one the ANS transparency log attests for the claimed
// agent, so no CA chain or pre-shared key is needed. This closes three holes:
//   impersonation  — a name alone no longer works; the attested key must sign
//   replay         — each envelope has a jti that is accepted once, and expires
//   wrong audience — aud must equal the receiver's own ANS name
import { createHash, createPrivateKey, randomUUID, sign, verify, X509Certificate } from "node:crypto";

export const ENVELOPE_TYPE = "hirewire-a2a+jws";
export const MAX_AGE_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 30;

const b64url = (value) => Buffer.from(value).toString("base64url");
const fromB64url = (value) => Buffer.from(value, "base64url");

function split(jws) {
  const parts = typeof jws === "string" ? jws.split(".") : [];
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("The request is not a signed envelope.");
  return parts;
}

// Reads claims WITHOUT verifying them. Only use the result to decide whose ANS
// record to fetch; nothing in it is trusted until verifyEnvelope passes.
export function peekIssuer(jws) {
  const [, payload] = split(jws);
  const iss = JSON.parse(fromB64url(payload).toString("utf8"))?.iss;
  if (typeof iss !== "string" || !iss) throw new Error("The envelope does not name its issuer.");
  return iss;
}

export function signEnvelope({ issuer, audience, payload, privateKeyPem, certificatePem, now = Date.now() }) {
  const certificate = new X509Certificate(certificatePem);
  const header = { alg: "ES256", typ: ENVELOPE_TYPE, x5c: [certificate.raw.toString("base64")] };
  const iat = Math.floor(now / 1000);
  const claims = { ...payload, iss: issuer, aud: audience, jti: randomUUID(), iat, exp: iat + MAX_AGE_SECONDS };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${b64url(signature)}`;
}

// In-memory: a restart forgets seen ids, but every envelope expires within
// MAX_AGE_SECONDS, so the replay window after a restart is bounded by that.
export function createReplayGuard() {
  const seen = new Map();
  return {
    claim(jti, exp) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      for (const [id, expiry] of seen) if (expiry + CLOCK_SKEW_SECONDS < nowSeconds) seen.delete(id);
      if (seen.has(jti)) return false;
      seen.set(jti, exp);
      return true;
    },
  };
}

export function normalizeFingerprint(value) {
  return String(value ?? "").replace(/^sha256:/i, "").replace(/:/g, "").toLowerCase();
}

export function verifyEnvelope(jws, { expectedIssuer, audience, attestedFingerprints, replayGuard, now = Date.now() }) {
  const [headerPart, payloadPart, signaturePart] = split(jws);
  const header = JSON.parse(fromB64url(headerPart).toString("utf8"));
  if (header?.alg !== "ES256" || header?.typ !== ENVELOPE_TYPE || !Array.isArray(header?.x5c) || !header.x5c[0]) {
    throw new Error("The envelope header is not a supported signed format.");
  }

  const certificate = new X509Certificate(Buffer.from(header.x5c[0], "base64"));
  const fingerprint = createHash("sha256").update(certificate.raw).digest("hex");
  const attested = (attestedFingerprints ?? []).map(normalizeFingerprint);
  if (!attested.includes(fingerprint)) {
    throw new Error("The signing certificate is not one ANS attests for this agent.");
  }
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) < now) {
    throw new Error("The signing certificate is not currently valid.");
  }
  const sans = (certificate.subjectAltName ?? "").split(/,\s*/);
  if (!sans.includes(`URI:${expectedIssuer}`)) {
    throw new Error("The signing certificate is not bound to the claimed agent.");
  }

  const signatureValid = verify(
    "sha256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    { key: certificate.publicKey, dsaEncoding: "ieee-p1363" },
    fromB64url(signaturePart),
  );
  if (!signatureValid) throw new Error("The envelope signature is invalid.");

  const claims = JSON.parse(fromB64url(payloadPart).toString("utf8"));
  if (claims.iss !== expectedIssuer) throw new Error("The envelope issuer does not match the claimed agent.");
  if (claims.aud !== audience) throw new Error("The envelope is addressed to a different agent.");

  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) throw new Error("The envelope has no validity window.");
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new Error("The envelope is dated in the future.");
  if (claims.exp < nowSeconds - CLOCK_SKEW_SECONDS) throw new Error("The envelope has expired.");
  if (claims.exp - claims.iat > MAX_AGE_SECONDS) throw new Error("The envelope validity window is too long.");
  if (typeof claims.jti !== "string" || !claims.jti) throw new Error("The envelope has no unique id.");
  if (!replayGuard.claim(claims.jti, claims.exp)) throw new Error("The envelope was already used.");

  return claims;
}

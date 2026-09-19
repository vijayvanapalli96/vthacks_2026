import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createReplayGuard, peekIssuer, signEnvelope, verifyEnvelope } from "../shared/signed-envelope.mjs";

const APPLICANT = "ans://v1.0.0.applicant.example.com";
const EMPLOYER = "ans://v1.0.0.employer.example.com";

// Throwaway P-256 identity certs, shaped like ANS ones (SAN carries the ANS URI).
const dir = mkdtempSync(join(tmpdir(), "envelope-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function identity(label, name, host) {
  const key = join(dir, `${label}.key`);
  const cert = join(dir, `${label}.pem`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${host}`,
    "-addext", `subjectAltName=DNS:${host},URI:${name}`,
  ], { stdio: "ignore" });
  const certificatePem = readFileSync(cert, "utf8");
  const fingerprint = `SHA256:${createHash("sha256").update(new X509Certificate(certificatePem).raw).digest("hex")}`;
  return { privateKeyPem: readFileSync(key, "utf8"), certificatePem, fingerprint };
}

const applicant = identity("applicant", APPLICANT, "applicant.example.com");
const impostor = identity("impostor", APPLICANT, "applicant.example.com");

function envelope(overrides = {}) {
  return signEnvelope({
    issuer: APPLICANT,
    audience: EMPLOYER,
    payload: { candidate: { full_name: "Ada" } },
    privateKeyPem: applicant.privateKeyPem,
    certificatePem: applicant.certificatePem,
    ...overrides,
  });
}

function check(jws, overrides = {}) {
  return verifyEnvelope(jws, {
    expectedIssuer: peekIssuer(jws),
    audience: EMPLOYER,
    attestedFingerprints: [applicant.fingerprint],
    replayGuard: createReplayGuard(),
    ...overrides,
  });
}

test("accepts an envelope signed by the attested identity key and addressed to us", () => {
  const claims = check(envelope());
  assert.equal(claims.iss, APPLICANT);
  assert.equal(claims.candidate.full_name, "Ada");
});

test("impersonation: a different key claiming the same ANS name is refused", () => {
  const forged = envelope({ privateKeyPem: impostor.privateKeyPem, certificatePem: impostor.certificatePem });
  assert.throws(() => check(forged), /not one ANS attests/);
});

test("replay: the same envelope is accepted once", () => {
  const jws = envelope();
  const replayGuard = createReplayGuard();
  check(jws, { replayGuard });
  assert.throws(() => check(jws, { replayGuard }), /already used/);
});

test("wrong audience: an envelope addressed to another employer is refused", () => {
  const elsewhere = envelope({ audience: "ans://v1.0.0.employer.other.example" });
  assert.throws(() => check(elsewhere), /addressed to a different agent/);
});

test("tampering: changing the payload after signing breaks the signature", () => {
  const [header, , signature] = envelope().split(".");
  const payload = Buffer.from(JSON.stringify({
    iss: APPLICANT, aud: EMPLOYER, jti: "x", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60,
    candidate: { full_name: "Mallory" },
  })).toString("base64url");
  assert.throws(() => check(`${header}.${payload}.${signature}`), /signature is invalid/);
});

test("expiry: an old envelope is refused", () => {
  const stale = envelope({ now: Date.now() - 10 * 60_000 });
  assert.throws(() => check(stale), /expired/);
});

test("binding: the attested key cannot speak for a different ANS name", () => {
  const otherName = envelope({ issuer: "ans://v1.0.0.applicant.other.example" });
  assert.throws(() => check(otherName), /not bound to the claimed agent/);
});

test("an unsigned body is not an envelope", () => {
  assert.throws(() => peekIssuer("not-a-jws"), /not a signed envelope/);
});

/**
 * The live attack console's engine (F7.10).
 *
 * Fires the threat battery at OUR OWN employer agent and reports what it did.
 * Webmesh's fraud agent cannot be pointed at us — its battery only targets its
 * own payment supplier — so the honest demonstration is to attack ourselves and
 * show the refusals, rather than claim we withstood someone else's attack.
 *
 * Every probe is written to the audit log as kind 'attack', so the console's
 * numbers and the audit trail are the same evidence rather than two stories.
 */
import { NextResponse } from 'next/server';

import { auth } from '../../../auth';
import { recordAudit } from '../../../lib/audit';
import { signEnvelope } from '../../../lib/ans/envelope';
import { APPLICANT_ANS_NAME, EMPLOYER_ANS_NAME } from '../../../lib/ans/production';
import { PROBES, summarize, type Probe, type ProbeResult } from '../../../lib/ans/attack-probes';

export const dynamic = 'force-dynamic';

const TARGET = process.env.EMPLOYER_ENDPOINT_URL ?? 'https://employer.hirewire.biz/a2a/apply';
const OTHER_EMPLOYER = 'ans://v1.0.0.employer.example.com';
const TEN_MINUTES = 10 * 60 * 1000;

// No candidate data: a probe is a security test, not an application. Anything
// real here would put PII on an endpoint we are deliberately trying to break.
const payload = { candidate: { full_name: 'Security probe' }, job: { job_id: 'security-probe' } };

async function post(body: unknown): Promise<{ status: number; reason: string }> {
  try {
    const response = await fetch(TARGET, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json().catch(() => ({}))) as { reason?: string; status?: string };
    return { status: response.status, reason: json.reason ?? json.status ?? '' };
  } catch (error) {
    return { status: 0, reason: error instanceof Error ? error.message : 'unreachable' };
  }
}

function envelope(signer: 'APPLICANT' | 'EMPLOYER', over: Partial<Parameters<typeof signEnvelope>[0]> = {}) {
  return signEnvelope({
    signer,
    issuer: APPLICANT_ANS_NAME,
    audience: EMPLOYER_ANS_NAME,
    payload,
    ...over,
  });
}

async function run(probe: Probe): Promise<{ status: number; reason: string }> {
  switch (probe.id) {
    case 'control':
      return post({ jws: envelope('APPLICANT') });
    case 'unsigned':
      return post(payload);
    case 'claimed-name':
      return post({ applicant_agent: APPLICANT_ANS_NAME, ...payload });
    case 'wrong-key':
      // Signed with the employer's key while still claiming to be the applicant.
      return post({ jws: envelope('EMPLOYER') });
    case 'role-swap':
      return post({ jws: envelope('EMPLOYER', { issuer: EMPLOYER_ANS_NAME }) });
    case 'unregistered':
      return post({ jws: envelope('APPLICANT', { issuer: 'ans://v1.0.0.applicant.fraud.webmesh.ai' }) });
    case 'lookalike':
      return post({ jws: envelope('APPLICANT', { issuer: 'ans://v1.0.13.agent.webmesh.ai' }) });
    case 'replay': {
      const jws = envelope('APPLICANT');
      await post({ jws });
      return post({ jws });
    }
    case 'wrong-audience':
      return post({ jws: envelope('APPLICANT', { audience: OTHER_EMPLOYER }) });
    case 'tampered': {
      const [header, , signature] = envelope('APPLICANT').split('.');
      const rewritten = Buffer.from(
        JSON.stringify({ ...payload, candidate: { full_name: 'Rewritten in flight' } }),
      ).toString('base64url');
      return post({ jws: `${header}.${rewritten}.${signature}` });
    }
    case 'stale':
      return post({ jws: envelope('APPLICANT', { now: Date.now() - TEN_MINUTES }) });
    case 'future':
      return post({ jws: envelope('APPLICANT', { now: Date.now() + TEN_MINUTES }) });
    default:
      return { status: 0, reason: `Unknown probe ${probe.id}.` };
  }
}

export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });

  let results: ProbeResult[];
  try {
    // Sequential: the replay probe depends on its own first request having
    // landed, and a parallel burst at our own agent proves nothing useful.
    results = [];
    for (const probe of PROBES) {
      const outcome = await run(probe);
      const accepted = outcome.status >= 200 && outcome.status < 300;
      results.push({
        ...probe,
        ...outcome,
        correct: probe.expect === 'accept' ? accepted : !accepted,
      });
    }
  } catch (error) {
    // Most likely the identity key is not configured, which is a real answer:
    // without it we cannot sign, so we cannot honestly run the battery at all.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'The attack battery could not run.' },
      { status: 500 },
    );
  }

  const summary = summarize(results);

  await Promise.all(
    results.map((result) =>
      recordAudit({
        kind: 'attack',
        direction: 'applicant_to_employer',
        verifier: APPLICANT_ANS_NAME,
        subject: EMPLOYER_ANS_NAME,
        subject_registered: true,
        verdict: result.correct ? 'pass' : 'refuse',
        outcome: result.expect === 'accept' && result.correct ? 'accepted' : 'blocked',
        spoken_reason: result.reason || `HTTP ${result.status}`,
        fields_released: [],
        attack: { id: result.id, label: result.label },
        user_id: session.user.id ?? null,
      }),
    ),
  );

  return NextResponse.json({ target: TARGET, results, summary, ran_at: new Date().toISOString() });
}

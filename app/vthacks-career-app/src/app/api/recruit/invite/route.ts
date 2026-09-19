import { NextResponse } from 'next/server';
import { auth } from '../../../../auth';
import { envelopeClaims, recordAudit } from '../../../../lib/audit';
import { signEnvelope } from '../../../../lib/ans/envelope';
import { EMPLOYER_ANS_NAME, verifyProductionAgent } from '../../../../lib/ans/production';
import { failedTrustDimensions } from '../../../../lib/ans/policy';
import { recordAgentVerificationSafely } from '../../../../lib/ans/store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (session.user.role !== 'employer') return NextResponse.json({ error: 'Employer role required.' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as {
    applicant_ans_name?: string;
    job_id?: string;
    message?: string;
  };
  if (!body.applicant_ans_name || !body.job_id || !body.message) {
    return NextResponse.json({ error: 'applicant_ans_name, job_id, and message are required.' }, { status: 400 });
  }

  const verification = await verifyProductionAgent({
    ansName: body.applicant_ans_name,
    expectedRole: 'applicant',
  }).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : 'ANS verification failed.';
    return {
      verdict: 'refuse' as const,
      spoken_reason: `Invitation blocked. ${reason}`,
      dimensions: failedTrustDimensions(reason),
      checked_at: new Date().toISOString(),
      registry: null,
      evidence: null,
    };
  });
  const subject = verification.registry?.ans_name ?? body.applicant_ans_name.slice(0, 255);
  const auditBase = {
    kind: 'invitation' as const,
    direction: 'employer_to_applicant' as const,
    verifier: EMPLOYER_ANS_NAME,
    subject,
    subject_registered: Boolean(verification.registry),
    dimensions: verification.dimensions,
    fields_released: [],
    user_id: session.user.id ?? null,
    job_id: body.job_id,
  };
  const persisted = await recordAgentVerificationSafely({
    verifierAnsName: EMPLOYER_ANS_NAME,
    subjectAnsName: subject,
    subjectRole: 'applicant',
    purpose: 'recruiting_invitation',
    verdict: verification.verdict,
    dimensions: verification.dimensions,
    fieldsReleased: [],
  });
  if (verification.verdict !== 'pass' || !verification.evidence) {
    const auditId = await recordAudit({ ...auditBase, verdict: 'refuse', outcome: 'refused', spoken_reason: verification.spoken_reason });
    return NextResponse.json({ status: 'refused', verification, persisted, audit_id: auditId }, { status: 403 });
  }

  let jws: string;
  try {
    jws = signEnvelope({
      signer: 'EMPLOYER',
      issuer: EMPLOYER_ANS_NAME,
      audience: verification.evidence.agentCard.name,
      payload: { job_id: body.job_id, message: body.message.trim().slice(0, 2000) },
    });
  } catch (error) {
    console.error('Could not sign the invitation envelope', error);
    const spokenReason = 'Invitation not sent. This agent cannot sign messages with its ANS identity right now.';
    const auditId = await recordAudit({ ...auditBase, verdict: 'refuse', outcome: 'refused', spoken_reason: spokenReason });
    return NextResponse.json({ status: 'not_sent', error: spokenReason, audit_id: auditId }, { status: 500 });
  }
  let response: Response | null = null;
  let payload: { status?: string; receipt_id?: string } = {};
  try {
    response = await fetch(verification.evidence.agentCard.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jws }),
      signal: AbortSignal.timeout(8000),
    });
    payload = await response.json().catch(() => ({}));
  } catch (error) {
    console.error('Could not reach the applicant agent', error);
  }
  const delivered = Boolean(response?.ok);
  const auditId = await recordAudit({
    ...auditBase,
    verdict: 'pass',
    outcome: delivered ? 'invitation_sent' : 'delivery_failed',
    spoken_reason: delivered
      ? `Invitation delivered to verified applicant ${subject}.`
      : `The verified applicant agent did not accept the invitation (${response ? `HTTP ${response.status}` : 'unreachable'}).`,
    envelope: envelopeClaims(jws),
    counterparty_response: { http_status: response?.status ?? 0, status: payload.status, receipt_id: payload.receipt_id },
  });
  return NextResponse.json({
    status: delivered ? 'invitation_sent' : 'delivery_failed',
    applicant_ans_name: subject,
    verification: {
      verdict: verification.verdict,
      dimensions: verification.dimensions,
      spoken_reason: verification.spoken_reason,
    },
    persisted,
    audit_id: auditId,
    receipt: payload,
  }, { status: delivered ? 202 : 502 });
}

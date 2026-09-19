import { NextResponse } from 'next/server';
import { auth } from '../../../../auth';
import { signEnvelope } from '../../../../lib/ans/envelope';
import { EMPLOYER_ANS_NAME, verifyProductionAgent } from '../../../../lib/ans/production';
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
  });
  const persisted = await recordAgentVerificationSafely({
    verifierAnsName: EMPLOYER_ANS_NAME,
    subjectAnsName: verification.registry.ans_name,
    subjectRole: 'applicant',
    purpose: 'recruiting_invitation',
    verdict: verification.verdict,
    dimensions: verification.dimensions,
    fieldsReleased: [],
  });
  if (verification.verdict !== 'pass') {
    return NextResponse.json({ status: 'refused', verification, persisted }, { status: 403 });
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
    return NextResponse.json({ status: 'not_sent', error: 'This agent cannot sign messages with its ANS identity right now.' }, { status: 500 });
  }
  const response = await fetch(verification.evidence.agentCard.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jws }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => ({}));
  return NextResponse.json({
    status: response.ok ? 'invitation_sent' : 'delivery_failed',
    applicant_ans_name: verification.registry.ans_name,
    verification: {
      verdict: verification.verdict,
      dimensions: verification.dimensions,
      spoken_reason: verification.spoken_reason,
    },
    persisted,
    receipt: payload,
  }, { status: response.ok ? 202 : 502 });
}

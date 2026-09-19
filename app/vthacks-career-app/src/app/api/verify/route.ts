import { NextResponse } from 'next/server';
import { auth } from '../../../auth';
import { recordAudit } from '../../../lib/audit';
import { APPLICANT_ANS_NAME, EMPLOYER_ANS_NAME, verifyProductionAgent } from '../../../lib/ans/production';
import { failedTrustDimensions } from '../../../lib/ans/policy';
import { recordAgentVerificationSafely } from '../../../lib/ans/store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    agent_id?: string;
    ans_name?: string;
    host?: string;
    expected_role?: 'employer' | 'applicant';
    application_id?: string;
    purpose?: 'job_application' | 'recruiting_invitation';
  };
  const session = await auth().catch(() => null);
  const expectedRole = body.expected_role ?? 'employer';
  const verifierAnsName = expectedRole === 'employer' ? APPLICANT_ANS_NAME : EMPLOYER_ANS_NAME;
  const purpose = body.purpose ?? (expectedRole === 'employer' ? 'job_application' : 'recruiting_invitation');
  const auditBase = {
    kind: 'verify' as const,
    direction: expectedRole === 'employer' ? 'applicant_to_employer' as const : 'employer_to_applicant' as const,
    verifier: verifierAnsName,
    fields_released: [],
    user_id: session?.user?.id ?? null,
  };
  try {
    const result = await verifyProductionAgent({
      agentId: body.agent_id,
      ansName: body.ans_name,
      host: body.host,
      expectedRole,
    });
    const [persisted, auditId] = await Promise.all([
      recordAgentVerificationSafely({
        applicationId: body.application_id,
        verifierAnsName,
        subjectAnsName: result.registry.ans_name,
        subjectRole: expectedRole,
        purpose,
        verdict: result.verdict,
        dimensions: result.dimensions,
        fieldsReleased: [],
      }),
      recordAudit({
        ...auditBase,
        subject: result.registry.ans_name,
        subject_registered: true,
        verdict: result.verdict,
        outcome: result.verdict === 'pass' ? 'verified' : 'refused',
        spoken_reason: result.spoken_reason,
        dimensions: result.dimensions,
      }),
    ]);
    return NextResponse.json({
      verdict: result.verdict,
      dimensions: result.dimensions,
      spoken_reason: result.spoken_reason,
      checked_at: result.checked_at,
      registry: result.registry,
      persisted,
      audit_id: auditId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown ANS verification failure.';
    const dimensions = failedTrustDimensions(reason);
    const spokenReason = `Application blocked. ${reason}`;
    // No registry record to name, so record the identity it was claimed under.
    const subject = (body.ans_name ?? body.host ?? body.agent_id ?? 'unidentified').slice(0, 255);
    const [persisted, auditId] = await Promise.all([
      recordAgentVerificationSafely({
        applicationId: body.application_id,
        verifierAnsName,
        subjectAnsName: subject,
        subjectRole: expectedRole,
        purpose,
        verdict: 'refuse',
        dimensions,
        fieldsReleased: [],
      }),
      recordAudit({
        ...auditBase,
        subject,
        subject_registered: false,
        verdict: 'refuse',
        outcome: 'refused',
        spoken_reason: spokenReason,
        dimensions,
      }),
    ]);
    return NextResponse.json({
      verdict: 'refuse',
      dimensions,
      spoken_reason: spokenReason,
      checked_at: new Date().toISOString(),
      persisted,
      audit_id: auditId,
    }, { status: 502 });
  }
}

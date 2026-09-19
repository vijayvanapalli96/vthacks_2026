import { NextResponse } from 'next/server';
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
  const expectedRole = body.expected_role ?? 'employer';
  const verifierAnsName = expectedRole === 'employer' ? APPLICANT_ANS_NAME : EMPLOYER_ANS_NAME;
  const purpose = body.purpose ?? (expectedRole === 'employer' ? 'job_application' : 'recruiting_invitation');
  try {
    const result = await verifyProductionAgent({
      agentId: body.agent_id,
      ansName: body.ans_name,
      host: body.host,
      expectedRole,
    });
    const persisted = await recordAgentVerificationSafely({
      applicationId: body.application_id,
      verifierAnsName,
      subjectAnsName: result.registry.ans_name,
      subjectRole: expectedRole,
      purpose,
      verdict: result.verdict,
      dimensions: result.dimensions,
      fieldsReleased: [],
    });
    return NextResponse.json({
      verdict: result.verdict,
      dimensions: result.dimensions,
      spoken_reason: result.spoken_reason,
      checked_at: result.checked_at,
      registry: result.registry,
      persisted,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown ANS verification failure.';
    const dimensions = failedTrustDimensions(reason);
    // No registry record to name, so record the identity it was claimed under.
    const persisted = await recordAgentVerificationSafely({
      applicationId: body.application_id,
      verifierAnsName,
      subjectAnsName: (body.ans_name ?? body.host ?? body.agent_id ?? 'unidentified').slice(0, 255),
      subjectRole: expectedRole,
      purpose,
      verdict: 'refuse',
      dimensions,
      fieldsReleased: [],
    });
    return NextResponse.json({
      verdict: 'refuse',
      dimensions,
      spoken_reason: `Application blocked. ${reason}`,
      checked_at: new Date().toISOString(),
      persisted,
    }, { status: 502 });
  }
}

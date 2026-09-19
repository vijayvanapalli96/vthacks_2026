import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { signEnvelope } from '../../../lib/ans/envelope';
import { APPLICANT_ANS_NAME, verifyProductionAgent } from '../../../lib/ans/production';
import { failedTrustDimensions } from '../../../lib/ans/policy';
import { explainMutualMatch } from '../../../lib/ans/match';
import { recordAgentVerificationSafely, recordMatchExplanationSafely } from '../../../lib/ans/store';

export const dynamic = 'force-dynamic';

const allowedFields = new Set(['full_name', 'email', 'resume_url', 'cover_letter', 'skills']);

type ApplyBody = {
  agent_id?: string;
  employer_ans_name?: string;
  employer_host?: string;
  application_id?: string;
  human_approved?: boolean;
  candidate?: Record<string, unknown>;
  requested_fields?: string[];
  job?: {
    job_id?: string;
    title?: string;
    company?: string;
    required_skills?: string[];
    preferred_skills?: string[];
  };
};

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as ApplyBody;
  const verification = await verifyProductionAgent({
    agentId: body.agent_id,
    ansName: body.employer_ans_name,
    host: body.employer_host,
    expectedRole: 'employer',
  }).catch((error: unknown) => ({
    verdict: 'refuse' as const,
    spoken_reason: `Application blocked. ${error instanceof Error ? error.message : 'ANS verification failed.'}`,
    dimensions: failedTrustDimensions(error instanceof Error ? error.message : 'ANS verification failed.'),
    checked_at: new Date().toISOString(),
    registry: null,
    evidence: null,
  }));
  const requested = Array.isArray(body.requested_fields) ? body.requested_fields : [];
  const releasable = requested.filter((field) => allowedFields.has(field));
  const matchExplanation = explainMutualMatch({
    candidateSkills: body.candidate?.skills,
    requiredSkills: body.job?.required_skills,
    preferredSkills: body.job?.preferred_skills,
  });

  if (verification.verdict !== 'pass' || body.human_approved !== true || !verification.evidence) {
    const spokenReason = verification.verdict !== 'pass'
      ? verification.spoken_reason
      : 'Application blocked until the candidate approves the exact fields to release.';
    const persisted = verification.registry ? await recordAgentVerificationSafely({
      applicationId: body.application_id,
      verifierAnsName: APPLICANT_ANS_NAME,
      subjectAnsName: verification.registry.ans_name,
      subjectRole: 'employer',
      purpose: 'job_application',
      verdict: verification.verdict,
      dimensions: verification.dimensions,
      fieldsReleased: [],
    }) : false;
    return NextResponse.json({
      status: 'refused',
      fields_released: [],
      audit_id: randomUUID(),
      spoken_reason: spokenReason,
      persisted,
      verification: {
        verdict: verification.verdict,
        dimensions: verification.dimensions,
        checked_at: verification.checked_at,
      },
    });
  }

  const candidate = body.candidate ?? {};
  const packet = Object.fromEntries(releasable.map((field) => [field, candidate[field]]));
  // Signed with our ANS identity key and addressed to this employer only, so the
  // employer can prove who sent it and reject a replay or a redirected copy.
  let jws: string;
  try {
    jws = signEnvelope({
      signer: 'APPLICANT',
      issuer: APPLICANT_ANS_NAME,
      audience: verification.evidence.agentCard.name,
      payload: {
        candidate: packet,
        job: body.job ?? null,
        match_explanation: matchExplanation,
        verification: {
          verdict: verification.verdict,
          dimensions: verification.dimensions,
          checked_at: verification.checked_at,
        },
      },
    });
  } catch (error) {
    console.error('Could not sign the application envelope', error);
    return NextResponse.json({
      status: 'refused',
      fields_released: [],
      audit_id: randomUUID(),
      spoken_reason: 'Application not sent. This agent cannot sign messages with its ANS identity right now.',
    }, { status: 500 });
  }
  const response = await fetch(verification.evidence.agentCard.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jws }),
    signal: AbortSignal.timeout(8000),
  });

  const matchPersisted = body.job?.job_id ? await recordMatchExplanationSafely({
    applicationId: body.application_id,
    jobId: body.job.job_id,
    direction: 'applicant_to_employer',
    explanation: matchExplanation,
  }) : false;

  const persisted = await recordAgentVerificationSafely({
    applicationId: body.application_id,
    verifierAnsName: APPLICANT_ANS_NAME,
    subjectAnsName: verification.registry.ans_name,
    subjectRole: 'employer',
    purpose: 'job_application',
    verdict: verification.verdict,
    dimensions: verification.dimensions,
    fieldsReleased: releasable,
  });

  if (!response.ok) {
    return NextResponse.json({
      status: 'delivery_failed',
      fields_released: releasable,
      audit_id: randomUUID(),
      spoken_reason: `The verified employer endpoint received the approved fields but returned HTTP ${response.status}.`,
      persisted,
      match_persisted: matchPersisted,
      match_explanation: matchExplanation,
    }, { status: 502 });
  }

  return NextResponse.json({
    status: 'submitted',
    fields_released: releasable,
    audit_id: randomUUID(),
    spoken_reason: `Application submitted to verified employer ${verification.evidence.agentCard.name}.`,
    persisted,
    match_persisted: matchPersisted,
    match_explanation: matchExplanation,
  });
}

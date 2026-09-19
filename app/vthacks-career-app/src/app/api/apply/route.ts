import { NextResponse } from 'next/server';
import { auth } from '../../../auth';
import { envelopeClaims, recordAudit } from '../../../lib/audit';
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

function claimedIdentity(body: ApplyBody): string {
  return (body.employer_ans_name ?? body.employer_host ?? body.agent_id ?? 'unidentified').slice(0, 255);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as ApplyBody;
  const session = await auth().catch(() => null);
  const userId = session?.user?.id ?? null;
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
  const subject = verification.registry?.ans_name ?? claimedIdentity(body);
  const auditBase = {
    kind: 'apply' as const,
    direction: 'applicant_to_employer' as const,
    verifier: APPLICANT_ANS_NAME,
    subject,
    subject_registered: Boolean(verification.registry),
    dimensions: verification.dimensions,
    fields_requested: releasable,
    human_approved: body.human_approved === true,
    user_id: userId,
    job_id: body.job?.job_id ?? null,
  };
  // The explanation names the candidate's matched skills, so it only exists when
  // the candidate approved releasing `skills`. Otherwise it would leak them.
  const matchExplanation = releasable.includes('skills')
    ? explainMutualMatch({
        candidateSkills: body.candidate?.skills,
        requiredSkills: body.job?.required_skills,
        preferredSkills: body.job?.preferred_skills,
      })
    : null;

  if (verification.verdict !== 'pass' || body.human_approved !== true || !verification.evidence) {
    const spokenReason = verification.verdict !== 'pass'
      ? verification.spoken_reason
      : 'Application blocked until the candidate approves the exact fields to release.';
    // Every refusal is recorded, including an "employer" with no ANS registration
    // at all: then the subject is whatever identity it was claimed under.
    const [persisted, auditId] = await Promise.all([
      recordAgentVerificationSafely({
        applicationId: body.application_id,
        verifierAnsName: APPLICANT_ANS_NAME,
        subjectAnsName: subject,
        subjectRole: 'employer',
        purpose: 'job_application',
        verdict: verification.verdict,
        dimensions: verification.dimensions,
        fieldsReleased: [],
      }),
      recordAudit({ ...auditBase, verdict: 'refuse', outcome: 'refused', spoken_reason: spokenReason, fields_released: [] }),
    ]);
    return NextResponse.json({
      status: 'refused',
      fields_released: [],
      audit_id: auditId,
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
    const spokenReason = 'Application not sent. This agent cannot sign messages with its ANS identity right now.';
    const auditId = await recordAudit({
      ...auditBase,
      verdict: 'refuse',
      outcome: 'refused',
      spoken_reason: spokenReason,
      fields_released: [],
    });
    return NextResponse.json({ status: 'refused', fields_released: [], audit_id: auditId, spoken_reason: spokenReason }, { status: 500 });
  }

  let response: Response | null = null;
  let receipt: { status?: string; receipt_id?: string } = {};
  try {
    response = await fetch(verification.evidence.agentCard.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jws }),
      signal: AbortSignal.timeout(8000),
    });
    receipt = await response.json().catch(() => ({}));
  } catch (error) {
    console.error('Could not reach the employer agent', error);
  }
  const delivered = Boolean(response?.ok);
  const spokenReason = delivered
    ? `Application submitted to verified employer ${verification.evidence.agentCard.name}.`
    : `The verified employer agent did not accept the application (${response ? `HTTP ${response.status}` : 'unreachable'}).`;

  const [matchPersisted, persisted, auditId] = await Promise.all([
    body.job?.job_id && matchExplanation
      ? recordMatchExplanationSafely({
          applicationId: body.application_id,
          jobId: body.job.job_id,
          direction: 'applicant_to_employer',
          explanation: matchExplanation,
        })
      : Promise.resolve(false),
    recordAgentVerificationSafely({
      applicationId: body.application_id,
      verifierAnsName: APPLICANT_ANS_NAME,
      subjectAnsName: verification.registry.ans_name,
      subjectRole: 'employer',
      purpose: 'job_application',
      verdict: verification.verdict,
      dimensions: verification.dimensions,
      fieldsReleased: releasable,
    }),
    recordAudit({
      ...auditBase,
      verdict: 'pass',
      outcome: delivered ? 'submitted' : 'delivery_failed',
      spoken_reason: spokenReason,
      fields_released: releasable,
      envelope: envelopeClaims(jws),
      counterparty_response: {
        http_status: response?.status ?? 0,
        status: receipt.status,
        receipt_id: receipt.receipt_id,
      },
    }),
  ]);

  return NextResponse.json({
    status: delivered ? 'submitted' : 'delivery_failed',
    fields_released: releasable,
    audit_id: auditId,
    spoken_reason: spokenReason,
    persisted,
    match_persisted: matchPersisted,
    match_explanation: matchExplanation,
    employer_receipt_id: receipt.receipt_id ?? null,
  }, { status: delivered ? 200 : 502 });
}

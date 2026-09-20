/**
 * apply-exchange.ts — the agent-to-agent application, as one function.
 *
 * WHY THIS IS NOT IN THE ROUTE ANY MORE. There are now two ways to start the
 * same exchange: POST /api/apply, which answers once with the result, and POST
 * /api/apply/stream, which pushes each turn to the browser as it happens so the
 * student can watch the two agents talk. Those must not be two implementations
 * of the gate. Hard rule 3 — ANS resolve, certificate check, Trust Index, policy
 * gate, human confirm, THEN fields — is enforced here, once, and both routes are
 * thin wrappers over it. The logic below is the route's, moved unchanged; the
 * only addition is `recorder.turn(...)`, which observes and decides nothing.
 *
 * The transcript is written after the exchange finishes, and Gemini narrates the
 * applicant agent's own turns at that point (see narrate.ts). Both are
 * best-effort: neither can fail, delay past its timeout, or alter an application.
 */
import { envelopeClaims, recordAudit } from '../audit';
import { signEnvelope } from '../ans/envelope';
import { APPLICANT_ANS_NAME, verifyProductionAgent } from '../ans/production';
import { failedTrustDimensions, type TrustDimension } from '../ans/policy';
import { explainMutualMatch } from '../ans/match';
import { recordAgentVerificationSafely, recordMatchExplanationSafely } from '../ans/store';
import { getJob } from '../jobs';

import { narrateAsApplicantAgent } from './narrate';
import { createRecorder, saveTranscript, type Turn } from './transcript';

const allowedFields = new Set(['full_name', 'email', 'resume_url', 'cover_letter', 'skills']);

export type ApplyBody = {
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

export type ApplyResult = { httpStatus: number; body: Record<string, unknown> };

function claimedIdentity(body: ApplyBody): string {
  return (body.employer_ans_name ?? body.employer_host ?? body.agent_id ?? 'unidentified').slice(0, 255);
}

export async function runApplyExchange(
  body: ApplyBody,
  userId: string | null,
  /** Called the moment a turn happens. Only the streaming route passes one. */
  emit?: (turn: Turn) => void,
): Promise<ApplyResult> {
  const startedAt = new Date();
  const recorder = createRecorder(emit);

  if (!body.job?.job_id) return { httpStatus: 400, body: { error: 'job.job_id is required.' } };
  const canonicalJob = await getJob(body.job.job_id);
  if (!canonicalJob) return { httpStatus: 404, body: { error: 'The selected job could not be found.' } };
  const job = {
    job_id: canonicalJob.job_id,
    title: canonicalJob.job_title,
    company: canonicalJob.company_name,
    required_skills: canonicalJob.demo ? ['Python', 'SQL'] : undefined,
    preferred_skills: canonicalJob.demo ? ['TypeScript'] : undefined,
  };

  // Registered before the first turn, so a candidate value can never be written
  // into the transcript even by a later edit to one of the lines below.
  recorder.guard(Object.values(body.candidate ?? {}));

  const verification = await verifyProductionAgent({
    agentId: body.agent_id,
    ansName: body.employer_ans_name,
    host: body.employer_host,
    expectedRole: 'employer',
    onStep: recorder.turn,
  }).catch((error: unknown) => ({
    verdict: 'refuse' as const,
    spoken_reason: `Application blocked. ${error instanceof Error ? error.message : 'ANS verification failed.'}`,
    dimensions: failedTrustDimensions(error instanceof Error ? error.message : 'ANS verification failed.'),
    checked_at: new Date().toISOString(),
    registry: null,
    evidence: null,
  }));

  const average = Math.round(
    verification.dimensions.reduce((sum, dimension) => sum + dimension.score, 0) /
      Math.max(verification.dimensions.length, 1),
  );
  // The gate itself is a turn. It is the applicant agent talking to itself, and
  // leaving it out would jump from "here is their card" to "packet sent" with
  // the actual decision off-screen.
  recorder.turn({
    from: 'applicant_agent',
    to: 'applicant_agent',
    label: verification.verdict === 'pass' ? 'Trust Index passed' : 'Trust Index refused',
    detail: verification.spoken_reason,
    data: {
      average_score: average,
      dimensions: verification.dimensions.map((dimension) => ({
        name: dimension.name,
        score: dimension.score,
        reason: dimension.reason,
      })),
    },
    outcome: verification.verdict === 'pass' ? 'ok' : 'refused',
  });

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
    job_id: job.job_id,
  };
  // The explanation names the candidate's matched skills, so it only exists when
  // the candidate approved releasing `skills`. Otherwise it would leak them.
  const matchExplanation = releasable.includes('skills')
    ? explainMutualMatch({
        candidateSkills: body.candidate?.skills,
        requiredSkills: job.required_skills,
        preferredSkills: job.preferred_skills,
      })
    : null;

  /** Narrate, save, and hand back what the caller adds to its response. */
  async function close(outcome: 'submitted' | 'refused' | 'delivery_failed', auditId: string | null) {
    const { turns, narrator } = await narrateAsApplicantAgent(recorder.turns());
    const transcriptId = await saveTranscript({
      user_id: userId,
      job_id: job.job_id,
      employer: subject,
      audit_id: auditId,
      outcome,
      narrator,
      started_at: startedAt,
      turns,
    });
    return { transcript: turns, transcript_id: transcriptId, narrator };
  }

  if (verification.verdict !== 'pass' || body.human_approved !== true || !verification.evidence) {
    const spokenReason = verification.verdict !== 'pass'
      ? verification.spoken_reason
      : 'Application blocked until the candidate approves the exact fields to release.';
    if (verification.verdict === 'pass') {
      recorder.turn({
        from: 'applicant_agent',
        to: 'applicant_agent',
        label: 'Waiting on the candidate',
        detail: spokenReason,
        data: { human_approved: body.human_approved === true, fields_requested: releasable },
        outcome: 'refused',
      });
    }
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
    return {
      httpStatus: 200,
      body: {
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
        ...(await close('refused', auditId)),
      },
    };
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
        job,
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
    recorder.turn({
      from: 'applicant_agent',
      to: 'applicant_agent',
      label: 'Could not sign the envelope',
      detail: spokenReason,
      outcome: 'failed',
    });
    const auditId = await recordAudit({
      ...auditBase,
      verdict: 'refuse',
      outcome: 'refused',
      spoken_reason: spokenReason,
      fields_released: [],
    });
    return {
      httpStatus: 500,
      body: {
        status: 'refused',
        fields_released: [],
        audit_id: auditId,
        spoken_reason: spokenReason,
        ...(await close('refused', auditId)),
      },
    };
  }

  const claims = envelopeClaims(jws);
  // The field NAMES, never their values — the same rule the audit log keeps.
  recorder.turn({
    from: 'applicant_agent',
    to: 'employer_agent',
    label: `Signed application, ${releasable.length} field${releasable.length === 1 ? '' : 's'}`,
    detail: `Posted an ES256-signed envelope to ${verification.evidence.agentCard.endpoint}, addressed to ${verification.evidence.agentCard.name} alone and valid for two minutes.`,
    data: {
      endpoint: verification.evidence.agentCard.endpoint,
      fields_released: releasable,
      envelope: claims,
      match_explanation: matchExplanation
        ? { score: matchExplanation.score, verdict: matchExplanation.verdict }
        : null,
    },
    outcome: 'ok',
  });

  let response: Response | null = null;
  // F7.9: the receipt also carries the employer's OWN verification of us and its
  // side of the match. Both were being parsed and dropped; keeping them is what
  // turns "we verified them" into a mutual, auditable handshake.
  let receipt: {
    status?: string;
    receipt_id?: string;
    applicant_verification?: { verdict?: string; dimensions?: TrustDimension[]; spoken_reason?: string };
    employer_explanation?: { score: number; verdict: string; reasons: string[] } | null;
  } = {};
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
  // Only trust the shape, never the claim: an employer saying "pass" does not
  // make it so, it records what they told us. It is evidence in the audit log,
  // not an input to our own gate -- ours already ran, above.
  const counterpartyVerification =
    receipt.applicant_verification && Array.isArray(receipt.applicant_verification.dimensions)
      ? {
          verdict: receipt.applicant_verification.verdict === 'pass' ? ('pass' as const) : ('refuse' as const),
          dimensions: receipt.applicant_verification.dimensions as TrustDimension[],
        }
      : null;
  const spokenReason = delivered
    ? `Application submitted to verified employer ${verification.evidence.agentCard.name}.`
    : `The verified employer agent did not accept the application (${response ? `HTTP ${response.status}` : 'unreachable'}).`;

  recorder.turn({
    from: 'employer_agent',
    to: 'applicant_agent',
    label: delivered ? 'Receipt, and their check on us' : 'No accepted receipt',
    detail: delivered
      ? `The employer agent answered HTTP ${response?.status} with receipt ${receipt.receipt_id ?? 'unnumbered'}${
          counterpartyVerification
            ? `, and its own five-dimension verdict on our applicant agent: ${counterpartyVerification.verdict}`
            : ''
        }.`
      : spokenReason,
    data: {
      http_status: response?.status ?? 0,
      status: receipt.status ?? null,
      receipt_id: receipt.receipt_id ?? null,
      counterparty_verdict: counterpartyVerification?.verdict ?? null,
      employer_explanation: receipt.employer_explanation
        ? { score: receipt.employer_explanation.score, verdict: receipt.employer_explanation.verdict }
        : null,
    },
    outcome: delivered ? 'ok' : 'failed',
  });

  const [matchPersisted, persisted, auditId] = await Promise.all([
    matchExplanation
      ? recordMatchExplanationSafely({
          applicationId: body.application_id,
          jobId: job.job_id,
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
      envelope: claims,
      counterparty_response: {
        http_status: response?.status ?? 0,
        status: receipt.status,
        receipt_id: receipt.receipt_id,
      },
      counterparty_verification: counterpartyVerification,
    }),
  ]);

  return {
    httpStatus: delivered ? 200 : 502,
    body: {
      status: delivered ? 'submitted' : 'delivery_failed',
      fields_released: releasable,
      audit_id: auditId,
      spoken_reason: spokenReason,
      persisted,
      match_persisted: matchPersisted,
      match_explanation: matchExplanation,
      employer_receipt_id: receipt.receipt_id ?? null,
      // F7.9 -- the employer's five-dimension verdict on our applicant agent, and
      // its own reading of the match. The answer to "isn't this just spam?".
      counterparty_verification: counterpartyVerification,
      counterparty_reason: receipt.applicant_verification?.spoken_reason ?? null,
      employer_explanation: receipt.employer_explanation ?? null,
      ...(await close(delivered ? 'submitted' : 'delivery_failed', auditId)),
    },
  };
}

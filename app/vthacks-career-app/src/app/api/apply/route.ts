import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { verifyProductionEmployer } from '../../../lib/ans/production';
import { failedTrustDimensions } from '../../../lib/ans/policy';

export const dynamic = 'force-dynamic';

const allowedFields = new Set(['full_name', 'email', 'resume_url', 'cover_letter']);

type ApplyBody = {
  agent_id?: string;
  human_approved?: boolean;
  candidate?: Record<string, unknown>;
  requested_fields?: string[];
};

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as ApplyBody;
  const verification = await verifyProductionEmployer(body.agent_id).catch((error: unknown) => ({
    verdict: 'refuse' as const,
    spoken_reason: `Application blocked. ${error instanceof Error ? error.message : 'ANS verification failed.'}`,
    dimensions: failedTrustDimensions(error instanceof Error ? error.message : 'ANS verification failed.'),
    checked_at: new Date().toISOString(),
    registry: null,
    evidence: null,
  }));
  const requested = Array.isArray(body.requested_fields) ? body.requested_fields : [];
  const releasable = requested.filter((field) => allowedFields.has(field));

  if (verification.verdict !== 'pass' || body.human_approved !== true || !verification.evidence) {
    const spokenReason = verification.verdict !== 'pass'
      ? verification.spoken_reason
      : 'Application blocked until the candidate approves the exact fields to release.';
    return NextResponse.json({
      status: 'refused',
      fields_released: [],
      audit_id: randomUUID(),
      spoken_reason: spokenReason,
      verification: {
        verdict: verification.verdict,
        dimensions: verification.dimensions,
        checked_at: verification.checked_at,
      },
    });
  }

  const candidate = body.candidate ?? {};
  const packet = Object.fromEntries(releasable.map((field) => [field, candidate[field]]));
  const response = await fetch(verification.evidence.agentCard.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      applicant_agent: process.env.APPLICANT_ANS_NAME ?? 'ans://v1.0.0.applicant.hirewire.biz',
      candidate: packet,
      verification: {
        verdict: verification.verdict,
        dimensions: verification.dimensions,
        checked_at: verification.checked_at,
      },
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    return NextResponse.json({
      status: 'delivery_failed',
      fields_released: releasable,
      audit_id: randomUUID(),
      spoken_reason: `The verified employer endpoint received the approved fields but returned HTTP ${response.status}.`,
    }, { status: 502 });
  }

  return NextResponse.json({
    status: 'submitted',
    fields_released: releasable,
    audit_id: randomUUID(),
    spoken_reason: `Application submitted to verified employer ${verification.evidence.agentCard.name}.`,
  });
}

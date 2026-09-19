import { NextResponse } from 'next/server';
import { verifyProductionEmployer } from '../../../lib/ans/production';
import { failedTrustDimensions } from '../../../lib/ans/policy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { agent_id?: string };
    const result = await verifyProductionEmployer(body.agent_id);
    return NextResponse.json({
      verdict: result.verdict,
      dimensions: result.dimensions,
      spoken_reason: result.spoken_reason,
      checked_at: result.checked_at,
      registry: result.registry,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown ANS verification failure.';
    return NextResponse.json({
      verdict: 'refuse',
      dimensions: failedTrustDimensions(reason),
      spoken_reason: `Application blocked. ${reason}`,
      checked_at: new Date().toISOString(),
    }, { status: 502 });
  }
}

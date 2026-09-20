/**
 * POST /api/apply — send one application to one employer agent.
 *
 * The exchange itself lives in `lib/a2a/apply-exchange.ts` so that this route and
 * the streaming one cannot drift into two different gates; see the header there.
 * This route answers once, when it is over, and its response is unchanged except
 * for the added `transcript`, `transcript_id` and `narrator` fields.
 */
import { NextResponse } from 'next/server';

import { auth } from '../../../auth';
import { runApplyExchange, type ApplyBody } from '../../../lib/a2a/apply-exchange';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (session.user.role !== 'applicant') return NextResponse.json({ error: 'Applicant role required.' }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as ApplyBody;
  const { httpStatus, body: payload } = await runApplyExchange(body, session.user.id ?? null);
  return NextResponse.json(payload, { status: httpStatus });
}

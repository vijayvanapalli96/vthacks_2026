/**
 * The screenshot the ATS worker took of the form it filled.
 *
 * Without this the worker's answer is unverifiable: it says "prepared" and the
 * evidence is a PNG inside a container the person cannot reach. The volume is
 * mounted read-only into this service (infra/vultr/docker-compose.yml) and the
 * file is streamed back here.
 *
 * The worker names its own artifacts, but the name still arrives through a
 * query string, so it is treated as hostile input: basename only, a strict
 * pattern, and the resolved path has to stay inside the directory. Serving
 * files by a caller-supplied path is how a screenshot endpoint turns into an
 * arbitrary-file read.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { auth } from '../../../../../auth';

export const dynamic = 'force-dynamic';

const ARTIFACT_DIR = process.env.ATS_ARTIFACT_MOUNT ?? '/app/ats-artifacts';
const SAFE_NAME = /^[0-9TZ:.-]+-[a-z0-9_-]+\.png$/i;

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (session.user.role !== 'applicant') {
    return NextResponse.json({ error: 'Applicant role required.' }, { status: 403 });
  }

  const requested = new URL(request.url).searchParams.get('name') ?? '';
  const name = path.basename(requested);
  if (!SAFE_NAME.test(name)) {
    return NextResponse.json({ error: 'That is not an artifact name.' }, { status: 400 });
  }

  const resolved = path.resolve(ARTIFACT_DIR, name);
  if (path.dirname(resolved) !== path.resolve(ARTIFACT_DIR)) {
    return NextResponse.json({ error: 'That is not an artifact name.' }, { status: 400 });
  }

  try {
    const file = await readFile(resolved);
    return new NextResponse(new Uint8Array(file), {
      headers: {
        'content-type': 'image/png',
        // The artifact is this person's own application, part-filled.
        'cache-control': 'private, max-age=300',
      },
    });
  } catch {
    return NextResponse.json({ error: 'That artifact is no longer available.' }, { status: 404 });
  }
}

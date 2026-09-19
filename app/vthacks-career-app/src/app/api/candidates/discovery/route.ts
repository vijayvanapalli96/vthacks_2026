import { NextResponse } from 'next/server';
import { auth } from '../../../../auth';
import { sql } from '../../../../lib/databricks';
import { APPLICANT_ANS_NAME } from '../../../../lib/ans/production';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (session.user.role !== 'employer') return NextResponse.json({ error: 'Employer role required.' }, { status: 403 });

  const result = await sql(
    `SELECT applicant_ans_name, headline, skills, target_roles, locations, updated_at
     FROM workspace.vthacks_2026.candidate_discovery_profiles
     WHERE opt_in = true
     ORDER BY updated_at DESC
     LIMIT 50`,
  );
  return NextResponse.json({ columns: result.columns, candidates: result.rows });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (session.user.role !== 'applicant') return NextResponse.json({ error: 'Applicant role required.' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as {
    headline?: string;
    skills?: string[];
    target_roles?: string[];
    locations?: string[];
    opt_in?: boolean;
  };
  const clean = (values: string[] | undefined) =>
    (values ?? []).filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean).slice(0, 30);

  await sql(
    `MERGE INTO workspace.vthacks_2026.candidate_discovery_profiles AS target
     USING (SELECT :user_id AS user_id) AS source
     ON target.user_id = source.user_id
     WHEN MATCHED THEN UPDATE SET
       applicant_ans_name = :applicant_ans_name, headline = :headline,
       skills = from_json(:skills, 'ARRAY<STRING>'),
       target_roles = from_json(:target_roles, 'ARRAY<STRING>'),
       locations = from_json(:locations, 'ARRAY<STRING>'),
       opt_in = :opt_in, updated_at = current_timestamp()
     WHEN NOT MATCHED THEN INSERT (
       user_id, applicant_ans_name, headline, skills, target_roles, locations, opt_in, updated_at
     ) VALUES (
       :user_id, :applicant_ans_name, :headline,
       from_json(:skills, 'ARRAY<STRING>'),
       from_json(:target_roles, 'ARRAY<STRING>'),
       from_json(:locations, 'ARRAY<STRING>'), :opt_in, current_timestamp()
     )`,
    [
      { name: 'user_id', value: session.user.id },
      { name: 'applicant_ans_name', value: APPLICANT_ANS_NAME },
      { name: 'headline', value: body.headline?.trim().slice(0, 200) ?? null },
      { name: 'skills', value: JSON.stringify(clean(body.skills)) },
      { name: 'target_roles', value: JSON.stringify(clean(body.target_roles)) },
      { name: 'locations', value: JSON.stringify(clean(body.locations)) },
      { name: 'opt_in', value: body.opt_in === true ? 'true' : 'false', type: 'BOOLEAN' },
    ],
  );
  return NextResponse.json({ status: 'saved', opt_in: body.opt_in === true });
}

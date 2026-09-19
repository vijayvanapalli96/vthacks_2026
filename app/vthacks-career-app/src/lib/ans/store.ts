import { randomUUID } from 'node:crypto';
import { sql } from '../databricks';
import type { TrustDimension } from './policy';

type VerificationRecord = {
  applicationId?: string;
  verifierAnsName: string;
  subjectAnsName: string;
  subjectRole: 'employer' | 'applicant';
  purpose: 'job_application' | 'recruiting_invitation';
  version?: string;
  verdict: 'pass' | 'refuse';
  dimensions: TrustDimension[];
  fieldsReleased: string[];
};

export async function recordAgentVerification(record: VerificationRecord) {
  const scores = new Map(record.dimensions.map((item) => [item.name, item.score]));
  await sql(
    `INSERT INTO workspace.vthacks_2026.agent_verifications (
      verification_id, application_id, verifier_ans_name, agent_ans_name,
      subject_role, purpose, agent_version, verdict, integrity, identity,
      solvency, behavior, safety, reasons_json, pii_fields_released, checked_at
    ) VALUES (
      :verification_id, :application_id, :verifier_ans_name, :agent_ans_name,
      :subject_role, :purpose, :agent_version, :verdict, :integrity, :identity,
      :solvency, :behavior, :safety, :reasons_json,
      from_json(:pii_fields_released, 'ARRAY<STRING>'), current_timestamp()
    )`,
    [
      { name: 'verification_id', value: randomUUID() },
      { name: 'application_id', value: record.applicationId ?? null },
      { name: 'verifier_ans_name', value: record.verifierAnsName },
      { name: 'agent_ans_name', value: record.subjectAnsName },
      { name: 'subject_role', value: record.subjectRole },
      { name: 'purpose', value: record.purpose },
      { name: 'agent_version', value: record.version ?? null },
      { name: 'verdict', value: record.verdict === 'pass' ? 'allowed' : 'refused' },
      ...(['integrity', 'identity', 'solvency', 'behavior', 'safety'] as const).map((name) => ({
        name,
        value: String(scores.get(name) ?? 0),
        type: 'DOUBLE' as const,
      })),
      { name: 'reasons_json', value: JSON.stringify(record.dimensions) },
      { name: 'pii_fields_released', value: JSON.stringify(record.fieldsReleased) },
    ],
  );
}

export async function recordAgentVerificationSafely(record: VerificationRecord) {
  try {
    await recordAgentVerification(record);
    return true;
  } catch (error) {
    console.error('Could not persist ANS verification', error);
    return false;
  }
}

export async function saveJobAgentLink(input: {
  jobId: string;
  employerDomain: string;
  agentId: string;
  ansName: string;
  endpoint: string;
}) {
  await sql(
    `MERGE INTO workspace.vthacks_2026.job_agent_links AS target
     USING (SELECT :job_id AS job_id) AS source
     ON target.job_id = source.job_id
     WHEN MATCHED THEN UPDATE SET
       employer_domain = :employer_domain, employer_agent_id = :agent_id,
       employer_ans_name = :ans_name, employer_endpoint = :endpoint,
       discovery_status = 'verified', discovered_at = current_timestamp()
     WHEN NOT MATCHED THEN INSERT (
       job_id, employer_domain, employer_agent_id, employer_ans_name,
       employer_endpoint, discovery_status, discovered_at
     ) VALUES (
       :job_id, :employer_domain, :agent_id, :ans_name,
       :endpoint, 'verified', current_timestamp()
     )`,
    [
      { name: 'job_id', value: input.jobId },
      { name: 'employer_domain', value: input.employerDomain },
      { name: 'agent_id', value: input.agentId },
      { name: 'ans_name', value: input.ansName },
      { name: 'endpoint', value: input.endpoint },
    ],
  );
}

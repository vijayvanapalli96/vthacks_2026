/**
 * employer.ts — the reads behind the hiring-manager workspace.
 *
 * WHAT THIS REPLACES. The employer dashboard shipped with three hardcoded
 * arrays — three invented roles, three invented applicants ("Priya
 * Raghunathan", "Marcus Ellery", "Dani Okafor") and four invented metrics — and
 * a nav bar of dead <span>s. Meanwhile `/api/candidates/discovery` and
 * `/api/recruit/invite` were finished and had no caller anywhere in the app.
 * Everything below reads what actually happened instead, which is also hard
 * rule 7: real content only.
 *
 * TWO SOURCES, because the two halves of the job live in different places.
 *   Mongo `a2a_audit`  — every handshake this employer agent was part of:
 *                        applications received, invitations sent, refusals,
 *                        attack probes. Written by the applicant side and by
 *                        /api/recruit/invite; read here, never written.
 *   Databricks         — `candidate_discovery_profiles`, the opt-in, non-PII
 *                        search surface students publish themselves.
 *
 * NO PII COMES OUT OF EITHER. The audit log stores field NAMES, so this can say
 * "they released full_name, email and skills" and cannot say what they were.
 * That is the point of the log and it is not worked around here — a hiring
 * manager sees the candidate's data when the candidate's agent sends it, not by
 * reading our records of the transfer.
 *
 * ONE EMPLOYER TODAY. Everything is scoped to EMPLOYER_ANS_NAME, the single
 * registered employer agent this deployment owns. A second employer would need
 * this scoped per account; it is not, and the pages say which agent they are
 * reporting on rather than implying "your company".
 */
import type { AuditDocument } from './audit';
import { mongoCollection } from './mongo';
import { EMPLOYER_ANS_NAME } from './ans/production';
import { sql } from './databricks';
import type { TrustDimension } from './ans/policy';

export type InboundApplication = {
  audit_id: string;
  at: Date;
  /** The applicant agent's ANS name. The person behind it is not in this log. */
  applicant: string;
  job_id: string | null;
  fields_released: string[];
  outcome: AuditDocument['outcome'];
  spoken_reason: string;
  /** What THEY concluded about us, from the envelope they signed. */
  their_verdict: 'pass' | 'refuse' | null;
  /** What WE concluded about them, returned in our receipt. */
  our_verdict: 'pass' | 'refuse' | null;
  our_dimensions: TrustDimension[];
  receipt_id: string | null;
  approval_mode: 'confirmed' | 'auto' | null;
};

/**
 * Every audit document this employer agent is a party to, either as the subject
 * of someone else's check or as the verifier in its own.
 */
async function auditsForEmployer(limit: number): Promise<AuditDocument[] | null> {
  try {
    // READ ONLY. audit.ts stays the single writer of this collection.
    const audit = await mongoCollection<AuditDocument>('a2a_audit');
    if (!audit) return null;
    return await audit
      .find(
        { $or: [{ subject: EMPLOYER_ANS_NAME }, { verifier: EMPLOYER_ANS_NAME }] },
        { projection: { _id: 0 } },
      )
      .sort({ at: -1 })
      .limit(Math.min(limit, 200))
      .toArray();
  } catch (error) {
    console.error('Could not read the employer audit trail', error);
    return null;
  }
}

/** Null means the log could not be read — never an empty inbox. */
export async function employerAudits(limit = 100): Promise<AuditDocument[] | null> {
  return auditsForEmployer(limit);
}

export async function inboundApplications(limit = 50): Promise<InboundApplication[] | null> {
  const audits = await auditsForEmployer(200);
  if (audits === null) return null;
  return audits
    .filter((event) => event.kind === 'apply' && event.subject === EMPLOYER_ANS_NAME)
    .slice(0, limit)
    .map((event) => ({
      audit_id: event.audit_id,
      at: event.at,
      applicant: event.verifier,
      job_id: event.job_id ?? null,
      fields_released: event.fields_released ?? [],
      outcome: event.outcome,
      spoken_reason: event.spoken_reason,
      their_verdict: event.verdict ?? null,
      our_verdict: event.counterparty_verification?.verdict ?? null,
      our_dimensions: event.counterparty_verification?.dimensions ?? [],
      receipt_id: event.counterparty_response?.receipt_id ?? null,
      approval_mode: event.approval_mode ?? null,
    }));
}

export type EmployerCounts = {
  applications: number;
  delivered: number;
  refused: number;
  invitations: number;
  attacks_blocked: number;
  /** Distinct applicant agents, which is the only "people" number we can honestly give. */
  agents: number;
  roles: number;
};

export async function employerCounts(): Promise<EmployerCounts | null> {
  const audits = await auditsForEmployer(200);
  if (audits === null) return null;
  const applications = audits.filter((event) => event.kind === 'apply' && event.subject === EMPLOYER_ANS_NAME);
  return {
    applications: applications.length,
    delivered: applications.filter((event) => event.outcome === 'submitted').length,
    // A refusal here is OUR gate or THEIRS: either way nothing was released, and
    // showing it is the point — the refusals are the evidence the gate works.
    refused: audits.filter((event) => event.verdict === 'refuse').length,
    invitations: audits.filter((event) => event.kind === 'invitation').length,
    attacks_blocked: audits.filter((event) => event.kind === 'attack' && event.verdict === 'refuse').length,
    agents: new Set(applications.map((event) => event.verifier)).size,
    roles: new Set(applications.map((event) => event.job_id).filter(Boolean)).size,
  };
}

/**
 * Titles for the job ids that turn up in the log, in ONE query rather than one
 * per row. Ids come from our own audit documents, and are filtered to the
 * characters a job id can contain before they are inlined — the SQL statement
 * API takes named parameters, not arrays, and an IN list cannot be built from
 * them.
 */
export async function jobTitles(jobIds: string[]): Promise<Record<string, string>> {
  const safe = [...new Set(jobIds)].filter((id) => /^[A-Za-z0-9._:-]{1,255}$/.test(id));
  if (safe.length === 0) return {};
  try {
    const list = safe.map((id) => `'${id}'`).join(', ');
    const result = await sql(
      `SELECT job_id, job_title, company_name FROM workspace.vthacks_2026.job_snapshots WHERE job_id IN (${list})`,
    );
    const index = Object.fromEntries(result.columns.map((column, position) => [column, position]));
    return Object.fromEntries(
      result.rows.map((row) => [
        String(row[index.job_id]),
        [row[index.job_title], row[index.company_name]].filter(Boolean).join(' · '),
      ]),
    );
  } catch (error) {
    // The id alone is still a true label, so a warehouse miss degrades to that.
    console.error('Could not resolve job titles', error);
    return {};
  }
}

export type DiscoveryProfile = {
  applicant_ans_name: string;
  headline: string | null;
  skills: string[];
  target_roles: string[];
  locations: string[];
  updated_at: string | null;
};

/**
 * The opt-in candidate surface. `opt_in = true` is in the WHERE clause, not in
 * the UI: a student who has not published themselves is not discoverable, and
 * that must not depend on a component remembering to filter.
 *
 * Null means the read failed, which the page states rather than drawing an
 * empty talent pool.
 */
export async function discoveryProfiles(limit = 50): Promise<DiscoveryProfile[] | null> {
  try {
    const result = await sql(
      `SELECT applicant_ans_name, headline, skills, target_roles, locations, CAST(updated_at AS STRING) AS updated_at
       FROM workspace.vthacks_2026.candidate_discovery_profiles
       WHERE opt_in = true
       ORDER BY updated_at DESC
       LIMIT ${Math.max(1, Math.min(limit, 100))}`,
    );
    const index = Object.fromEntries(result.columns.map((column, position) => [column, position]));
    const list = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
      if (typeof value !== 'string') return [];
      // The statement API returns ARRAY<STRING> as a JSON string.
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
      } catch {
        return [];
      }
    };
    return result.rows.map((row) => ({
      applicant_ans_name: String(row[index.applicant_ans_name]),
      headline: (row[index.headline] as string | null) ?? null,
      skills: list(row[index.skills]),
      target_roles: list(row[index.target_roles]),
      locations: list(row[index.locations]),
      updated_at: (row[index.updated_at] as string | null) ?? null,
    }));
  } catch (error) {
    console.error('Could not read the candidate discovery profiles', error);
    return null;
  }
}

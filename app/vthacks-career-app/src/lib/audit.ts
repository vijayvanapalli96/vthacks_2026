/**
 * audit.ts — the immutable A2A audit log (F7.8), MongoDB Atlas `hirewire.a2a_audit`.
 *
 * One document per agent-to-agent decision: every verify, apply, invitation and
 * attack-console probe, refusals included. It records WHICH fields were released
 * and to whom, never their values: an audit log that stores PII becomes the leak.
 *
 * INSERT-ONLY. Nothing in this codebase updates or deletes an audit document;
 * `recordAudit` is the only writer. Databricks `agent_verifications` keeps its
 * own row for analytics; this is the per-message record.
 *
 * Auditing must never block or break the flow it audits, so every call is
 * best-effort: on failure it logs and returns null.
 */
import { randomUUID } from 'node:crypto';
import { MongoClient, type Collection } from 'mongodb';

import type { TrustDimension } from './ans/policy';

export type AuditEvent = {
  kind: 'verify' | 'apply' | 'invitation' | 'attack';
  direction: 'applicant_to_employer' | 'employer_to_applicant';
  verifier: string;
  subject: string;
  subject_registered: boolean;
  verdict: 'pass' | 'refuse';
  outcome: 'verified' | 'refused' | 'submitted' | 'delivery_failed' | 'invitation_sent' | 'blocked' | 'accepted';
  spoken_reason: string;
  dimensions?: TrustDimension[];
  fields_requested?: string[];
  fields_released: string[];
  human_approved?: boolean;
  user_id?: string | null;
  job_id?: string | null;
  envelope?: { jti: string; aud: string; iat: number; exp: number } | null;
  counterparty_response?: { http_status: number; status?: string; receipt_id?: string } | null;
  attack?: { id: string; label: string } | null;
};

export type AuditDocument = AuditEvent & { audit_id: string; at: Date };

const DATABASE = 'hirewire';
const COLLECTION = 'a2a_audit';

let client: Promise<MongoClient> | null = null;
let indexed = false;

function uri(): string | null {
  // The Databricks secret can arrive with a trailing newline from stdin.
  return process.env.MONGODB_URI?.trim() || null;
}

async function collection(): Promise<Collection<AuditDocument> | null> {
  const value = uri();
  if (!value) return null;
  client ??= new MongoClient(value, { serverSelectionTimeoutMS: 8000, appName: 'hirewire-app' })
    .connect()
    .catch((error: unknown) => {
      client = null;
      throw error;
    });
  const audit = (await client).db(DATABASE).collection<AuditDocument>(COLLECTION);
  if (!indexed) {
    indexed = true;
    await audit
      .createIndexes([
        { key: { at: -1 }, name: 'at' },
        { key: { user_id: 1, at: -1 }, name: 'user_at' },
        { key: { subject: 1, at: -1 }, name: 'subject_at' },
        { key: { verdict: 1, at: -1 }, name: 'verdict_at' },
        { key: { audit_id: 1 }, name: 'audit_id', unique: true },
      ])
      .catch((error: unknown) => {
        indexed = false;
        console.error('Could not create audit indexes', error);
      });
  }
  return audit;
}

export async function recordAudit(event: AuditEvent): Promise<string | null> {
  // Invariant, not a style choice: a refusal can never have released a field.
  if (event.verdict === 'refuse' && event.fields_released.length > 0) {
    console.error('Refusing to audit a refusal that claims released fields', event.subject);
    event = { ...event, fields_released: [] };
  }
  try {
    const audit = await collection();
    if (!audit) return null;
    const document: AuditDocument = { ...event, audit_id: randomUUID(), at: new Date() };
    await audit.insertOne(document);
    return document.audit_id;
  } catch (error) {
    console.error('Could not write the A2A audit record', error);
    return null;
  }
}

export async function recentAudits(filter: { userId?: string; limit?: number } = {}): Promise<AuditDocument[] | null> {
  try {
    const audit = await collection();
    if (!audit) return null;
    const query = filter.userId ? { user_id: filter.userId } : {};
    return await audit
      .find(query, { projection: { _id: 0 } })
      .sort({ at: -1 })
      .limit(Math.min(filter.limit ?? 50, 200))
      .toArray();
  } catch (error) {
    console.error('Could not read the A2A audit log', error);
    return null;
  }
}

/** The non-secret claims of a compact JWS we signed, for the audit record. */
export function envelopeClaims(jws: string): AuditEvent['envelope'] {
  try {
    const claims = JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString('utf8'));
    return { jti: claims.jti, aud: claims.aud, iat: claims.iat, exp: claims.exp };
  } catch {
    return null;
  }
}

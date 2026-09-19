/**
 * profile-memory.ts — the profile that grows over time.
 *
 * APPEND-ONLY. Never UPDATE, never DELETE. Every observation is a new row with its
 * own provenance and confidence, so a later contradiction sits next to the earlier
 * claim instead of erasing it. That history is the difference between a memory and
 * a form, and it is what lets the UI say "we believe X, because document Y said so".
 *
 * Current state is read through the profile_current view (latest row per
 * (user_id, fact_key)), never by mutating rows here.
 *
 * Column names are the workspace's, not this module's: fact_key / fact_value /
 * source_ref. source_ref carries the intake_documents.document_id.
 */
import { randomUUID } from 'node:crypto';

import { sql, type SqlParam } from '@/lib/databricks';
import type { ExtractedProfile, ExtractProvider } from '@/lib/extract/types';

const TABLE = 'workspace.vthacks_2026.profile_memory';

/**
 * Facts per INSERT. Each fact contributes 8 bound parameters, and the Statement
 * Execution API caps parameters per request, so a 200-fact resume has to arrive in
 * batches rather than one enormous statement.
 */
const FACTS_PER_INSERT = 25;

export type FactKind =
  | 'contact'
  | 'education'
  | 'experience'
  | 'project'
  | 'skill'
  | 'course'
  | 'certification'
  | 'summary'
  | 'preference';

export type ProfileFact = {
  factId: string;
  userId: string;
  kind: FactKind;
  /** Stable dotted path, e.g. "contact.email" or "experience.0.title". */
  key: string;
  value: string;
  /** 0..1. Provenance, not decoration: the UI shows it next to the fact. */
  confidence: number;
  /** Where it came from, e.g. "resume:databricks:databricks-llama-4-maverick". */
  source: string;
  /** intake_documents.document_id that produced this fact. */
  sourceRef: string;
  observedAt: string;
};

/* ------------------------------------------------------------------ flatten */

/**
 * Flatten an extracted profile into facts.
 *
 * Confidence is deliberately coarse. A model that returns a well-formed email is
 * almost certainly right; a free-text bullet it lifted from a two-column layout is
 * less certain. Inventing finer-grained numbers would be false precision, and we
 * show these to users.
 */
export function toFacts(
  profile: ExtractedProfile,
  meta: {
    userId: string;
    provider: ExtractProvider;
    model: string;
    sourceRef: string;
    sourceKind?: string;
    observedAt?: string;
    /**
     * Namespace for every fact_key this call produces, e.g. 'web.' → 'web.contact.name'.
     *
     * WHY THIS IS NOT COSMETIC. profile_current is "latest row per (user_id,
     * fact_key)", so two sources writing the same key means the one that ran last
     * wins — regardless of confidence. Without a namespace, a low-confidence
     * web-search guess appended after the resume in the same analysis pass would
     * silently become the current value of contact.name. Namespacing makes the two
     * observations coexist instead of one overwriting the other, which is what
     * append-only was for. The authoritative single-value merge happens in
     * mergeProfiles() and in the COALESCE on profiles, not here.
     */
    keyPrefix?: string;
    /**
     * Multiplier on every confidence below, for sources that are inference rather
     * than transcription. Web enrichment passes 0.5, so its most certain fact lands
     * under 0.5 and sorts beneath every document-derived one. Never used to push a
     * value UP: a source cannot become more certain than the field type allows.
     */
    confidenceScale?: number;
  },
): ProfileFact[] {
  const observedAt = meta.observedAt ?? new Date().toISOString();
  const source = `${meta.sourceKind ?? 'resume'}:${meta.provider}:${meta.model}`;
  const prefix = meta.keyPrefix ?? '';
  const scale = Math.min(meta.confidenceScale ?? 1, 1);
  const facts: ProfileFact[] = [];

  const push = (kind: FactKind, key: string, value: string | undefined, confidence: number) => {
    if (!value) return;
    facts.push({
      factId: randomUUID(),
      userId: meta.userId,
      kind,
      key: `${prefix}${key}`,
      value,
      // Rounded because this number is rendered next to the fact: 0.42 is a
      // confidence, 0.42499999999999993 is a bug the user gets to look at.
      confidence: Math.round(confidence * scale * 100) / 100,
      source,
      sourceRef: meta.sourceRef,
      observedAt,
    });
  };

  push('contact', 'contact.name', profile.name, 0.95);
  push('contact', 'contact.email', profile.email, 0.98);
  push('contact', 'contact.phone', profile.phone, 0.95);
  push('contact', 'contact.location', profile.location, 0.85);
  push('summary', 'summary', profile.summary, 0.7);

  profile.links.forEach((link, i) => {
    push('contact', `contact.link.${i}`, link.url ?? link.label, 0.9);
  });

  profile.education.forEach((entry, i) => {
    push('education', `education.${i}.school`, entry.school, 0.95);
    push('education', `education.${i}.degree`, entry.degree, 0.9);
    push('education', `education.${i}.field`, entry.field, 0.9);
    push('education', `education.${i}.gpa`, entry.gpa, 0.9);
    push('education', `education.${i}.dates`, joinDates(entry.startDate, entry.endDate), 0.8);
  });

  profile.experience.forEach((entry, i) => {
    push('experience', `experience.${i}.company`, entry.company, 0.95);
    push('experience', `experience.${i}.title`, entry.title, 0.95);
    push('experience', `experience.${i}.location`, entry.location, 0.8);
    push('experience', `experience.${i}.dates`, joinDates(entry.startDate, entry.endDate), 0.8);
    entry.bullets.forEach((bullet, b) => {
      push('experience', `experience.${i}.bullet.${b}`, bullet, 0.75);
    });
  });

  profile.projects.forEach((entry, i) => {
    push('project', `project.${i}.name`, entry.name, 0.9);
    push('project', `project.${i}.description`, entry.description, 0.75);
    entry.tech.forEach((tech, t) => push('project', `project.${i}.tech.${t}`, tech, 0.85));
  });

  profile.skills.forEach((skill, i) => push('skill', `skill.${slug(skill, i)}`, skill, 0.85));
  profile.courses.forEach((course, i) => {
    const value = [course.code, course.title].filter(Boolean).join(' ');
    push('course', `course.${slug(course.code ?? course.title ?? String(i), i)}`, value || undefined, 0.85);
  });
  profile.certifications.forEach((cert, i) =>
    push('certification', `certification.${slug(cert, i)}`, cert, 0.85),
  );

  return facts;
}

/** A single fact, for sources that are one value rather than a whole document. */
export function singleFact(args: {
  userId: string;
  kind: FactKind;
  key: string;
  value: string;
  confidence: number;
  source: string;
  sourceRef: string;
}): ProfileFact {
  return {
    factId: randomUUID(),
    userId: args.userId,
    kind: args.kind,
    key: args.key,
    value: args.value,
    confidence: args.confidence,
    source: args.source,
    sourceRef: args.sourceRef,
    observedAt: new Date().toISOString(),
  };
}

function joinDates(start?: string, end?: string): string | undefined {
  if (!start && !end) return undefined;
  return [start ?? '?', end ?? 'present'].join(' – ');
}

function slug(value: string, fallbackIndex: number): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || String(fallbackIndex);
}

/* -------------------------------------------------------------------- store */

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Append facts. Batched, because one statement per fact would be hundreds of round trips. */
export async function appendFacts(facts: ProfileFact[]): Promise<number> {
  if (facts.length === 0) return 0;

  for (const batch of chunk(facts, FACTS_PER_INSERT)) {
    const parameters: SqlParam[] = [];
    const tuples = batch.map((fact, i) => {
      parameters.push(
        { name: `id${i}`, value: fact.factId },
        { name: `user${i}`, value: fact.userId },
        { name: `kind${i}`, value: fact.kind },
        { name: `key${i}`, value: fact.key },
        { name: `value${i}`, value: fact.value },
        { name: `conf${i}`, value: String(fact.confidence), type: 'DOUBLE' },
        { name: `source${i}`, value: fact.source },
        { name: `ref${i}`, value: fact.sourceRef },
        { name: `at${i}`, value: fact.observedAt, type: 'TIMESTAMP' },
      );
      return `(:id${i}, :user${i}, :kind${i}, :key${i}, :value${i}, :conf${i}, :source${i}, :ref${i}, :at${i})`;
    });

    await sql(
      `INSERT INTO ${TABLE}
         (fact_id, user_id, kind, fact_key, fact_value, confidence, source, source_ref, observed_at)
       VALUES ${tuples.join(', ')}`,
      parameters,
    );
  }

  return facts.length;
}

export type CurrentFact = {
  key: string;
  value: string;
  confidence: number;
  source: string;
  sourceRef: string;
  observedAt: string;
};

/** Current state, straight from the view. No mutation, no client-side reduction. */
export async function readCurrentFacts(userId: string): Promise<CurrentFact[]> {
  const result = await sql(
    `SELECT fact_key, fact_value, confidence, source, source_ref, observed_at
       FROM workspace.vthacks_2026.profile_current
      WHERE user_id = :user
      ORDER BY fact_key`,
    [{ name: 'user', value: userId }],
  );
  return result.rows.map((row) => ({
    key: row[0] ?? '',
    value: row[1] ?? '',
    confidence: Number(row[2] ?? 0),
    source: row[3] ?? '',
    sourceRef: row[4] ?? '',
    observedAt: row[5] ?? '',
  }));
}

/** How much the memory holds. Cheap enough to render on the profile page. */
export async function countFacts(userId: string): Promise<number> {
  const result = await sql(`SELECT count(*) FROM ${TABLE} WHERE user_id = :user`, [
    { name: 'user', value: userId },
  ]);
  return Number(result.rows[0]?.[0] ?? 0);
}

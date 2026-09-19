/**
 * profile-memory.ts — the memory that grows over time.
 *
 * HARD RULE: append-only. Never UPDATE, never DELETE. Current state is derived
 * (latest row per (userId, key) by observedAt), never stored. That is what makes
 * this a memory rather than a form: we can always show where a fact came from and
 * when we learned it, and a later contradiction is a new fact rather than a
 * destroyed one.
 *
 * Two backends behind one interface:
 *   dev         JSON file (PROFILE_STORE, default .data/profile-memory.json)
 *   databricks  INSERT INTO workspace.vthacks_2026.profile_memory
 *
 * TABLE OWNER: Tarang. Schema lives in docs/FEATURE_LIST.md. The table is being
 * created in parallel with this code, so the Databricks path may 404 at first.
 * When it does we degrade to the dev store and warn — an upload must never fail
 * because the warehouse is not ready yet.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executeStatement, hasDatabricks } from '@/lib/databricks-sql';
import type { ExtractedProfile, ExtractProvider } from '@/lib/extract/types';

const TABLE = 'workspace.vthacks_2026.profile_memory';

export type FactKind = 'contact' | 'education' | 'experience' | 'project' | 'skill' | 'course' | 'certification' | 'summary';

export type ProfileFact = {
  factId: string;
  userId: string;
  kind: FactKind;
  /** Stable dotted path, e.g. "contact.email" or "experience.0.title". */
  key: string;
  value: string;
  /** 0..1. Provenance, not decoration: the UI shows it next to the fact. */
  confidence: number;
  /** Where it came from, e.g. "resume:gemini:gemini-2.5-flash". */
  source: string;
  /** Pointer to the originating artifact, e.g. the uploaded filename. */
  sourceRef: string;
  observedAt: string;
};

export type AppendResult = {
  appended: number;
  backend: 'databricks' | 'dev-file';
  warnings: string[];
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
  meta: { userId: string; provider: ExtractProvider; model: string; sourceRef: string; observedAt?: string },
): ProfileFact[] {
  const observedAt = meta.observedAt ?? new Date().toISOString();
  const source = `resume:${meta.provider}:${meta.model}`;
  const facts: ProfileFact[] = [];

  const push = (kind: FactKind, key: string, value: string | undefined, confidence: number) => {
    if (!value) return;
    facts.push({
      factId: randomUUID(),
      userId: meta.userId,
      kind,
      key,
      value,
      confidence,
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
  profile.certifications.forEach((cert, i) => push('certification', `certification.${slug(cert, i)}`, cert, 0.85));

  return facts;
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

export type ProfileMemoryStore = {
  append: (facts: ProfileFact[]) => Promise<void>;
  readAll: (userId: string) => Promise<ProfileFact[]>;
};

/* dev: JSON file */

function devStorePath(): string {
  return process.env.PROFILE_STORE?.trim() || path.join('.data', 'profile-memory.json');
}

export const devFileStore: ProfileMemoryStore = {
  async append(facts) {
    if (facts.length === 0) return;
    const file = devStorePath();
    await mkdir(path.dirname(file), { recursive: true });
    const existing = await readDevFile(file);
    await writeFile(file, JSON.stringify([...existing, ...facts], null, 2), 'utf8');
  },
  async readAll(userId) {
    const all = await readDevFile(devStorePath());
    return all.filter((fact) => fact.userId === userId);
  },
};

async function readDevFile(file: string): Promise<ProfileFact[]> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProfileFact[]) : [];
  } catch {
    // Missing or unreadable file means "no memory yet", which is a valid state.
    return [];
  }
}

/* databricks: append-only INSERT */

export const databricksStore: ProfileMemoryStore = {
  async append(facts) {
    // One statement per fact keeps parameter binding simple and the failure
    // granular. At resume scale (tens of facts) the round-trips are acceptable;
    // if this ever gets hot, batch with a multi-row VALUES clause.
    for (const fact of facts) {
      await executeStatement(
        `INSERT INTO ${TABLE}
           (fact_id, user_id, kind, key, value, confidence, source, source_ref, observed_at)
         VALUES
           (:fact_id, :user_id, :kind, :key, :value, CAST(:confidence AS DOUBLE), :source, :source_ref, CAST(:observed_at AS TIMESTAMP))`,
        [
          { name: 'fact_id', value: fact.factId, type: 'STRING' },
          { name: 'user_id', value: fact.userId, type: 'STRING' },
          { name: 'kind', value: fact.kind, type: 'STRING' },
          { name: 'key', value: fact.key, type: 'STRING' },
          { name: 'value', value: fact.value, type: 'STRING' },
          { name: 'confidence', value: String(fact.confidence), type: 'STRING' },
          { name: 'source', value: fact.source, type: 'STRING' },
          { name: 'source_ref', value: fact.sourceRef, type: 'STRING' },
          { name: 'observed_at', value: fact.observedAt, type: 'STRING' },
        ],
      );
    }
  },

  async readAll(userId) {
    const { rows } = await executeStatement(
      `SELECT fact_id, user_id, kind, key, value, confidence, source, source_ref,
              CAST(observed_at AS STRING)
         FROM ${TABLE}
        WHERE user_id = :user_id
        ORDER BY observed_at`,
      [{ name: 'user_id', value: userId, type: 'STRING' }],
    );
    return rows.map((row) => ({
      factId: row[0],
      userId: row[1],
      kind: row[2] as FactKind,
      key: row[3],
      value: row[4],
      confidence: Number(row[5]),
      source: row[6],
      sourceRef: row[7],
      observedAt: row[8],
    }));
  },
};

/* ----------------------------------------------------------------- facade */

/**
 * Append facts, preferring Databricks and falling back to the dev file.
 *
 * Never throws: losing the write is bad, but failing the upload the student just
 * made is worse. The fallback is reported so the UI can say so out loud.
 */
export async function appendFacts(facts: ProfileFact[]): Promise<AppendResult> {
  const warnings: string[] = [];

  if (hasDatabricks()) {
    try {
      await databricksStore.append(facts);
      return { appended: facts.length, backend: 'databricks', warnings };
    } catch (error) {
      warnings.push(
        `Could not write profile memory to ${TABLE} (${(error as Error).message}). ` +
          'Saved locally instead — the table may not exist yet.',
      );
    }
  } else {
    warnings.push('Databricks is not configured, so profile memory was saved to the local dev store.');
  }

  try {
    await devFileStore.append(facts);
    return { appended: facts.length, backend: 'dev-file', warnings };
  } catch (error) {
    warnings.push(`Local profile memory write also failed: ${(error as Error).message}`);
    return { appended: 0, backend: 'dev-file', warnings };
  }
}

/** Read every fact we hold for a user, newest last. Databricks first, dev fallback. */
export async function readFacts(userId: string): Promise<{ facts: ProfileFact[]; backend: AppendResult['backend'] }> {
  if (hasDatabricks()) {
    try {
      return { facts: await databricksStore.readAll(userId), backend: 'databricks' };
    } catch {
      // Table missing or warehouse asleep — fall through to the dev store.
    }
  }
  return { facts: await devFileStore.readAll(userId), backend: 'dev-file' };
}

/**
 * profile_current semantics: latest fact per key wins. Derived here rather than
 * stored, so the append-only rule stays unbreakable.
 */
export function currentFacts(facts: ProfileFact[]): ProfileFact[] {
  const latest = new Map<string, ProfileFact>();
  for (const fact of facts) {
    const existing = latest.get(fact.key);
    if (!existing || fact.observedAt >= existing.observedAt) latest.set(fact.key, fact);
  }
  return [...latest.values()].sort((a, b) => a.key.localeCompare(b.key));
}

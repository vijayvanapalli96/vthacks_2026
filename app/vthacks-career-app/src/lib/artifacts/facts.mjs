/**
 * facts.mjs — HIREWIRE's answer to career-ops' `getCareerOpsRoot()`.
 *
 * career-ops' fact gate reads two files off a laptop: `cv.md` and
 * `article-digest.md`, joined with a newline into one `sourceText` string that
 * every regex in `verify-cv-facts.mjs` is then run against. There is no schema
 * — the donor's own words are "Sources are NOT a structured object".
 *
 * Our equivalent is 95 rows in `workspace.vthacks_2026.profile_current`, the
 * read view over the append-only `profile_memory`. This module is the adapter,
 * and it is the ONE place where "copy career-ops as-is" was not possible: the
 * detector is liftable verbatim, its input plumbing is not.
 *
 * TWO OUTPUTS, deliberately separate:
 *
 *   `sourceText`  — flattened prose, one fact per line. This is what the fact
 *                   gate compares generated documents against. Flat on purpose:
 *                   the donor's `sourceContainsFact` does whole-token
 *                   containment over one big normalized string, and
 *                   `metricClaims(sourceText)` builds the allowed-number set
 *                   the same way it builds the target's. Giving it structure
 *                   would mean rewriting the detector, and rewriting the
 *                   detector is how you end up with a gate that passes things
 *                   career-ops' gate would have caught.
 *
 *   `structured`  — experience / projects / education / skills / contact,
 *                   reassembled from the dotted fact keys. This is what the
 *                   resume optimizer reorders and what the print view renders.
 *                   It is NOT used for verification.
 *
 * READS ONLY. `profile_memory` is append-only (hard rule 1) and nothing here
 * writes at all — not an INSERT, not an UPDATE. A document generator that
 * silently amended the profile to make its own claims verifiable would defeat
 * the entire point of the gate.
 */

/**
 * @typedef {import('../match/profile.mjs').SqlFn} SqlFn
 *
 * @typedef {{
 *   position: number,
 *   company: string|null,
 *   title: string|null,
 *   dates: string|null,
 *   location: string|null,
 *   bullets: string[],
 * }} ExperienceEntry
 *
 * @typedef {{
 *   name: string|null,
 *   contact: Record<string, string>,
 *   headline: string|null,
 *   summary: string|null,
 *   experience: ExperienceEntry[],
 *   projects: Record<string, string>[],
 *   education: Record<string, string>[],
 *   skills: string[],
 *   courses: string[],
 * }} StructuredProfile
 *
 * @typedef {{
 *   sourceText: string,
 *   factCount: number,
 *   structured: StructuredProfile,
 *   provenance: {fact_key: string, source: string|null, confidence: number|null}[],
 * }} FactSource
 *
 * The match pipeline's profile, as `src/lib/match/profile.mjs` documents its own
 * return. Restated here rather than imported as a `ReturnType` because JSDoc's
 * `typeof import(...)` form is brittle across TS versions and this feature
 * cannot afford a typecheck that breaks on an unrelated upgrade.
 *
 * @typedef {{
 *   userId: string,
 *   email: string|null,
 *   fullName: string|null,
 *   location: string|null,
 *   summary: string,
 *   claimedSkills: string[],
 *   proseText: string,
 *   courses: {course_code: string, title: string|null, skills: string[]}[],
 *   goals: Record<string, unknown>|null,
 *   embedText: string,
 * }} MatchProfile
 */

const FQ = 'workspace.vthacks_2026';

/**
 * Every fact we hold about one student.
 *
 * ORDER MATTERS for `sourceText`: experience bullets before skills before
 * contact, so the text reads like a CV rather than a key dump. It matters
 * because `delegatedAuthorshipClaims` splits the source into STATEMENTS and
 * compares token overlap between them; a source whose sentences are shuffled
 * produces the same statements, but a source whose facts are glued into one
 * line does not, and that is the failure mode to avoid.
 *
 * @param {SqlFn} sql
 * @param {string} userId
 * @returns {Promise<FactSource>}
 */
export async function loadFactSource(sql, userId) {
  const result = await sql(
    `SELECT fact_key, fact_value, source, CAST(confidence AS STRING) AS confidence
       FROM ${FQ}.profile_current
      WHERE user_id = :user_id AND fact_value IS NOT NULL AND TRIM(fact_value) <> ''
      ORDER BY fact_key`,
    [{ name: 'user_id', value: userId }],
  );

  const index = Object.fromEntries(result.columns.map((c, i) => [c, i]));
  /** @type {Map<string, {value: string, source: string|null, confidence: number|null}>} */
  const facts = new Map();
  for (const row of result.rows) {
    const key = String(row[index.fact_key] ?? '');
    if (!key) continue;
    facts.set(key, {
      value: String(row[index.fact_value] ?? '').trim(),
      source: row[index.source] ?? null,
      confidence: row[index.confidence] == null ? null : Number(row[index.confidence]),
    });
  }

  // ── experience.N.{company,title,dates,location,bullet.M} ──────────────────
  /** @type {Map<number, {company: string|null, title: string|null, dates: string|null, location: string|null, bullets: {index: number, text: string}[]}>} */
  const experienceByIndex = new Map();
  const ensureExperience = (n) => {
    if (!experienceByIndex.has(n)) {
      experienceByIndex.set(n, { company: null, title: null, dates: null, location: null, bullets: [] });
    }
    return experienceByIndex.get(n);
  };

  const projects = [];
  const education = [];
  const skills = [];
  const courses = [];
  const contact = {};
  let summary = null;
  let headline = null;

  for (const [key, fact] of facts) {
    let match;
    if ((match = /^experience\.(\d+)\.bullet\.(\d+)$/.exec(key))) {
      ensureExperience(Number(match[1])).bullets.push({ index: Number(match[2]), text: fact.value });
    } else if ((match = /^experience\.(\d+)\.(company|title|dates|location)$/.exec(key))) {
      ensureExperience(Number(match[1]))[match[2]] = fact.value;
    } else if ((match = /^project\.(\d+)\.(\w+)$/.exec(key))) {
      const n = Number(match[1]);
      projects[n] = { ...(projects[n] ?? {}), [match[2]]: fact.value };
    } else if ((match = /^education\.(\d+)\.(\w+)$/.exec(key))) {
      const n = Number(match[1]);
      education[n] = { ...(education[n] ?? {}), [match[2]]: fact.value };
    } else if (key.startsWith('skill.')) {
      skills.push(fact.value);
    } else if (key.startsWith('course.')) {
      courses.push(fact.value);
    } else if (key.startsWith('contact.')) {
      contact[key.slice('contact.'.length)] = fact.value;
    } else if (key === 'summary') {
      summary = fact.value;
    } else if (key === 'headline') {
      headline = fact.value;
    }
  }

  const experience = [...experienceByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([position, entry]) => ({
      position,
      company: entry.company,
      title: entry.title,
      dates: entry.dates,
      location: entry.location,
      bullets: entry.bullets.sort((a, b) => a.index - b.index).map((b) => b.text),
    }));

  // ── sourceText ────────────────────────────────────────────────────────────
  //
  // Phrased so the donor's TRIGGER regexes can see the facts they were written
  // for. This is the subtlest thing in the file and it is worth being explicit
  // about: `factClaims` extracts an employer only after "Worked at", "Joined",
  // "Employer:" or "Company:", and a title only after "Served as", "Worked as",
  // "Title:" or "Role:". Those triggers are matched in the GENERATED document,
  // not here — `sourceContainsFact` only needs the bare value present as a
  // whole token. But writing the source in the same idiom means the two sides
  // normalise identically, and it costs nothing.
  //
  // One fact per line, because a newline is a statement boundary for
  // `delegatedAuthorshipClaims` and `stripMarkup`'s `. ` block rule. Gluing
  // "Founding Engineer" and "Built an ingestion pipeline" onto one line makes
  // the donor's Capitalised-word chaining read "Founding Engineer Built" as a
  // title — a bug its own comments record.
  const lines = [];
  if (contact.name) lines.push(`Name: ${contact.name}`);
  if (contact.location) lines.push(`Location: ${contact.location}`);
  if (headline) lines.push(`Headline: ${headline}`);
  if (summary) lines.push(summary);
  for (const role of experience) {
    if (role.company) lines.push(`Worked at ${role.company}${role.title ? ` as ${role.title}` : ''}${role.dates ? ` (${role.dates})` : ''}.`);
    if (role.title) lines.push(`Title: ${role.title}`);
    if (role.location) lines.push(`Location: ${role.location}`);
    for (const bullet of role.bullets) lines.push(bullet);
  }
  for (const project of projects) {
    if (project?.name) lines.push(`Project: ${project.name}${project.description ? ` — ${project.description}` : ''}`);
  }
  for (const degree of education) {
    if (!degree) continue;
    lines.push(
      `Education: ${[degree.degree, degree.field, degree.school].filter(Boolean).join(', ')}`,
    );
  }
  if (courses.length) lines.push(`Coursework: ${courses.join(', ')}`);
  if (skills.length) lines.push(`Skills: ${skills.join(', ')}`);
  for (const [field, value] of Object.entries(contact)) {
    if (field !== 'name' && field !== 'location') lines.push(`${field}: ${value}`);
  }

  const sourceText = lines.filter(Boolean).join('\n');

  return {
    sourceText,
    factCount: facts.size,
    structured: {
      name: contact.name ?? null,
      contact,
      headline,
      summary,
      experience,
      projects: projects.filter(Boolean),
      education: education.filter(Boolean),
      skills,
      courses,
    },
    /**
     * Provenance, so the UI can say WHERE a fact came from rather than
     * asserting it. Every `profile_memory` row carries `source` and
     * `confidence` (hard rule 1) and throwing that away at the adapter would
     * make the gate's verdicts unexplainable.
     */
    provenance: [...facts.entries()].map(([key, fact]) => ({
      fact_key: key,
      source: fact.source,
      confidence: fact.confidence,
    })),
  };
}

/**
 * Everything in the student's own words, as ONE prose blob — the text the
 * similarity read and the resume optimizer compare a posting against.
 *
 * Deliberately NOT `sourceText`: that one carries `Name:` / `Email:` /
 * `linkedin:` scaffolding lines that exist for the fact gate, and counting
 * "linkedin" as a shared term between a posting and a profile would inflate
 * every overlap score by the same meaningless amount.
 *
 * @param {StructuredProfile} structured
 * @returns {string}
 */
export function proseOf(structured) {
  const parts = [];
  if (structured.headline) parts.push(structured.headline);
  if (structured.summary) parts.push(structured.summary);
  for (const role of structured.experience) {
    parts.push([role.title, role.company].filter(Boolean).join(' at '));
    parts.push(...role.bullets);
  }
  for (const project of structured.projects) {
    if (project?.name) parts.push(project.name);
    if (project?.description) parts.push(project.description);
  }
  if (structured.skills.length) parts.push(structured.skills.join(', '));
  if (structured.courses.length) parts.push(structured.courses.join(', '));
  return parts.filter(Boolean).join('\n');
}

/**
 * Every bullet the student has written, flattened, with the role it belongs to.
 *
 * @param {StructuredProfile} structured
 * @returns {{text: string, bullet_index: number, role: string, company: string|null,
 *            title: string|null, dates: string|null}[]}
 */
export function allBullets(structured) {
  const out = [];
  for (const role of structured.experience) {
    role.bullets.forEach((text, i) => {
      out.push({
        text,
        bullet_index: i,
        role: [role.title, role.company].filter(Boolean).join(' at ') || `role ${role.position}`,
        company: role.company,
        title: role.title,
        dates: role.dates,
      });
    });
  }
  return out;
}

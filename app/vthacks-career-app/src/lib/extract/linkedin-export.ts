/**
 * linkedin-export.ts — the RELIABLE LinkedIn path: the user's own data export.
 *
 * WHY THIS EXISTS. LinkedIn has no public profile API and serves a login wall to
 * anonymous profile requests, so a URL on its own cannot be turned into an
 * experience list (docs/DATA_MODEL.md §4). What the user CAN legitimately hand us
 * is the archive LinkedIn itself produces at
 * *Settings → Data privacy → Get a copy of your data*: a ZIP of CSVs, or the
 * "Save to PDF" profile. It is their data, exported by the platform, no scraping
 * and no ToS problem — and it contains exactly the fields the profile is missing.
 *
 * ZERO MODEL CALLS ON THE CSV PATH, on purpose. These files have a fixed schema, so
 * a parser is both cheaper and more accurate than asking a model to read a
 * spreadsheet. The PDF path still goes through src/lib/extract (Gemini multimodal
 * or Databricks ai_query) because a rendered profile page is a layout problem.
 *
 * FILES ARE IDENTIFIED BY THEIR HEADER ROW, not their name. Users rename downloads,
 * localised exports translate filenames, and a single CSV pasted out of the archive
 * arrives as "Positions (1).csv". The header row is the stable signal.
 *
 * CONNECTIONS ARE READ AND DELIBERATELY NOT STORED. Connections.csv is third-party
 * PII — other people's names, employers and email addresses. It has real use (see
 * career-ops/linkedin-join.mjs, which joins it against a funnel to find warm
 * intros), but it is not this user's profile and nothing here writes it anywhere.
 * We count the rows so the log can say we saw them and left them alone.
 *
 * ---------------------------------------------------------------------------
 * parseCsv() and the header-row search are adapted from career-ops
 * (career-ops/linkedin-join.mjs, v1.33.0) — MIT licensed,
 * © 2026 Santiago Fernández de Valderrama. Copied rather than depended on, per
 * CLAUDE.md: career-ops is a donor repo, not a dependency.
 * ---------------------------------------------------------------------------
 */
import { inflateRawSync } from 'node:zlib';

import {
  emptyProfile,
  type Course,
  type Education,
  type Experience,
  type ExtractedProfile,
  type Project,
  type ProfileLink,
} from './types';

/** What the parser recognised, so the progress log can name it rather than guess. */
export type LinkedInExportResult = {
  profile: ExtractedProfile;
  /** Human-readable names of the sections we understood, e.g. ['Positions', 'Skills']. */
  sections: string[];
  /** Files in the archive we did not recognise. Reported, never silently dropped. */
  unrecognised: string[];
  /** Connections seen. Counted for the log; never stored — third-party PII. */
  connectionsSeen: number;
  warnings: string[];
};

export class LinkedInExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkedInExportError';
  }
}

/* ------------------------------------------------------------------- CSV ---- */

/**
 * Parse CSV text into rows of raw cells. Handles quoted fields, doubled quotes as
 * escapes, and newlines inside quotes — LinkedIn quotes any Position, Company or
 * Description containing a comma ("Director, Strategic Accounts") and Position
 * descriptions routinely span many lines.
 *
 * Adapted from career-ops/linkedin-join.mjs (MIT, © 2026 Santiago Fernández de
 * Valderrama).
 */
export function parseCsv(text: string): string[][] {
  const s = String(text || '').replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (c === '\r' && s[i + 1] === '\n') {
        field += '\n';
        i += 2;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Find the header row AND which section it belongs to, in one pass.
 *
 * LinkedIn's exports open with a free-text "Notes:" preamble whose length the
 * platform has changed before, so the header cannot be at a fixed offset (the lesson
 * career-ops learned the hard way). The obvious fix — a list of column names to look
 * for — fails quietly in two ways I hit while testing: PhoneNumbers.csv
 * ("Extension,Number,Type") shares no column with any other sheet, and Skills.csv is
 * a SINGLE column, so any "a header row has more than one cell" guard throws it away.
 *
 * So rather than guessing at the header and then classifying, each candidate row is
 * offered to the section matchers directly: the first row that some section claims IS
 * the header, and that section is the answer. One rule, no list to keep in sync.
 */
const PREAMBLE_SCAN_LIMIT = 20;

type Detected = { section: Section; rows: Array<Record<string, string>> };

function detect(rows: string[][]): Detected | null {
  const limit = Math.min(rows.length, PREAMBLE_SCAN_LIMIT);

  for (let index = 0; index < limit; index += 1) {
    const header = rows[index].map((cell) => cell.trim().toLowerCase());
    const headers = new Set(header.filter((name) => name !== ''));
    if (headers.size === 0) continue;

    const section = SECTIONS.find((candidate) => candidate.matches(headers));
    if (!section) continue;

    const out: Array<Record<string, string>> = [];
    for (const row of rows.slice(index + 1)) {
      if (row.every((cell) => cell.trim() === '')) continue;
      const record: Record<string, string> = {};
      header.forEach((name, column) => {
        if (name) record[name] = (row[column] ?? '').trim();
      });
      out.push(record);
    }
    return { section, rows: out };
  }

  return null;
}

/* --------------------------------------------------------------- sections ---- */

function blank(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A draft profile built up across however many sections the export contained. */
type Draft = {
  name?: string;
  location?: string;
  summary?: string;
  email?: string;
  phone?: string;
  links: ProfileLink[];
  education: Education[];
  experience: Experience[];
  projects: Project[];
  skills: string[];
  courses: Course[];
  certifications: string[];
  connections: number;
};

type Section = {
  /** Shown in the progress log. */
  label: string;
  /** True when this record shape is the one. Checked in array order. */
  matches: (headers: Set<string>) => boolean;
  apply: (rows: Array<Record<string, string>>, draft: Draft) => void;
};

/**
 * Ordered most-specific first: several LinkedIn CSVs share a "Name" column, so the
 * bare-Name case (Skills.csv) has to be the last resort rather than the first match.
 */
const SECTIONS: Section[] = [
  {
    label: 'Connections',
    matches: (h) => h.has('connected on'),
    // Counted only. Third-party PII: other people's names and employers are not
    // this user's profile and are never written to it.
    apply: (rows, draft) => {
      draft.connections += rows.length;
    },
  },
  {
    label: 'Profile',
    matches: (h) => h.has('first name') && (h.has('headline') || h.has('geo location')),
    apply: (rows, draft) => {
      const row = rows[0];
      if (!row) return;
      const name = [blank(row['first name']), blank(row['last name'])].filter(Boolean).join(' ');
      draft.name ??= blank(name);
      draft.location ??= blank(row['geo location']) ?? blank(row['address']);
      draft.summary ??= blank(row['summary']) ?? blank(row['headline']);
      // "Websites" arrives as [{PERSONAL:https://…},{COMPANY:https://…}] or as a
      // plain list, so URLs are lifted out by pattern rather than by format.
      for (const url of `${row['websites'] ?? ''}`.match(/https?:\/\/[^\s,\]}]+/g) ?? []) {
        draft.links.push({ label: undefined, url });
      }
    },
  },
  {
    label: 'Positions',
    matches: (h) => h.has('company name') && h.has('title'),
    apply: (rows, draft) => {
      for (const row of rows) {
        draft.experience.push({
          company: blank(row['company name']),
          title: blank(row['title']),
          startDate: blank(row['started on']),
          endDate: blank(row['finished on']),
          location: blank(row['location']),
          // One description field, not a bullet list. Split on newlines so a
          // multi-line description reads as the bullets the user wrote.
          bullets: (row['description'] ?? '')
            .split(/\r?\n+/)
            .map((line) => line.replace(/^[\s•\-*·]+/, '').trim())
            .filter((line) => line !== ''),
        });
      }
    },
  },
  {
    label: 'Education',
    matches: (h) => h.has('school name'),
    apply: (rows, draft) => {
      for (const row of rows) {
        draft.education.push({
          school: blank(row['school name']),
          degree: blank(row['degree name']),
          field: undefined,
          startDate: blank(row['start date']),
          endDate: blank(row['end date']),
          gpa: undefined,
        });
      }
    },
  },
  {
    label: 'Certifications',
    matches: (h) => h.has('name') && h.has('authority'),
    apply: (rows, draft) => {
      for (const row of rows) {
        const name = blank(row['name']);
        if (!name) continue;
        const issuer = blank(row['authority']);
        draft.certifications.push(issuer ? `${name} (${issuer})` : name);
      }
    },
  },
  {
    label: 'Projects',
    matches: (h) => h.has('title') && h.has('description'),
    apply: (rows, draft) => {
      for (const row of rows) {
        draft.projects.push({
          name: blank(row['title']),
          description: blank(row['description']),
          tech: [],
        });
      }
    },
  },
  {
    label: 'Email addresses',
    matches: (h) => h.has('email address'),
    apply: (rows, draft) => {
      // Prefer the primary address; LinkedIn marks it "Yes".
      const primary = rows.find((row) => /^yes$/i.test(row['primary'] ?? ''));
      draft.email ??= blank((primary ?? rows[0])?.['email address']);
    },
  },
  {
    label: 'Phone numbers',
    matches: (h) => h.has('number') && h.has('extension'),
    apply: (rows, draft) => {
      draft.phone ??= blank(rows[0]?.['number']);
    },
  },
  {
    label: 'Courses',
    matches: (h) => h.has('name') && h.has('number'),
    apply: (rows, draft) => {
      for (const row of rows) {
        // LinkedIn's "Number" is the course code ("CS 3214") and "Name" the title.
        draft.courses.push({ code: blank(row['number']), title: blank(row['name']) });
      }
    },
  },
  {
    label: 'Languages',
    matches: (h) => h.has('name') && h.has('proficiency'),
    apply: (rows, draft) => {
      for (const row of rows) {
        const name = blank(row['name']);
        if (name) draft.skills.push(name);
      }
    },
  },
  {
    // Last resort: Skills.csv is a single "Name" column, which every other
    // Name-bearing section above has already had its chance to claim.
    label: 'Skills',
    matches: (h) => h.has('name'),
    apply: (rows, draft) => {
      for (const row of rows) {
        const name = blank(row['name']);
        if (name) draft.skills.push(name);
      }
    },
  },
];

/* -------------------------------------------------------------------- zip ---- */

/**
 * Read a ZIP archive's members, without a dependency.
 *
 * LinkedIn hands the export over as a single ZIP, so refusing to open one would
 * make the reliable path only reliable for people who already unzipped it and then
 * guessed which of fifteen CSVs mattered. Node ships the only hard part (raw
 * DEFLATE), so the rest is reading the central directory.
 *
 * Sizes come from the CENTRAL directory, not the local header: when a writer
 * streams, the local header carries zeroes and the real sizes live in a data
 * descriptor after the payload.
 */
export function unzip(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);

  // End of central directory: fixed 22 bytes plus a comment of up to 64 KB, so it
  // is found by scanning backwards for its signature.
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= 0; i -= 1) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new LinkedInExportError('That does not look like a ZIP archive.');

  const count = u16(eocd + 10);
  let cursor = u32(eocd + 16);
  if (cursor === 0xffffffff) {
    throw new LinkedInExportError('That ZIP uses the ZIP64 format, which this reader cannot open.');
  }

  const out: Array<{ name: string; data: Uint8Array }> = [];

  for (let entry = 0; entry < count; entry += 1) {
    if (cursor + 46 > bytes.byteLength || u32(cursor) !== 0x02014b50) break;

    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const compressedSize = u32(cursor + 20);
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    const name = Buffer.from(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).toString('utf-8');
    cursor += 46 + nameLength + extraLength + commentLength;

    // Bit 0 is the "encrypted" flag. Nothing here can read an encrypted member and
    // returning empty bytes would look like an empty file.
    if (flags & 0x0001) {
      throw new LinkedInExportError(`"${name}" inside that ZIP is password-protected.`);
    }
    if (name.endsWith('/')) continue;

    if (u32(localOffset) !== 0x04034b50) continue;
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);

    if (method === 0) {
      out.push({ name, data: raw });
    } else if (method === 8) {
      out.push({ name, data: new Uint8Array(inflateRawSync(Buffer.from(raw))) });
    } else {
      throw new LinkedInExportError(
        `"${name}" inside that ZIP uses compression method ${method}, which this reader cannot open.`,
      );
    }
  }

  return out;
}

/* ------------------------------------------------------------------- parse ---- */

export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.byteLength > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Turn a LinkedIn data export — one CSV, or the whole ZIP — into a profile.
 *
 * Never throws for a file it merely does not understand: an unrecognised member is
 * reported in `unrecognised` and the rest is still parsed. It throws only when the
 * container itself cannot be opened, which is a different message to the user
 * ("unzip it yourself") than "I read 9 of your 11 files".
 */
export function parseLinkedInExport(bytes: Uint8Array, fileName?: string): LinkedInExportResult {
  const members = looksLikeZip(bytes)
    ? unzip(bytes)
    : [{ name: fileName ?? 'export.csv', data: bytes }];

  const draft: Draft = {
    links: [],
    education: [],
    experience: [],
    projects: [],
    skills: [],
    courses: [],
    certifications: [],
    connections: 0,
  };

  const sections: string[] = [];
  const unrecognised: string[] = [];
  const warnings: string[] = [];

  for (const member of members) {
    const name = basename(member.name);
    // __MACOSX resource forks and other archive noise, not user data.
    if (name.startsWith('.') || name.startsWith('__')) continue;
    if (!/\.csv$/i.test(name)) {
      unrecognised.push(name);
      continue;
    }

    const detected = detect(parseCsv(Buffer.from(member.data).toString('utf-8')));
    if (!detected) {
      unrecognised.push(name);
      continue;
    }

    // A recognised-but-empty sheet (everyone has some of those) is not a section we
    // learned anything from, so it is not claimed in the log either.
    if (detected.rows.length === 0) continue;

    detected.section.apply(detected.rows, draft);
    if (!sections.includes(detected.section.label)) sections.push(detected.section.label);
  }

  if (sections.length === 0) {
    warnings.push('No LinkedIn export section was recognised in that file.');
  }

  const profile: ExtractedProfile = {
    ...emptyProfile(),
    name: draft.name,
    email: draft.email,
    phone: draft.phone,
    location: draft.location,
    summary: draft.summary,
    links: draft.links,
    education: draft.education,
    experience: draft.experience,
    projects: draft.projects,
    skills: dedupeStrings(draft.skills),
    courses: draft.courses,
    certifications: dedupeStrings(draft.certifications),
  };

  return {
    profile,
    sections,
    unrecognised,
    connectionsSeen: draft.connections,
    warnings,
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Names the parser puts on results, so provenance strings stay stable. */
export const LINKEDIN_EXPORT_MODEL = 'linkedin-export-csv';

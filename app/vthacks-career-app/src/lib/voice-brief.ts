/**
 * voice-brief.ts — THE DATA EGRESS BOUNDARY. Read this before adding a field.
 *
 * Everything this file returns is sent to ElevenLabs, which means it is sent to a
 * third party, transcribed, logged there, and read out loud in a room that may have
 * other people in it. So the rule is not "avoid obvious secrets", it is:
 *
 *   NOTHING LEAVES EXCEPT WHAT IS NAMED HERE.
 *
 * Job titles, company names, match scores, skill names, the reason sentence the
 * match agent already wrote: fine, and the whole point. Email, phone, street
 * address, resume text, transcript PDFs, anything under `contact.*`: never, on any
 * page, for any reason.
 *
 * WHY A PROJECTION AND NOT A REDACTION. The tempting implementation is
 * `JSON.stringify(profile)` with a blocklist over the top. That fails the first time
 * somebody adds a column, because a blocklist defaults to LEAKING and only a
 * whitelist defaults to SILENCE. So `toMatchBrief()` names its eleven fields one at
 * a time, in the same idiom as the `FIELDS` table in voice.ts: an unknown key on the
 * way in cannot reach the way out, because there is no code path that copies it.
 *
 * `containsContactPii()` at the bottom is the second wall, not the first. The route
 * reads the signed-in user's own email and phone, never puts them in the payload,
 * and then asserts they do not appear in the finished string anyway. If that ever
 * fires, the payload is dropped rather than sent. A wall you never touch is cheap;
 * a leak is not recoverable, because you cannot un-say a phone number.
 *
 * DELIBERATELY DEPENDENCY-FREE. No imports at all — not even type-only ones — so
 * `node --test` can load this file directly (Node strips the types) and the egress
 * test needs no bundler, no warehouse, and no network. A boundary whose test is hard
 * to run is a boundary nobody re-runs.
 */

/* ------------------------------------------------------------------ the shapes */

/**
 * One match, reduced to what may be spoken.
 *
 * `location` here is the JOB's location, which is public information printed on the
 * posting. It is NOT `profiles.location`, which is where the human lives and is not
 * in this type on purpose.
 */
export type MatchBrief = {
  job_id: string;
  title: string;
  company: string;
  /** 0-100. The match agent's overall_score. */
  score: number;
  /** The explanation written at match time. Hard rule 4: never render without it. */
  reason: string;
  matched_skills: string[];
  missing_skills: string[];
  location: string | null;
  recommendation: string | null;
  eligibility: string | null;
  eligibility_reason: string | null;
};

export type PageMeaning = {
  /** Short human name the agent says out loud. */
  page_name: string;
  /** One factual sentence about what this page is for. */
  purpose: string;
  /** What the agent may offer to do from here, in plain language. */
  can: string[];
};

export type PageBriefInput = {
  path: string;
  meaning: PageMeaning;
  matches: MatchBrief[];
  /** The match the current path is about, when the path names one. */
  focusJob: MatchBrief | null;
  /** True when there is no cached match run inside the TTL. */
  stale: boolean;
  /** Outstanding intake questions, so the agent knows whether to go back to them. */
  gapsRemaining: number;
};

export type PageBrief = {
  path: string;
  page_name: string;
  /** The text handed to sendContextualUpdate(). Audited, allow-listed, PII-free. */
  brief: string;
  /** Up to ten, for the PANEL. Show ten. */
  matches: MatchBrief[];
  /** Names at most three. Speak three. Null when there is nothing to volunteer. */
  spoken_summary: string | null;
  focus_job: MatchBrief | null;
  can: string[];
  stale: boolean;
  gaps_remaining: number;
};

/* ------------------------------------------------------- what a page IS, server-side */

/**
 * Page meaning comes from this table and not from parsing the URL in the browser.
 *
 * The browser knows the pathname; it does not know what the pathname MEANS, and a
 * client that guesses ("the word jobs is in it, so…") drifts the moment a route is
 * renamed. Keeping it here means the agent's idea of the app and the app's idea of
 * itself are the same literal.
 *
 * Longest match wins, so `/applicant/intake/resume` beats `/applicant/intake`.
 *
 * THE THIRD ELEMENT MATTERS. `'prefix'` also covers child routes, which is what makes
 * `/applicant/jobs/<jobId>` describe itself as the match list. `'exact'` does not — and
 * `/applicant` is exact ON PURPOSE. With it as a prefix, a route somebody adds next
 * hour (`/applicant/offers`, say) would be described confidently as "the dashboard:
 * intake progress, the match queue…", which is worse than silence. Exact means an
 * unrecognised page falls to UNKNOWN_PAGE, whose purpose string tells the agent not to
 * describe what it has not been told about.
 */
const PAGES: Array<[string, PageMeaning, 'exact' | 'prefix']> = [
  [
    '/applicant/jobs',
    {
      page_name: 'the match list',
      purpose:
        'This page lists the roles the match agent scored for this student, best first, each with the reason it scored that way.',
      can: [
        'read out the strongest three matches',
        'explain why one of them scored the way it did',
        'reload the matches',
        'open one of them',
        'save one of them, or mark one applied, interviewing or rejected',
      ],
    },
    'prefix',
  ],
  [
    '/applicant/apply',
    {
      page_name: 'the approval page',
      purpose:
        'This is the human-confirm step. Nothing is sent to an employer until the student reads this page and approves it themselves.',
      can: [
        'explain what the page is asking them to approve',
        'explain why this role matched',
      ],
    },
    'prefix',
  ],
  [
    '/applicant/pipeline',
    {
      page_name: 'the application pipeline',
      purpose:
        'This page shows every role the student has saved, applied to, or heard back about, in stage order.',
      can: ['change the stage of a role', 'open a role', 'read out the strongest matches'],
    },
    'prefix',
  ],
  [
    '/applicant/profile',
    {
      page_name: 'the profile page',
      purpose:
        'This page shows everything the system has recorded about the student and where each fact came from.',
      can: ['answer any outstanding profile question', 'read out the strongest matches'],
    },
    'prefix',
  ],
  [
    '/applicant/activity',
    {
      page_name: 'the activity log',
      purpose: 'This page is the audit trail of what the system has done on the student behalf.',
      can: ['explain a recent action', 'read out the strongest matches'],
    },
    'prefix',
  ],
  [
    '/applicant/intake/resume',
    {
      page_name: 'resume upload',
      purpose: 'The student is uploading a resume so the system can read their skills and coursework out of it.',
      can: ['answer outstanding profile questions while they wait'],
    },
    'prefix',
  ],
  [
    '/applicant/intake/linkedin',
    {
      page_name: 'LinkedIn import',
      purpose: 'The student is importing a LinkedIn export so the system can read their history out of it.',
      can: ['answer outstanding profile questions while they wait'],
    },
    'prefix',
  ],
  [
    '/applicant/intake',
    {
      page_name: 'intake',
      purpose: 'The student is handing over the documents the profile is built from.',
      can: ['answer outstanding profile questions'],
    },
    'prefix',
  ],
  [
    '/applicant',
    {
      page_name: 'the dashboard',
      purpose:
        'The dashboard: intake progress, the match queue, and the verification state of each employer.',
      can: [
        'read out the strongest three matches',
        'reload the matches',
        'open a role',
        'save a role',
        'answer any outstanding profile question',
      ],
    },
    'exact',
  ],
  [
    '/employer',
    {
      page_name: 'the employer side',
      purpose: 'This is the employer-facing area. The student assistant has nothing to do here.',
      can: [],
    },
    'prefix',
  ],
  [
    '/',
    {
      page_name: 'the home page',
      purpose: 'The marketing home page. The student may not be signed in yet.',
      can: [],
    },
    'exact',
  ],
];

const UNKNOWN_PAGE: PageMeaning = {
  page_name: 'a page I do not have a description for',
  purpose:
    'I do not have a description of this page, so do not describe it. Say you are not sure what is on screen and ask.',
  can: [],
};

/** Normalise a client-supplied path to something safe to look up and to echo. */
export function normalizePath(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  // Query and hash dropped: they can carry arbitrary text and none of the meaning
  // above depends on them. The job id travels as its own parameter, validated.
  const withoutQuery = raw.split('?')[0].split('#')[0].trim();
  if (!withoutQuery.startsWith('/')) return '/';
  // Length-capped and character-restricted because this string is echoed back into
  // the brief the model reads. `%` is allowed because a job id is a URL (see
  // safeJobId) and so arrives percent-encoded when it travels as a path segment.
  const clipped = withoutQuery.slice(0, 600);
  return /^[A-Za-z0-9/_\-.[\]%]*$/.test(clipped) ? clipped || '/' : '/';
}

/**
 * A job id, validated. Returns null rather than a repaired string.
 *
 * READ THIS BEFORE TIGHTENING IT. `job_id` in this system is THE FULL POSTING URL —
 * `https://app.careerpuck.com/job-board/lyft/job/8806570002?gh_jid=8806570002` — because
 * it is derived deterministically from the URL so a job is stored exactly once (hard
 * rule 2). The first version of this validator assumed a short slug
 * (`^[A-Za-z0-9_\-.]+$`), which rejected every real id in the warehouse: `?job=` never
 * resolved, focus context never appeared, and the audit rows logged a null job. It all
 * failed quietly, because "no focus job" is also what a legitimate non-job page returns.
 *
 * So the character set is RFC 3986 minus the quotes and angle brackets that would let a
 * value break out of the surrounding prose or markup. Whitespace is excluded outright.
 */
const JOB_ID_CHARS = /^[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/;

export function safeJobId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 400) return null;
  return JOB_ID_CHARS.test(trimmed) ? trimmed : null;
}

export function pageMeaning(path: string): PageMeaning {
  const normalized = normalizePath(path);
  let best: PageMeaning | null = null;
  let bestLength = -1;
  for (const [prefix, meaning, mode] of PAGES) {
    const matches =
      normalized === prefix || (mode === 'prefix' && normalized.startsWith(`${prefix}/`));
    if (matches && prefix.length > bestLength) {
      best = meaning;
      bestLength = prefix.length;
    }
  }
  return best ?? UNKNOWN_PAGE;
}

/**
 * `/applicant/jobs/<jobId>` names one role.
 *
 * A job id is a URL, so in a path segment it is percent-encoded and has to be decoded
 * before it will match anything in the cached run. The decode is wrapped because
 * `decodeURIComponent('%zz')` throws, and a malformed path is "no job", not a 500.
 */
export function jobIdFromPath(path: string): string | null {
  const normalized = normalizePath(path);
  const match = /^\/applicant\/jobs\/([^/]{1,400})$/.exec(normalized);
  if (!match) return null;
  try {
    return safeJobId(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- the projection */

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function optionalText(value: unknown, max: number): string | null {
  const cleaned = text(value, max);
  return cleaned ? cleaned : null;
}

function skillList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    // A skill name is a short noun phrase. Anything longer is not a skill, it is a
    // sentence that got into the wrong column — and a sentence is exactly the shape
    // free-text PII arrives in. So it is DROPPED, not truncated: truncating a leaked
    // sentence to 60 characters leaks the first 60 characters, which for
    // "Name — email@example.com — phone" is the whole of it. The earlier version of
    // this function clipped first and then length-checked the clipped string, so the
    // check could never fail; a test caught it.
    const raw = typeof item === 'string' ? item.trim() : '';
    if (!raw || raw.length > 60) continue;
    const cleaned = text(raw, 60);
    if (cleaned && out.length < max) out.push(cleaned);
  }
  return out;
}

/**
 * ELEVEN FIELDS, NAMED ONE AT A TIME. This is the allow-list.
 *
 * `raw` is whatever `/api/match`'s contract produced — a wide object with more
 * columns than belong in a sentence. Nothing is spread, nothing is iterated, and
 * nothing is copied by key, so a column added upstream is invisible here until
 * somebody adds a line to this function on purpose.
 */
export function toMatchBrief(raw: unknown): MatchBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;

  // NOT truncated. A job id is a posting URL; clipping one to a length limit would
  // produce a plausible string that matches nothing in the cached run, and every
  // downstream resolution would refuse for a reason that was not true.
  const job_id = safeJobId(row.job_id);
  if (!job_id) return null;

  const rawScore = Number(row.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;

  return {
    job_id,
    title: text(row.title, 140) || 'an untitled role',
    company: text(row.company, 120) || 'an unnamed company',
    score,
    // Written by the match agent at match time about the JOB and the student's
    // SKILLS. Capped because it is read aloud, not because it is suspect.
    reason: text(row.reason, 600),
    matched_skills: skillList(row.matched_skills, 12),
    missing_skills: skillList(row.missing_skills, 12),
    location: optionalText(row.location, 120),
    recommendation: optionalText(row.recommendation, 40),
    eligibility: optionalText(row.eligibility, 40),
    eligibility_reason: optionalText(row.eligibility_reason, 300),
  };
}

export function toMatchBriefs(rows: unknown, limit = 10): MatchBrief[] {
  if (!Array.isArray(rows)) return [];
  const out: MatchBrief[] = [];
  for (const row of rows) {
    const brief = toMatchBrief(row);
    if (brief) out.push(brief);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ the prose */

function percent(score: number): string {
  return `${score}%`;
}

/**
 * SPEAK THREE, SHOW TEN.
 *
 * A voice reading ten job titles is unusable — by the fourth the listener has lost
 * the first, and they cannot scroll back. Three is what a person holds. The other
 * seven are in the panel, on screen, with their scores and their reasons.
 */
export function spokenSummary(matches: MatchBrief[]): string | null {
  if (matches.length === 0) return null;
  const top = matches.slice(0, 3);
  const named = top
    .map((match) => `${match.title} at ${match.company}, ${percent(match.score)}`)
    .join('; ');
  const rest =
    matches.length > top.length
      ? ` There are ${matches.length - top.length} more on screen with their scores.`
      : '';
  return `The strongest ${top.length === 1 ? 'match is' : `${top.length} are`}: ${named}.${rest}`;
}

/**
 * The contextual update. One factual paragraph, no instructions to the user, no
 * speculation, and no field that is not in MatchBrief.
 */
export function buildPageBrief(input: PageBriefInput): PageBrief {
  const path = normalizePath(input.path);
  const matches = input.matches.slice(0, 10);
  const summary = spokenSummary(matches);

  const lines: string[] = [];
  lines.push(`CURRENT PAGE: ${input.meaning.page_name} (${path}). ${input.meaning.purpose}`);

  if (input.meaning.can.length) {
    lines.push(`FROM HERE YOU CAN: ${input.meaning.can.join('; ')}.`);
  }

  if (input.focusJob) {
    const job = input.focusJob;
    const bits = [
      `THE ROLE ON SCREEN: ${job.title} at ${job.company}${job.location ? ` (${job.location})` : ''}, scored ${percent(job.score)}.`,
    ];
    if (job.reason) bits.push(`Why it scored that: ${job.reason}`);
    if (job.matched_skills.length) bits.push(`Skills they want that the student has: ${job.matched_skills.join(', ')}.`);
    if (job.missing_skills.length) bits.push(`Skills they want that the student does not have on file: ${job.missing_skills.join(', ')}.`);
    if (job.eligibility && job.eligibility !== 'pass' && job.eligibility_reason) {
      bits.push(`Eligibility flag: ${job.eligibility} — ${job.eligibility_reason}`);
    }
    bits.push(`Its job_id is ${job.job_id}; use that exact string in tool calls.`);
    lines.push(bits.join(' '));
  }

  if (input.stale) {
    lines.push(
      'MATCHES: there is no recent match run for this student, so you have nothing to read out. Offer to reload the matches; say that it takes up to a minute.',
    );
  } else if (summary) {
    lines.push(`MATCHES (${matches.length} on screen, newest run): ${summary}`);
    lines.push(
      `MATCH IDS, for tool calls only — never read an id out loud: ${matches
        .map((match, index) => `${index + 1}=${match.job_id}`)
        .join(', ')}`,
    );
  } else {
    lines.push('MATCHES: the last run returned nothing. Do not invent roles.');
  }

  lines.push(
    input.gapsRemaining > 0
      ? `OUTSTANDING PROFILE QUESTIONS: ${input.gapsRemaining}. Only go back to them if the student has nothing else they want.`
      : 'OUTSTANDING PROFILE QUESTIONS: none.',
  );

  return {
    path,
    page_name: input.meaning.page_name,
    brief: lines.join('\n'),
    matches,
    spoken_summary: summary,
    focus_job: input.focusJob,
    can: input.meaning.can,
    stale: input.stale,
    gaps_remaining: input.gapsRemaining,
  };
}

/* ------------------------------------------------------------------- resolution */

/**
 * ORDINAL WORDS ONLY. The cardinals are deliberately absent, and the test that found
 * this is worth keeping in mind: with `one: 1` in this table, "the Stripe one" resolved
 * by ORDINAL — the word "one" — and landed on position 1. It happened to be Stripe, so
 * it looked correct. "The Workday one" resolved to position 1 as well, and returned a
 * Stripe job for a company the student had no match at.
 *
 * That is the exact failure this whole module exists to prevent, and it was produced by
 * being generous with synonyms. "The second one" is what people say; "one" meaning
 * first is not, and "the first one" is caught by the top/best/first regex below.
 */
const ORDINALS: Record<string, number> = {
  first: 1, '1st': 1,
  second: 2, '2nd': 2,
  third: 3, '3rd': 3,
  fourth: 4, '4th': 4,
  fifth: 5, '5th': 5,
  sixth: 6, '6th': 6,
  seventh: 7, '7th': 7,
  eighth: 8, '8th': 8,
  ninth: 9, '9th': 9,
  tenth: 10, '10th': 10,
};

export type Resolution =
  | { ok: true; match: MatchBrief; how: 'job_id' | 'ordinal' | 'name' | 'top' }
  | { ok: false; reason: string };

/**
 * Resolve a spoken job reference against a list of matches, or refuse.
 *
 * LIVES IN THIS FILE, WHICH HAS NO IMPORTS, SO THERE IS ONE COPY. The server routes
 * call it to decide where the browser is allowed to navigate; the browser calls it to
 * decide which stored reason sentence to read back. Two implementations of "which job
 * did they mean" would eventually disagree, and the disagreement would look like the
 * agent opening one job while explaining another.
 *
 * Four ways in, in order of how certain each is:
 *
 *  - an exact job_id, which is what the contextual update hands the agent;
 *  - an ordinal, because "the second one" is what a person actually says. Note that
 *    this is resolved against THE LIST THE AGENT WAS JUST GIVEN, not by searching the
 *    corpus — "the second one" is meaningless against 16k postings and precise
 *    against ten;
 *  - a company or title substring, for "the Stripe one";
 *  - "the top one" / "the best one" / nothing, meaning rank 1.
 *
 * A NEAR MISS IS NOT ACCEPTED. No edit distance, no closest-company fallback, and an
 * ambiguous substring refuses instead of picking. A wrong job that looks right is the
 * exact failure this function exists to prevent, and it is invisible until somebody
 * approves an application on the wrong page.
 */
export function resolveJobRef(matches: MatchBrief[], rawRef: unknown): Resolution {
  if (matches.length === 0) {
    return {
      ok: false,
      reason:
        'I do not have a current list of matches to pick from, so I will not guess at a job. Say "reload my matches" and I will run it.',
    };
  }

  const ref = typeof rawRef === 'string' ? rawRef.trim().slice(0, 200) : '';

  if (!ref || /^(the )?(top|best|first|strongest)( one| match)?$/i.test(ref)) {
    return { ok: true, match: matches[0], how: 'top' };
  }

  // 1. An exact id. Case-sensitive on purpose: job_id is a derived key, not prose.
  const byId = matches.find((match) => match.job_id === ref);
  if (byId) return { ok: true, match: byId, how: 'job_id' };

  const lower = ref.toLowerCase();
  const words = lower.replace(/[^a-z0-9]+/g, ' ').trim().split(' ');

  // 2. An ORDINAL WORD, against the list the agent was just given.
  for (const word of words) {
    const position = ORDINALS[word];
    if (position !== undefined && position <= matches.length) {
      return { ok: true, match: matches[position - 1], how: 'ordinal' };
    }
  }

  // 3. A company or title substring. Exactly one hit, or it is ambiguous and we refuse
  //    rather than choose for them. This runs BEFORE bare digits because a company name
  //    can contain a number and a substring hit is the more specific signal.
  const needle = lower
    .replace(/\b(the|one|ones|role|job|position|at|open|opening|that|this)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (needle.length >= 3) {
    const hits = matches.filter(
      (match) =>
        match.company.toLowerCase().includes(needle) || match.title.toLowerCase().includes(needle),
    );
    if (hits.length === 1) return { ok: true, match: hits[0], how: 'name' };
    if (hits.length > 1) {
      return {
        ok: false,
        reason: `More than one of your matches fits "${ref}" — ${hits
          .slice(0, 3)
          .map((hit) => `${hit.title} at ${hit.company}`)
          .join(', ')}. Tell me which by its position in the list and I will open it.`,
      };
    }
  }

  // 4. A bare digit, last, for "number 3" and for a transcription that dropped the
  //    "-rd". Out of range falls through to the refusal rather than clamping: clamping
  //    would silently turn "the fifteenth" into the tenth.
  for (const word of words) {
    if (/^\d{1,2}$/.test(word)) {
      const position = Number(word);
      if (position >= 1 && position <= matches.length) {
        return { ok: true, match: matches[position - 1], how: 'ordinal' };
      }
    }
  }

  return {
    ok: false,
    reason: `"${ref}" is not one of your current matches, so I am not going to open anything — I would only be guessing. Your list has ${matches.length} roles; ask me to read the top three, or say a position in the list.`,
  };
}

/**
 * The stored explanation, read back. ZERO model calls, by construction.
 *
 * Every sentence below was written by the match agent at match time and stored on the
 * row. Nothing here generates prose about the job; it arranges prose that already
 * exists. That is why "why am I a good fit for this role" is free, and it is also why
 * the spoken answer and the match list cannot contradict each other — they are the
 * same string.
 */
export function explainMatch(match: MatchBrief): string {
  const parts: string[] = [
    `${match.title} at ${match.company} scored ${percent(match.score)}.`,
  ];
  if (match.reason) parts.push(match.reason);
  if (match.matched_skills.length) {
    parts.push(`What lines up: ${match.matched_skills.slice(0, 6).join(', ')}.`);
  }
  if (match.missing_skills.length) {
    parts.push(`What they ask for that is not on your profile: ${match.missing_skills.slice(0, 6).join(', ')}.`);
  }
  if (match.eligibility && match.eligibility !== 'pass' && match.eligibility_reason) {
    parts.push(`One flag: ${match.eligibility_reason}`);
  }
  if (parts.length === 1) {
    parts.push('The run did not store a reason for this one, so I have nothing to justify the score with.');
  }
  return parts.join(' ');
}

/* --------------------------------------------------------------- the second wall */

/**
 * Does this text contain contact PII?
 *
 * Two mechanisms, because they catch different failures:
 *
 *  - SHAPE. An email address and a phone number have a shape, so a value that got
 *    into a job title or a reason sentence upstream is caught even though nobody
 *    knew it was there. This is the case the allow-list cannot see.
 *  - IDENTITY. The caller passes the signed-in user's own email and phone, read
 *    server-side and never put in the payload. If one of them appears anyway, some
 *    code path we did not audit copied it.
 *
 * Deliberately NOT checking the user's name or city. `known_name` is already part of
 * the pre-existing session payload (the agent has to address the student somehow),
 * and a job's location legitimately equals the student's city — asserting on those
 * would produce false positives that teach people to switch the assertion off, which
 * is worse than not having it.
 */
const EMAIL_SHAPE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/**
 * URLs are removed before the phone scan, and ONLY before the phone scan.
 *
 * THIS IS THE FALSE POSITIVE THAT ALMOST KILLED THE FEATURE. A `job_id` in this system
 * is the posting URL, and ATS job numbers are ten digits:
 * `.../lyft/job/8806570002?gh_jid=8806570002`. The original phone rule was "seven or
 * more digits with optional separators", which that satisfies — so the guard fired on
 * every real brief, blanked the match list, and the agent went quiet with nothing but a
 * server log line to say why. The end-to-end smoke run caught it; the unit test could
 * not, because its fixtures used tidy slug ids and every real id is a URL.
 *
 * A guard that fires on legitimate data is worse than no guard, because the next person
 * switches it off. Posting URLs are public and are not phone numbers, so they are taken
 * out of the phone pass. They are NOT taken out of the email pass — `mailto:` and a query
 * parameter carrying an address are exactly how one would hide inside a URL.
 */
const URLISH = /https?:\/\/\S+/gi;

/**
 * What survives the strip has to look like a phone number a human wrote, not merely a
 * long number: separated forms, an explicitly international +15405550134, or a bare
 * 10-11 digit run — and that last one is only safe BECAUSE the URLs are gone.
 */
const PHONE_SHAPES = [
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/,
  /\+\d{10,14}(?!\d)/,
  /(?<!\d)\d{10,11}(?!\d)/,
];

/**
 * EVERYTHING THAT CAN REACH ELEVENLABS FROM ONE BRIEF, as a single string.
 *
 * Not just `brief`. The reason sentences on the match rows do not appear in `brief`
 * (only the focused job's does), but they DO leave the browser later: `explain_match`
 * reads one aloud, and the panel is handed all ten. A guard that only checked `brief`
 * would have passed a reason sentence containing an email straight through — the first
 * version did, and the test caught it.
 *
 * So the route and the test both call this, and neither maintains its own idea of the
 * surface. Two definitions of "what leaves" is how the second one ends up smaller.
 */
export function egressSurface(brief: PageBrief): string {
  return [
    brief.brief,
    brief.spoken_summary ?? '',
    ...brief.matches.map(
      (match) =>
        `${match.title} ${match.company} ${match.location ?? ''} ${match.reason} ` +
        `${match.matched_skills.join(' ')} ${match.missing_skills.join(' ')} ` +
        `${match.recommendation ?? ''} ${match.eligibility_reason ?? ''}`,
    ),
    brief.focus_job ? explainMatch(brief.focus_job) : '',
  ].join('\n');
}

export function containsContactPii(
  text: string,
  known: { email?: string | null; phone?: string | null } = {},
): string | null {
  if (EMAIL_SHAPE.test(text)) return 'an email address';

  const withoutUrls = text.replace(URLISH, ' ');
  for (const shape of PHONE_SHAPES) {
    if (shape.test(withoutUrls)) return 'something shaped like a phone number';
  }

  const haystack = text.toLowerCase();
  const email = (known.email ?? '').trim().toLowerCase();
  if (email.length > 4 && haystack.includes(email)) return "the student's email address";

  // Identity, on the URL-stripped text for the same reason: once the separators are
  // gone, the digits of a ten-digit ATS id can collide with the digits of a phone
  // number, and a guard that cries wolf is a guard that gets deleted.
  const digits = (known.phone ?? '').replace(/\D/g, '');
  if (digits.length >= 7 && withoutUrls.replace(/\D/g, '').includes(digits)) {
    return "the student's phone number";
  }

  return null;
}

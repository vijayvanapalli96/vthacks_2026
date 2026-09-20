/**
 * screening.mjs — what an employer agent actually asks before it says yes.
 *
 * The employer agent used to verify the signature, score the skills and answer
 * "accepted" to everything that passed. That is a handshake, not a screen: it
 * never asked for a document and never told the candidate what it still needed.
 *
 * This turns the one-shot into a real check against the ROLE'S OWN PREREQUISITES.
 * Two things come out of it: what the employer is missing, and a decision it can
 * defend in a sentence.
 *
 * EVERY REQUEST NAMES ITS REASON. "Send your resume" is a demand; "the posting
 * requires Python and the packet evidences SQL only, so send the resume so a
 * human can check" is a reason. Hard rule 4 is about the Trust Index, but the
 * principle is the same one: a decision without a reason is a bug here too.
 *
 * IT NEVER INFERS AN ANSWER IT WAS NOT GIVEN. A skill absent from the packet is
 * absent, not "probably known". The employer asks; it does not assume.
 */

/** Fields an employer may ask for. Anything else is refused by the applicant agent. */
export const REQUESTABLE = new Set(['resume_url', 'cover_letter', 'skills', 'availability']);

/**
 * Screen one application against one posting.
 *
 * @param {{ candidate?: Record<string, unknown>, job?: Record<string, unknown>, match?: object }} input
 */
export function screen({ candidate = {}, job = {}, match = null }) {
  const required = clean(job.required_skills);
  const preferred = clean(job.preferred_skills);
  const known = new Set(clean(candidate.skills).map((skill) => skill.toLowerCase()));

  const missingRequired = required.filter((skill) => !known.has(skill.toLowerCase()));
  const evidencedRequired = required.filter((skill) => known.has(skill.toLowerCase()));
  const hasResume = typeof candidate.resume_url === 'string' && candidate.resume_url.trim() !== '';

  const requests = [];

  // THE RESUME IS ALWAYS THE FIRST ASK. It is the document a human screener
  // opens first, and the packet carries only the fields the candidate ticked, so
  // its absence is a deliberate choice rather than an oversight — worth asking
  // about once, and worth accepting "no" for.
  if (!hasResume) {
    requests.push({
      field: 'resume_url',
      required: true,
      reason:
        required.length > 0
          ? `This role lists ${required.join(', ')}. Without a resume there is nothing for a human to check that against.`
          : 'A human screener reads the resume first, and none was released with this application.',
    });
  }

  // One question per missing prerequisite, in the posting's own words.
  for (const skill of missingRequired.slice(0, 4)) {
    requests.push({
      field: 'skills',
      required: true,
      about: skill,
      reason: `${skill} is a stated requirement for this role and the application evidences no experience with it.`,
    });
  }

  const verdict = decide({ required, missingRequired, hasResume });

  return {
    verdict,
    requests,
    resume_attached: hasResume,
    prerequisites: {
      required,
      preferred,
      evidenced: evidencedRequired,
      missing: missingRequired,
    },
    // What the employer would say out loud. One sentence, no score theatre.
    spoken_reason: spoken({ verdict, evidencedRequired, required, missingRequired, hasResume }),
    match_score: typeof match?.score === 'number' ? match.score : null,
  };
}

function decide({ required, missingRequired, hasResume }) {
  // A role with no published requirements cannot be screened on them, and
  // pretending otherwise would invent a standard the posting never set.
  if (required.length === 0) return hasResume ? 'accepted' : 'information_requested';
  if (missingRequired.length === required.length) return 'declined';
  if (missingRequired.length > 0 || !hasResume) return 'information_requested';
  return 'accepted';
}

function spoken({ verdict, evidencedRequired, required, missingRequired, hasResume }) {
  const evidence = required.length
    ? `${evidencedRequired.length} of ${required.length} required skills are evidenced`
    : 'this posting publishes no required skills';

  if (verdict === 'declined') {
    return `Not taken forward: ${evidence}, so there is nothing here to screen against ${required.join(', ')}.`;
  }
  if (verdict === 'information_requested') {
    const asks = [
      !hasResume ? 'a resume' : null,
      missingRequired.length ? `evidence of ${missingRequired.join(', ')}` : null,
    ].filter(Boolean);
    return `Held for more information: ${evidence}. This agent asked the applicant's agent for ${asks.join(' and ')}.`;
  }
  return `Accepted for human review: ${evidence} and a resume was released.`;
}

function clean(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

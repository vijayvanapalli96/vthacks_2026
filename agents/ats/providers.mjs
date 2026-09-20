// Selector maps for the three ATS vendors whose application forms are stable
// enough to drive. Greenhouse, Lever and Ashby between them cover most of what
// the job providers in career-ops surface.
//
// These are CSS selectors against the PUBLIC application form — the same form a
// human fills in. Nothing here logs into an ATS, touches a recruiter-side
// dashboard, or reads another candidate's data.
//
// Selectors rot. Each provider carries a `detect` so a page that no longer looks
// like what we expect fails loudly instead of typing a candidate's phone number
// into whatever input happens to be fourth on the page.

export const PROVIDERS = {
  greenhouse: {
    id: "greenhouse",
    detect: [/boards\.greenhouse\.io/, /job-boards\.greenhouse\.io/],
    fields: {
      full_name: null, // Greenhouse splits the name.
      first_name: "input#first_name, input[name='first_name']",
      last_name: "input#last_name, input[name='last_name']",
      email: "input#email, input[name='email']",
      phone: "input#phone, input[name='phone']",
      resume_file: "input[type='file'][name='resume'], input#resume",
      cover_letter: "textarea[name='cover_letter'], textarea#cover_letter",
      // Greenhouse keeps these under job_application[urls][...] on classic
      // boards and plain ids on the newer job-boards host, so both are listed.
      location: "input#job_application_location, input[name='job_application[location]'], input[autocomplete='address-level2']",
      linkedin: "input[name='job_application[urls][LinkedIn]'], input#job_application_urls_LinkedIn",
      website: "input[name='job_application[urls][Website]'], input#job_application_urls_Website",
      github: "input[name='job_application[urls][GitHub]'], input#job_application_urls_GitHub",
    },
    submit: "input[type='submit'], button#submit_app, button[type='submit']",
  },

  lever: {
    id: "lever",
    detect: [/jobs\.lever\.co/],
    fields: {
      full_name: "input[name='name']",
      email: "input[name='email']",
      phone: "input[name='phone']",
      resume_file: "input[type='file'][name='resume']",
      cover_letter: "textarea[name='comments']",
      location: "input[name='location']",
      linkedin: "input[name='urls[LinkedIn]']",
      website: "input[name='urls[Portfolio]']",
      github: "input[name='urls[GitHub]']",
    },
    submit: "button[type='submit'], .postings-btn[type='submit']",
  },

  ashby: {
    id: "ashby",
    detect: [/jobs\.ashbyhq\.com/],
    fields: {
      full_name: "input[name='_systemfield_name']",
      email: "input[name='_systemfield_email']",
      phone: "input[name='_systemfield_phone']",
      resume_file: "input[type='file']",
      cover_letter: "textarea[name='_systemfield_coverLetter']",
      location: "input[name='_systemfield_location']",
      linkedin: "input[name='_systemfield_linkedin']",
      website: "input[name='_systemfield_website']",
    },
    submit: "button[type='submit']",
  },
};

/** Identify the ATS behind a posting URL, or null when it is one we do not drive. */
export function providerForUrl(url) {
  const href = String(url);
  return (
    Object.values(PROVIDERS).find((provider) =>
      provider.detect.some((pattern) => pattern.test(href)),
    ) ?? null
  );
}

/**
 * Split a single display name into the two inputs Greenhouse insists on.
 * Everything after the first token is the surname, which is wrong for a chunk of
 * the world's names — hence `name_split_confidence`, so the review UI can show
 * the guess rather than hide it.
 */
export function splitName(fullName) {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return { first_name: parts[0] ?? "", last_name: "", name_split_confidence: "low" };
  }
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(" "),
    name_split_confidence: parts.length === 2 ? "high" : "medium",
  };
}

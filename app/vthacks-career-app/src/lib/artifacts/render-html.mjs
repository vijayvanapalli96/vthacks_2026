/**
 * render-html.mjs — print-styled HTML. NO CHROMIUM.
 *
 * ── THE PDF DECISION, stated once so nobody reopens it at 4 AM ──────────────
 *
 * career-ops renders PDFs with `generate-pdf.mjs`: 1,885 lines driving
 * Playwright and a headless Chromium. It is NOT lifted, and this file is what
 * replaces it. Three reasons, and the third is the one that actually settles it:
 *
 *   1. `CLAUDE.md` lists Playwright as OUT OF SCOPE.
 *   2. Databricks Apps will not run a headless Chromium. Whatever we build
 *      locally would be dead in production, which is the worst possible outcome:
 *      a feature that demos on a laptop and 500s on the deployed app.
 *   3. The browser the student is already looking at has a production-grade
 *      PDF engine in it. Installing a second one to avoid asking them to press
 *      Ctrl+P is not a trade worth making hours from ship.
 *
 * So: we emit clean, print-styled HTML with a real `@media print` stylesheet,
 * and the button that opens it SAYS SO — "opens a print view; use your browser's
 * Print to save a PDF". It does not claim to produce a file. A button labelled
 * "Download PDF" that opens a print dialog is a small lie, and a judge who
 * clicks it finds out immediately.
 *
 * ── WHAT IS LIFTED HERE ─────────────────────────────────────────────────────
 *
 * `stripEmptySections` from `cv-sections-core.mjs` (copied byte-for-byte; see
 * that file's header). It is the reason the resume template below carries
 * all-caps `<!-- WORK EXPERIENCE -->` markers and an `<!-- END -->` sentinel
 * after its LAST section: that marker shape is the contract the donor's patterns
 * match, and the sentinel is what stops an empty trailing Skills section from
 * taking `</body></html>` with it. Read the donor file's "The Skills sentinel"
 * note before editing the template.
 *
 * `escapeHtml` is career-ops' `generate-cover-letter.mjs` escaper, which is the
 * standard five-character one. It matters more here than it does there: our
 * document text is MODEL OUTPUT built from a SCRAPED POSTING, so it is untrusted
 * twice over. Every interpolated value goes through it. The only unescaped
 * markup in the output is this file's own.
 *
 * NO NEW DEPENDENCY. `cv-templates.mjs` (the donor's template loader) needs
 * `js-yaml` and scans a templates directory; it is deliberately not lifted. One
 * inline template beats a new dep and a filesystem read.
 */

import { stripEmptySections } from './cv-sections-core.mjs';

/** career-ops' escaper. Every dynamic value in this file passes through it. */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The print stylesheet.
 *
 * `@media print` is not decoration. Without it the output is a screenshot of a
 * web page: a dark background burning a toner cartridge, a nav bar on page one,
 * and link URLs nobody asked for. The rules below are the minimum that makes a
 * printed page read as a document.
 *
 * Contrast: #111 on #fff is 18.9:1 and the muted #4a4a4a is 8.6:1, both well
 * past the 4.5:1 body-text floor. Accessibility is a hard rule and it does not
 * stop applying because the surface is a print view.
 */
const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #fff;
    color: #111;
    font: 16px/1.55 ui-serif, Georgia, 'Times New Roman', serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet { max-width: 46rem; margin: 0 auto; padding: 2.5rem 2rem 3rem; }
  .toolbar {
    background: #f4f4f5; border: 1px solid #d4d4d8; border-radius: 8px;
    padding: 0.85rem 1rem; margin-bottom: 2rem;
    font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; color: #3f3f46;
  }
  .toolbar p { margin: 0 0 0.5rem; }
  .toolbar p:last-child { margin-bottom: 0; }
  h1 { font-size: 1.6rem; margin: 0 0 0.15rem; letter-spacing: -0.01em; }
  h2 {
    font: 600 0.78rem/1.3 ui-sans-serif, system-ui, sans-serif;
    text-transform: uppercase; letter-spacing: 0.09em;
    color: #111; margin: 1.7rem 0 0.5rem;
    border-bottom: 1px solid #111; padding-bottom: 0.2rem;
  }
  .meta { color: #4a4a4a; font-size: 0.9rem; margin: 0 0 0.35rem; }
  .role { margin: 0.9rem 0 0; }
  .role-head { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
  .role-title { font-weight: 700; }
  .role-dates { color: #4a4a4a; font-size: 0.88rem; white-space: nowrap; }
  ul { margin: 0.35rem 0 0; padding-left: 1.15rem; }
  li { margin: 0.18rem 0; }
  .body p { margin: 0 0 0.85rem; white-space: pre-wrap; }
  .chips { margin: 0; color: #111; }
  .flag {
    border: 2px solid #991b1b; background: #fef2f2; color: #7f1d1d;
    border-radius: 8px; padding: 0.85rem 1rem; margin: 0 0 1.5rem;
    font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
  }
  .flag strong { color: #7f1d1d; }
  .flag ul { padding-left: 1.2rem; }
  @media print {
    /* The toolbar is the instruction for how to print. Printing the instruction
       onto the document is the classic bug. */
    .toolbar { display: none; }
    .sheet { max-width: none; padding: 0; }
    body { font-size: 11.5pt; }
    h2 { margin-top: 14pt; }
    /* A role split across a page break reads as two jobs. */
    .role, li { break-inside: avoid; page-break-inside: avoid; }
    h2 { break-after: avoid; page-break-after: avoid; }
    a { color: #111; text-decoration: none; }
    @page { margin: 18mm 16mm; }
  }
`;

/** The one-line honest explanation of what this page is, shown on screen only. */
function toolbar(extra) {
  return `
  <div class="toolbar">
    <p><strong>This is a print view, not a PDF.</strong> Use your browser's Print command
    (Ctrl+P / Cmd+P) and choose &ldquo;Save as PDF&rdquo;. We do not run a headless browser
    on the server, so we cannot hand you a file &mdash; your browser makes a better one anyway.</p>
    ${extra ? `<p>${extra}</p>` : ''}
  </div>`;
}

function page(title, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="sheet">
${inner}
</main>
</body>
</html>`;
}

/**
 * A prose document — a cover letter or a set of application answers.
 *
 * Paragraphs are split on blank lines and each is escaped. `white-space:
 * pre-wrap` then preserves the single newlines inside a paragraph, which is what
 * keeps a bullet list in a cover letter looking like a bullet list without
 * parsing markdown. We deliberately do not render the model's markdown: `**bold
 * lead phrase,**` is career-ops' convention and converting it would mean running
 * a markdown parser over untrusted model output for a cosmetic gain.
 */
export function renderDocumentHtml({ title, subtitle, text, generatedAt, modelName }) {
  const paragraphs = String(text ?? '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block)}</p>`)
    .join('\n');

  const provenance = [
    generatedAt ? `Generated ${escapeHtml(generatedAt)}` : '',
    modelName ? `by <code>${escapeHtml(modelName)}</code>` : '',
    'and checked claim-by-claim against your saved profile before it was shown.',
  ]
    .filter(Boolean)
    .join(' ');

  return page(
    title,
    `${toolbar(provenance)}
  <h1>${escapeHtml(title)}</h1>
  ${subtitle ? `<p class="meta">${escapeHtml(subtitle)}</p>` : ''}
  <div class="body">
${paragraphs || '<p>(empty document)</p>'}
  </div>`,
  );
}

/**
 * The refusal page. A document that failed the fact gate is NOT printable, and
 * this is what the print route returns instead of the document.
 *
 * It shows the failing claims rather than a bare "denied", because the student
 * clicked a button and needs to know what to do next. Every finding carries the
 * reason sentence `explainFindings` wrote for it (hard rule 4).
 */
export function renderBlockedHtml({ title, findings, sentence }) {
  const items = (findings ?? [])
    .filter((f) => f.severity === 'block')
    .map((f) => `<li><strong>${escapeHtml(f.claim)}</strong> &mdash; ${escapeHtml(f.reason)}</li>`)
    .join('\n');

  return page(
    `Withheld: ${title}`,
    `<div class="flag">
    <p><strong>This document was not released for printing.</strong></p>
    <p>${escapeHtml(sentence ?? '')}</p>
    ${items ? `<ul>\n${items}\n</ul>` : ''}
    <p>Fix the claims above &mdash; either correct the document, or add the missing
    evidence to your profile if it is genuinely yours &mdash; and generate it again.</p>
  </div>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">No printable version exists for a document that overclaims.</p>`,
  );
}

/**
 * A plain notice page — "no such posting", "no facts yet", "the warehouse is
 * down". NOT the same page as a fact-gate refusal, and that distinction is the
 * reason this function exists: the first live run reused `renderBlockedHtml` for
 * a 404 and rendered "Fix the claims above" and "no printable version exists for
 * a document that overclaims" over a document that had never been generated.
 * Telling a student their missing document overclaims is worse than telling them
 * nothing.
 */
export function renderNoticeHtml({ title, message }) {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1>
  <p class="meta">${escapeHtml(message)}</p>`,
  );
}

/**
 * A resume, built from the student's OWN facts, optionally with the tailored
 * bullets substituted in.
 *
 * This is the one place `stripEmptySections` does real work, and it is why it was
 * lifted: the template below wraps all eight optional sections unconditionally,
 * so a student with no listed projects gets a bare "Projects" heading and a
 * student with no degree row gets a bare "Education" heading. Both happen on
 * real profiles in this workspace.
 *
 * `tailoredByOriginal` maps an original bullet's text to its rewrite. Substituted
 * by EXACT ORIGINAL TEXT rather than by index: the model returns bullets in the
 * order it was given them, but "returns them in order" is a hope and a
 * mis-indexed substitution silently attributes one job's work to another.
 */
export function renderResumeHtml({ structured, tailoredByOriginal = {}, generatedAt, note }) {
  const payload = {
    competencies: [],
    experience: structured.experience ?? [],
    projects: structured.projects ?? [],
    education: structured.education ?? [],
    certifications: [],
    awards: [],
    interests: [],
    skills: structured.skills ?? [],
  };

  const contactLine = [
    structured.contact?.location,
    structured.contact?.email,
    structured.contact?.phone,
    structured.contact?.linkedin,
    structured.contact?.website,
  ]
    .filter(Boolean)
    .map((value) => escapeHtml(value))
    .join(' &nbsp;|&nbsp; ');

  const experienceHtml = payload.experience
    .map((role) => {
      const bullets = role.bullets
        .map((text) => {
          const tailored = tailoredByOriginal[text];
          return tailored && tailored !== text
            ? `<li>${escapeHtml(tailored)}</li>`
            : `<li>${escapeHtml(text)}</li>`;
        })
        .join('\n');
      return `    <div class="role">
      <div class="role-head">
        <span class="role-title">${escapeHtml(role.title ?? '')}${role.company ? ` &mdash; ${escapeHtml(role.company)}` : ''}</span>
        <span class="role-dates">${escapeHtml(role.dates ?? '')}</span>
      </div>
      ${role.location ? `<p class="meta">${escapeHtml(role.location)}</p>` : ''}
      ${bullets ? `<ul>\n${bullets}\n      </ul>` : ''}
    </div>`;
    })
    .join('\n');

  const projectsHtml = payload.projects
    .map((project) => `    <li>${escapeHtml(project.name ?? '')}${project.description ? ` &mdash; ${escapeHtml(project.description)}` : ''}</li>`)
    .join('\n');

  const educationHtml = payload.education
    .map(
      (degree) =>
        `    <li>${escapeHtml([degree.degree, degree.field].filter(Boolean).join(', '))}${degree.school ? ` &mdash; ${escapeHtml(degree.school)}` : ''}</li>`,
    )
    .join('\n');

  const coursesHtml = (structured.courses ?? []).length
    ? `<p class="meta">Coursework: ${escapeHtml((structured.courses ?? []).join(', '))}</p>`
    : '';

  // ── The template. Marker shapes and the trailing <!-- END --> sentinel are
  // the contract `cv-sections-core.mjs` matches against. SKILLS IS LAST AND THE
  // SENTINEL MUST STAY DIRECTLY AFTER IT.
  const template = `${toolbar(
    [
      generatedAt ? `Assembled ${escapeHtml(generatedAt)} from your saved profile.` : '',
      note ? escapeHtml(note) : '',
    ]
      .filter(Boolean)
      .join(' '),
  )}
  <h1>${escapeHtml(structured.name ?? 'Resume')}</h1>
  ${contactLine ? `<p class="meta">${contactLine}</p>` : ''}
  ${structured.summary ? `<p class="body">${escapeHtml(structured.summary)}</p>` : ''}

  <!-- CORE COMPETENCIES -->
  <h2>Core competencies</h2>

  <!-- WORK EXPERIENCE -->
  <h2>Experience</h2>
${experienceHtml}

  <!-- PROJECTS -->
  <h2>Projects</h2>
  <ul>
${projectsHtml}
  </ul>

  <!-- EDUCATION -->
  <h2>Education</h2>
  <ul>
${educationHtml}
  </ul>
  ${coursesHtml}

  <!-- CERTIFICATIONS -->
  <h2>Certifications</h2>

  <!-- AWARDS -->
  <h2>Awards</h2>

  <!-- INTERESTS -->
  <h2>Interests</h2>

  <!-- SKILLS -->
  <h2>Skills</h2>
  <p class="chips">${escapeHtml((payload.skills ?? []).join(' · '))}</p>
  <!-- END -->`;

  return page(`${structured.name ?? 'Resume'} — resume`, stripEmptySections(template, payload, 'html'));
}

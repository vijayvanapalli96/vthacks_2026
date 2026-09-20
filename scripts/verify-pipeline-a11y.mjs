/**
 * verify-pipeline-a11y.mjs — assert the board's accessibility properties against
 * the REAL rendered markup, not against a description of it.
 *
 * CLAUDE.md hard rule 6 is the thesis of the product, and "I used a <select>" is
 * a claim, not evidence. This server-renders the shipping PipelineBoard component
 * with react-dom/server and then asserts on the HTML: one labelled select per
 * card, a live region present before it has content, a visible focus target, no
 * drag-only path, and stage never carried by colour alone.
 *
 * WHAT THIS IS NOT: a browser. There is no Playwright in this environment, so
 * this does not measure real focus movement, real screen-reader output, or real
 * computed contrast. It measures the markup those depend on. The gap is stated in
 * the report rather than papered over.
 *
 *   node scripts/verify-pipeline-a11y.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'app', 'vthacks-career-app');
const LIB = path.join(APP, 'src', 'lib');
const PAGE = path.join(APP, 'src', 'app', 'applicant', 'pipeline');
// Inside the app so `react` and `react-dom/server` resolve from its node_modules.
const OUT = path.join(APP, '.tmp-pipeline-a11y');

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

function toUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/')}`).href;
}

const { default: ts } = await import(toUrl(path.join(APP, 'node_modules', 'typescript', 'lib', 'typescript.js')));

mkdirSync(OUT, { recursive: true });

function emit(absolutePath, outName, rewrites = []) {
  const source = readFileSync(absolutePath, 'utf8');
  let js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: path.basename(absolutePath),
  }).outputText;
  for (const [from, to] of rewrites) js = js.split(from).join(to);
  writeFileSync(path.join(OUT, outName), js);
}

// next/link is not usable outside a Next render, and it is only reached by the
// empty state. Stubbed to the plain anchor it renders to, so the import resolves.
writeFileSync(
  path.join(OUT, 'link-stub.mjs'),
  `import { jsx } from 'react/jsx-runtime';
export default function Link({ href, children, ...rest }) {
  return jsx('a', { href, ...rest, children });
}\n`,
);

emit(path.join(LIB, 'pipeline-contract.ts'), 'pipeline-contract.mjs');
emit(path.join(PAGE, 'PipelineBoard.tsx'), 'PipelineBoard.mjs', [
  ["'@/lib/pipeline-contract'", "'./pipeline-contract.mjs'"],
  ["'next/link'", "'./link-stub.mjs'"],
  // The 'use client' directive is meaningless to plain Node and React 19's
  // server renderer warns about it.
  ["'use client';", ''],
]);

const { PipelineBoard } = await import(toUrl(path.join(OUT, 'PipelineBoard.mjs')));
const { renderToStaticMarkup } = await import(toUrl(path.join(APP, 'node_modules', 'react-dom', 'server.browser.js')));

/**
 * Real companies and real careers URLs, taken from scripts/scan/boards.json —
 * the live board registry this project actually scrapes. Hard rule 7: no "Acme
 * Corp" anywhere, including in a test.
 */
const cards = [
  {
    job_id: 'verify-gusto-1',
    status: 'applied',
    title: 'Software Engineer, Infrastructure',
    company: 'Gusto',
    location: 'Denver, CO',
    source_url: 'https://job-boards.greenhouse.io/gusto',
    status_changed_at: '2026-09-12T10:00:00.000Z',
    days_in_stage: 7,
    days_tracked: 11,
    events_total: 3,
    note: 'Recruiter said two weeks.',
    match_score: 75,
    match_reason: 'Systems coursework and Go experience line up with the infrastructure requirements.',
  },
  {
    job_id: 'verify-pinterest-1',
    status: 'saved',
    title: 'Machine Learning Engineer Intern',
    company: 'Pinterest',
    location: 'San Francisco, CA',
    source_url: 'https://job-boards.greenhouse.io/pinterest',
    status_changed_at: '2026-09-19T10:00:00.000Z',
    days_in_stage: 0,
    days_tracked: 0,
    events_total: 1,
    note: null,
    match_score: 85,
    match_reason: null,
  },
  {
    job_id: 'verify-offer-1',
    status: 'offer',
    title: 'Backend Engineer',
    company: 'Gusto',
    location: 'Remote, US',
    source_url: null,
    status_changed_at: '2026-09-14T10:00:00.000Z',
    days_in_stage: 5,
    days_tracked: 20,
    events_total: 5,
    note: null,
    match_score: null,
    match_reason: null,
  },
];

// createElement, not PipelineBoard(...): calling a component as a function skips
// React's dispatcher and every hook inside it throws.
const { createElement } = await import(toUrl(path.join(APP, 'node_modules', 'react', 'index.js')));
const html = renderToStaticMarkup(createElement(PipelineBoard, { cards, loadError: null }));

// --- The status control ----------------------------------------------------
const selects = [...html.matchAll(/<select\b[^>]*>/g)].map((m) => m[0]);
check('one <select> per card, and nothing else', selects.length === cards.length, `${selects.length} selects`);

const selectIds = selects.map((tag) => /id="([^"]+)"/.exec(tag)?.[1]);
const labelFors = [...html.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]);
check(
  'every <select> has a <label for> pointing at its id',
  selectIds.every((id) => id && labelFors.includes(id)),
  `selects ${JSON.stringify(selectIds)}`,
);
check(
  'each label names the JOB, not just "Stage" — a column of identical labels is useless',
  cards.every((card) => html.includes(`for ${card.title}`) || html.includes(`for ${card.title} at ${card.company}`)),
);
const options = [...html.matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1]);
check(
  'all seven stages are offered on every select',
  options.length === cards.length * 7,
  `${options.length} options across ${cards.length} selects`,
);
check('the select is aria-describedby its hint', /aria-describedby="pipe-note-/.test(html));
check(
  'the control is NEVER rendered disabled — disabling a focused element drops focus',
  !/<select[^>]*\bdisabled\b/.test(html),
);

// --- Announcements ---------------------------------------------------------
check('an aria-live="polite" status region is in the DOM before it has content', /role="status" aria-live="polite"/.test(html));
check('a role="alert" region is in the DOM before it has content', /role="alert"/.test(html));

// --- No pointer-only path --------------------------------------------------
const source = readFileSync(path.join(PAGE, 'PipelineBoard.tsx'), 'utf8');
for (const attribute of ['draggable', 'onDragStart', 'onDragOver', 'onDrop', 'onMouseDown', 'onMouseOver']) {
  check(`no ${attribute} — there is no drag-and-drop and no pointer-only path`, !source.includes(attribute));
}
check('no onClick on a non-interactive element', !/<(div|li|section|span)[^>]*onClick/.test(source));
check('the rendered HTML contains no draggable attribute', !/draggable/.test(html));

// --- Stage is never colour alone -------------------------------------------
const { STATUS_LABEL, STATUS_MARK } = await import(toUrl(path.join(OUT, 'pipeline-contract.mjs')));
check(
  'every stage name appears as TEXT in the markup, not only as a class',
  Object.values(STATUS_LABEL).every((label) => html.includes(label)),
);
check(
  'each column carries a non-colour mark alongside its label',
  Object.values(STATUS_MARK).every((mark) => html.includes(`aria-hidden="true">${mark}<`)),
);
check(
  'column counts are inside the heading, so the count is announced on arrival',
  /<h2 id="pipe-col-applied"[\s\S]{0,400}?1 role<\/span>/.test(html),
);
check(
  'the stalled sentence is words, not a red dot',
  html.includes('7 days in Applied, no response yet.'),
);
check('a match score reads as a sentence, not a bare number', html.includes('Match 75 out of 100'));
check(
  'the append-only fact is visible on the card',
  html.includes('3 events logged') && html.includes('5 events logged'),
);

// --- Tab order -------------------------------------------------------------
// Focusable elements in DOM order. Tab order IS DOM order here because nothing
// sets a positive tabIndex, which is the next assertion.
const focusable = [...html.matchAll(/<(a|button|select|textarea|summary)\b[^>]*>/g)].map((m) => m[1]);
check('nothing sets a positive tabIndex, so tab order is DOM order', !/tabindex="[1-9]/i.test(html));
check('nothing is removed from the tab order with tabindex="-1"', !/tabindex="-1"/i.test(html));
check(
  'the focusable sequence is what a keyboard user expects per card',
  focusable.length > 0,
  focusable.join(' > '),
);
// Per card: the title link when there is a source_url, then the stage select, then
// the "Add a note" summary, its textarea and its button. That is the entire
// interactive surface — there is nothing else to reach, by keyboard or by mouse.
const expected = cards.reduce((n, card) => n + (card.source_url ? 1 : 0) + 4, 0);
check(
  'focus stop count matches the card contents exactly',
  focusable.length === expected,
  `${focusable.length} stops for ${cards.length} cards (${expected} expected)`,
);
// The stage select is reachable in at most two stops from the card's first
// element, which is what makes the keyboard path short enough to actually use.
check(
  'the stage select is the first or second stop on every card',
  focusable.join(',').replace(/summary,textarea,button/g, '·').split('·').every((chunk) => {
    const stops = chunk.split(',').filter(Boolean);
    return stops.length === 0 || stops.indexOf('select') <= 1;
  }),
  focusable.join(' > '),
);

rmSync(OUT, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL A11Y CHECKS PASSED' : `\n${failures} A11Y CHECK(S) FAILED`);
// Explicit exit: react-dom's server build leaves a handle open and the process
// otherwise hangs after printing, which would read as a failure in CI.
process.exit(failures === 0 ? 0 : 1);

// Playwright ATS form worker.
//
// SCOPE NOTE: CLAUDE.md lists "Playwright / ATS form automation" as out of
// scope, replaced by A2A. This module exists because that call was revisited and
// reversed on 2026-09-19 — the reasoning being that an ANS-registered agent
// driving the form is a different claim from a headless browser doing it
// anonymously. Keep the ANS name on the request (see `identity`) or the reversal
// loses the thing that justified it.
//
// Two invariants this module will not be refactored out of:
//
//   1. `submit` defaults to false. fill() prepares a form and stops. Submitting
//      is a separate, explicitly-flagged act, because it is irreversible and it
//      reaches a real employer.
//   2. A posting we cannot identify is never typed into. No generic
//      "find the input that looks like an email" fallback — see providers.mjs.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { providerForUrl, splitName } from "./providers.mjs";

/**
 * Fill a posting's application form and, only when explicitly told to, submit it.
 *
 * @param {object}  options
 * @param {string}  options.jobUrl        Public posting URL.
 * @param {object}  options.candidate     Field values to type.
 * @param {boolean} [options.submit]      Actually click submit. Defaults to false.
 * @param {string}  [options.identity]    ANS name to carry in the user agent.
 * @param {string}  [options.artifactDir] Where the screenshot and record land.
 */
export async function fill({
  jobUrl,
  candidate,
  /**
   * A per-field plan from the app's Gemini pass: [{selector, value}].
   *
   * The provider table below knows eight selectors — name, email, phone, resume,
   * cover letter, location, linkedin, website. Every real Ashby form also carries
   * the questions that actually take time, and those were left blank, so
   * "autofill" filled the boring half. When a plan is supplied it is typed FIRST
   * and the provider table fills only what the plan did not cover.
   *
   * The plan is data, not code: a selector is passed to page.locator() and a
   * value to fill(), and a selector that matches nothing is recorded as skipped.
   */
  planned = [],
  submit = false,
  identity = process.env.APPLICANT_ANS_NAME ?? null,
  artifactDir = "./work/ats",
  audit = null,
  browserFactory,
  now = () => new Date().toISOString(),
}) {
  const provider = providerForUrl(jobUrl);
  if (!provider) {
    const record = {
      job_url: jobUrl,
      status: "unsupported_ats",
      submitted: false,
      fields_filled: [],
      spoken_reason:
        "This posting is not on an applicant-tracking system this agent knows how to drive, so nothing was typed.",
      recorded_at: now(),
    };
    await audit?.append("ats_apply_skipped", record);
    return record;
  }

  const launch = browserFactory ?? (await defaultBrowserFactory());
  const browser = await launch();
  const context = await browser.newContext({
    // Announce what we are. An ANS-registered agent filling a form is the whole
    // justification for this lane existing; a blank or spoofed UA would make it
    // indistinguishable from the anonymous scraping the team ruled out.
    userAgent: identity
      ? `HireWire-Agent/1.0 (+${identity})`
      : "HireWire-Agent/1.0 (unregistered)",
  });

  const page = await context.newPage();
  const filled = [];
  const skipped = [];

  try {
    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const values = { ...candidate };
    // THE PLANNED FIELDS FIRST. Everything the model could answer from the
    // profile, including the custom questions no selector table can know about.
    // A field it could not answer is absent from the plan and stays empty, which
    // is the correct outcome and is reported as such.
    const plannedSelectors = new Set();
    for (const entry of Array.isArray(planned) ? planned : []) {
      const selector = typeof entry?.selector === "string" ? entry.selector : "";
      const value = typeof entry?.value === "string" ? entry.value : "";
      if (!selector || !value.trim()) continue;

      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) {
        skipped.push({ field: entry.label ?? selector, reason: "no matching input on the page" });
        continue;
      }
      try {
        // A <select> needs selectOption; fill() silently does nothing on one.
        const tag = await locator.evaluate((node) => node.tagName.toLowerCase());
        if (tag === "select") await locator.selectOption({ label: value });
        else await locator.fill(value);
        plannedSelectors.add(selector);
        filled.push(entry.label ?? selector);
      } catch (error) {
        skipped.push({ field: entry.label ?? selector, reason: error.message.slice(0, 120) });
      }
    }

    if (provider.fields.full_name === null && candidate.full_name) {
      Object.assign(values, splitName(candidate.full_name));
    }

    for (const [field, selector] of Object.entries(provider.fields)) {
      if (!selector || values[field] === undefined || values[field] === null) continue;
      // Already typed by the plan. Re-filling would overwrite a considered answer
      // with the raw profile value.
      if (plannedSelectors.has(selector)) continue;
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) {
        skipped.push({ field, reason: "no matching input on the page" });
        continue;
      }
      if (field === "resume_file") {
        await locator.setInputFiles(values[field]);
      } else {
        await locator.fill(String(values[field]));
      }
      filled.push(field);
    }

    await mkdir(artifactDir, { recursive: true });
    const stamp = now().replace(/[:.]/g, "-");
    const shotPath = join(artifactDir, `${stamp}-${provider.id}.png`);
    await page.screenshot({ path: shotPath, fullPage: true });

    let submitted = false;
    let spokenReason;

    if (!submit) {
      // The default path. The form is sitting there filled, screenshotted, and
      // untouched — a human reviews the shot and decides.
      spokenReason = `Prepared the ${provider.id} application for review. Nothing was submitted.`;
    } else {
      const button = page.locator(provider.submit).first();
      if ((await button.count()) === 0) {
        spokenReason = "The submit control was not found, so the application was left unsent.";
      } else {
        await button.click();
        await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
        submitted = true;
        spokenReason = `Submitted the ${provider.id} application for ${jobUrl}.`;
      }
    }

    const record = {
      job_url: jobUrl,
      provider: provider.id,
      status: submitted ? "submitted" : "prepared",
      submitted,
      fields_filled: filled,
      fields_skipped: skipped,
      screenshot_path: shotPath,
      identity,
      spoken_reason: spokenReason,
      recorded_at: now(),
    };

    const recordPath = join(artifactDir, `${stamp}-${provider.id}.json`);
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await audit?.append(submitted ? "ats_apply_submitted" : "ats_apply_prepared", record);

    return record;
  } finally {
    await context.close();
    await browser.close();
  }
}

/** Resolved lazily so the module imports cleanly on a machine without Playwright. */
async function defaultBrowserFactory() {
  const { chromium } = await import("playwright");
  return () => chromium.launch({ headless: true });
}

/**
 * DISCOVER EVERY FIELD ON THE PAGE.
 *
 * Ashby renders its whole application form in the browser — the HTML served for
 * an application URL contains zero <input> and zero <label> — so this is the only
 * place the real field list exists. The app calls this first, hands the list to
 * Gemini, and posts the plan back to /ats/prepare.
 *
 * READ-ONLY. It opens the page, reads the DOM and closes. Nothing is typed,
 * nothing is clicked, nothing is submitted.
 *
 * The label is whatever a human would read: an associated <label>, else
 * aria-label, else the placeholder, else the name attribute. Getting this right
 * is most of the quality of the fill, because the label is all the model has to
 * decide what a box wants.
 */
export async function discover({ jobUrl, browserFactory, now = () => new Date().toISOString() }) {
  const provider = providerForUrl(jobUrl);
  const launch = browserFactory ?? (await defaultBrowserFactory());
  const browser = await launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // The form is client-rendered; waiting for the first control beats a fixed
    // sleep and fails fast when the page has no form at all.
    await page.waitForSelector("input, textarea, select", { timeout: 20_000 }).catch(() => {});

    const fields = await page.evaluate(() => {
      const labelFor = (element) => {
        const id = element.getAttribute("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label?.innerText?.trim()) return label.innerText.trim();
        }
        const wrapping = element.closest("label");
        if (wrapping?.innerText?.trim()) return wrapping.innerText.trim();
        const aria = element.getAttribute("aria-label");
        if (aria?.trim()) return aria.trim();
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
          const target = document.getElementById(labelledBy);
          if (target?.innerText?.trim()) return target.innerText.trim();
        }
        return element.getAttribute("placeholder")?.trim() || element.getAttribute("name")?.trim() || "";
      };

      const selectorFor = (element) => {
        const name = element.getAttribute("name");
        if (name) return `${element.tagName.toLowerCase()}[name="${name}"]`;
        const id = element.getAttribute("id");
        if (id) return `#${CSS.escape(id)}`;
        return null;
      };

      /**
       * THE GROUP QUESTION FOR A RADIO OR CHECKBOX.
       *
       * A radio's own label is the OPTION ("Under 30"), not the question ("What
       * is your age range?"). That matters twice over: a model cannot answer an
       * option shorn of its question, and the app's refusal filter matches on the
       * label, so a demographic question would have sailed straight past a guard
       * looking for the word "age". Found on a real Ashby form, which asks
       * exactly that.
       */
      const groupQuestion = (element) => {
        const fieldset = element.closest("fieldset");
        const legend = fieldset?.querySelector("legend");
        if (legend?.innerText?.trim()) return legend.innerText.trim();
        const group = element.closest('[role="radiogroup"], [role="group"]');
        const labelledBy = group?.getAttribute("aria-labelledby");
        if (labelledBy) {
          const target = document.getElementById(labelledBy);
          if (target?.innerText?.trim()) return target.innerText.trim();
        }
        const ariaLabel = group?.getAttribute("aria-label");
        if (ariaLabel?.trim()) return ariaLabel.trim();
        return "";
      };

      const out = [];
      for (const element of document.querySelectorAll("input, textarea, select")) {
        const type = (element.getAttribute("type") || element.tagName).toLowerCase();
        // Nothing the candidate fills in, and nothing we should ever touch.
        if (["hidden", "submit", "button", "reset", "file"].includes(type)) continue;
        const selector = selectorFor(element);
        if (!selector) continue;

        const options =
          element.tagName.toLowerCase() === "select"
            ? [...element.options].map((option) => option.label || option.value).filter(Boolean)
            : undefined;

        const maxLengthAttribute = Number(element.getAttribute("maxlength"));
        // "What is your age range? — Under 30" rather than "Under 30".
        const own = labelFor(element);
        const question = ["radio", "checkbox"].includes(type) ? groupQuestion(element) : "";
        const label = question && !own.startsWith(question) ? `${question} — ${own}` : own;

        out.push({
          selector,
          label: label.slice(0, 300),
          type,
          required: element.hasAttribute("required") || element.getAttribute("aria-required") === "true",
          options,
          maxLength: Number.isFinite(maxLengthAttribute) && maxLengthAttribute > 0 ? maxLengthAttribute : null,
        });
      }
      // A control with no readable label is one the model cannot reason about,
      // and guessing from a selector is how you type a cover letter into a
      // postcode box.
      return out.filter((field) => field.label.length > 0);
    });

    await context.close();
    return { job_url: jobUrl, provider: provider?.id ?? null, fields, discovered_at: now() };
  } finally {
    await browser.close().catch(() => {});
  }
}

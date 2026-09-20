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
    if (provider.fields.full_name === null && candidate.full_name) {
      Object.assign(values, splitName(candidate.full_name));
    }

    for (const [field, selector] of Object.entries(provider.fields)) {
      if (!selector || values[field] === undefined || values[field] === null) continue;
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

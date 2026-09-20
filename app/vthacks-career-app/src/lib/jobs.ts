/**
 * jobs.ts — read side of the job discovery pipeline (scripts/scan, PR #12).
 *
 * Reads `open_us_jobs` (US, posted in the last 3 days) and falls back to the
 * raw `job_snapshots` table while that view does not exist yet. Real postings
 * only; the one pinned demo job points at our own ANS-registered employer agent
 * so the verified path can always be shown, and it says so on screen.
 */
import { sql } from './databricks';

export type Job = {
  job_id: string;
  company_name: string;
  job_title: string;
  location_text: string | null;
  source: string | null;
  source_url: string | null;
  posted_at: string | null;
  demo?: boolean;
};

export const DEMO_JOB: Job = {
  job_id: 'hirewire-demo-swe-intern',
  company_name: 'Hirewire demo employer',
  job_title: 'Software Engineering Intern',
  location_text: 'Blacksburg, VA',
  source: 'ans-demo',
  source_url: 'https://employer.hirewire.biz/',
  posted_at: null,
  demo: true,
};

const COLUMNS = 'job_id, company_name, job_title, location_text, source, source_url, CAST(posted_at AS STRING) AS posted_at';

function rowsToJobs(result: { columns: string[]; rows: (string | null)[][] }): Job[] {
  return result.rows.map(
    (row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])) as unknown as Job,
  );
}

export async function listJobs(limit = 30): Promise<{ jobs: Job[]; source: 'open_us_jobs' | 'job_snapshots' | 'unavailable' }> {
  const capped = Math.max(1, Math.min(limit, 100));
  try {
    const result = await sql(
      `SELECT ${COLUMNS} FROM workspace.vthacks_2026.open_us_jobs ORDER BY posted_at DESC LIMIT ${capped}`,
    );
    return { jobs: rowsToJobs(result), source: 'open_us_jobs' };
  } catch {
    try {
      const result = await sql(
        `SELECT ${COLUMNS} FROM workspace.vthacks_2026.job_snapshots ORDER BY discovered_at DESC LIMIT ${capped}`,
      );
      return { jobs: rowsToJobs(result), source: 'job_snapshots' };
    } catch (error) {
      console.error('Could not read jobs', error);
      return { jobs: [], source: 'unavailable' };
    }
  }
}

export async function getJob(jobId: string): Promise<Job | null> {
  if (jobId === DEMO_JOB.job_id) return DEMO_JOB;
  try {
    const result = await sql(
      `SELECT ${COLUMNS} FROM workspace.vthacks_2026.job_snapshots WHERE job_id = :job_id LIMIT 1`,
      [{ name: 'job_id', value: jobId }],
    );
    return rowsToJobs(result)[0] ?? null;
  } catch (error) {
    console.error('Could not read job', error);
    return null;
  }
}

const BOARD_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|icims\.com|workable\.com)$/i;

/**
 * Best guess at the employer's own domain, which ANS discovery needs. Job boards
 * host postings on their own domains, so for those it guesses from the company
 * name, and the screen lets the student correct it before anything is looked up.
 */
/**
 * The employer domain when the POSTING ITSELF names it — i.e. the job links to
 * the company's own site rather than to an ATS board. Null when all we could do
 * is guess from the company name, which is the difference between "riotgames.com
 * is Riot's domain, they linked it" and "andurilindustries.com is our guess, and
 * it does not exist". Callers that make a claim about the domain must use this,
 * not guessEmployerDomain.
 */
export function employerDomainFromPosting(job: Job): string | null {
  if (job.demo) return 'hirewire.biz';
  try {
    const host = new URL(job.source_url ?? '').hostname.toLowerCase().replace(/^(www|jobs|careers)\./, '');
    return host && !BOARD_HOSTS.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function guessEmployerDomain(job: Job): string {
  if (job.demo) return 'hirewire.biz';
  try {
    const host = new URL(job.source_url ?? '').hostname.toLowerCase().replace(/^(www|jobs|careers)\./, '');
    if (host && !BOARD_HOSTS.test(host)) return host;
  } catch {
    // fall through to the name-based guess
  }
  const slug = job.company_name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  return slug ? `${slug}.com` : '';
}

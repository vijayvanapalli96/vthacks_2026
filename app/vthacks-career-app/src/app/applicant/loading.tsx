/**
 * Shown the instant a link in the applicant workspace is clicked, for as long as
 * the server takes to render the real page.
 *
 * Every page in here is force-dynamic and reads Databricks — a statement is
 * 0.6-1.1s against a warm warehouse and 20-30s against one that has idled to a
 * stop. With no loading file, App Router keeps the PREVIOUS screen on display
 * for all of that with nothing to say a navigation is happening, which reads as
 * a dead click and then an unexplained jump. This is the cheapest fix for the
 * half of "slow" that is perception rather than milliseconds.
 *
 * It is deliberately shapeless. A skeleton that mimics a specific page is a
 * promise about what is arriving, and these routes render different things.
 */
export default function ApplicantLoading() {
  return (
    <div className="route-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span />
      <span />
      <span />
      <span />
      <p className="sr-only">Loading your workspace.</p>
    </div>
  );
}

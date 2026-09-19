const FEATURES = [
  'Voice-first applications',
  'Verified employers, or we refuse',
  'Matched on skills and coursework',
  'Agent-to-agent apply',
  'Auto-tailored resume and cover letter',
  'Domain-anchored identity',
  'Screen-reader and keyboard native',
  'Human approval before anything sends',
  'Live application analytics',
  'Skill-gap insight',
  'Voice mock interviews',
  'Every handshake audit-logged',
];

/**
 * Infinite feature ticker. Pure CSS — the track holds two identical runs and
 * slides exactly one run's width, so the seam never shows.
 *
 * The second run is aria-hidden: a screen reader reads the feature list once,
 * as a list, and never encounters the duplicate. Motion stops entirely under
 * prefers-reduced-motion, where it becomes a wrapped static list.
 */
export function FeatureMarquee() {
  return (
    <div className="marquee" role="region" aria-label="Key features">
      <div className="marquee__track">
        <ul className="marquee__run">
          {FEATURES.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <ul className="marquee__run" aria-hidden="true">
          {FEATURES.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

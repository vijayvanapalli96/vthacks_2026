/* eslint-disable @next/next/no-img-element */

/**
 * Per-stage photo collages. Each stage gets its OWN composition — a stack, a
 * grid, a cascade, a mirrored pair — so the rail does not read as nine copies
 * of the same card.
 *
 * Images live in /public/collage, named <stage>-<n>.jpg. Counts vary by layout;
 * public/collage/README.md lists exactly which files each stage needs. Frames
 * render before the files exist, so the layout is right in advance.
 */

type Layout = 'stack' | 'pair' | 'grid' | 'overlap' | 'cascade' | 'hero' | 'mirror' | 'scatter' | 'tall';

type Cfg = {
  layout: Layout;
  count: number;
  captions: string[];
  /** Override the default `<stage>-<n>.jpg` for a frame — index is 1-based. */
  srcs?: Record<number, string>;
  /** Frames that hold a wide asset rather than a square photo. */
  wide?: number[];
};

const LAYOUT: Record<string, Cfg> = {
  '01': {
    layout: 'stack',
    count: 3,
    captions: ['the stack', 'read', 'facts out'],
    srcs: { 1: '/collage/01-1.png' },
    wide: [1],
  },
  '02': { layout: 'pair', count: 2, captions: ['it listens', 'it answers'] },
  '03': { layout: 'grid', count: 4, captions: ['greenhouse', 'lever', 'ashby', 'one table'] },
  '04': { layout: 'overlap', count: 2, captions: ['you', 'the role'] },
  '05': { layout: 'cascade', count: 3, captions: ['resume', 'letter', 'email'] },
  '06': { layout: 'hero', count: 2, captions: ['prove it', 'then apply'] },
  '07': { layout: 'mirror', count: 2, captions: ['their agent', 'ours'] },
  '08': { layout: 'scatter', count: 3, captions: ['forged', 'replayed', 'blocked'] },
  '09': { layout: 'tall', count: 3, captions: ['every event', 'day 1', 'day 30'] },
};

export function StageCollage({ id, title }: { id: string; title: string }) {
  const cfg = LAYOUT[id];
  if (!cfg) return null;

  return (
    <div className={`collage collage--${cfg.layout}`} aria-hidden="true">
      {Array.from({ length: cfg.count }, (_, i) => (
        <figure
          key={i}
          className={`polaroid${cfg.wide?.includes(i + 1) ? ' polaroid--wide' : ''}`}
        >
          <span className="polaroid__img">
            <img src={cfg.srcs?.[i + 1] ?? `/collage/${id}-${i + 1}.jpg`} alt="" loading="lazy" />
          </span>
          <figcaption>{cfg.captions[i]}</figcaption>
        </figure>
      ))}
      <span className="sr-only">{title}</span>
    </div>
  );
}

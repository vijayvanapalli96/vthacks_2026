import Image from 'next/image';

/**
 * Three overlapping polaroids per stage. Images live in /public/collage and are
 * named <stage>-1|2|3.jpg — see public/collage/README.md for the prompts.
 *
 * Until a file exists the frame still renders, so the layout is correct before
 * the art arrives and dropping a file in is the only step needed.
 */

const TILT = [-5, 3, -2];
const CAPTION: Record<string, [string, string, string]> = {
  '01': ['resume in', 'facts out', 'nothing guessed'],
  '02': ['it listens', 'it answers', 'two voices'],
  '03': ['three boards', 'one table', 'stored once'],
  '04': ['ranked', 'explained', '92% fit'],
  '05': ['tailored', 'fact-checked', 'ready to send'],
  '06': ['who are you?', 'prove it', 'then apply'],
  '07': ['both ways', 'verified', 'no bots'],
  '08': ['every verdict', 'logged', 'attack blocked'],
  '09': ['every event', 'over time', 'apply sooner'],
};

export function StageCollage({ id, title }: { id: string; title: string }) {
  const captions = CAPTION[id] ?? ['', '', ''];

  return (
    <div className="collage" aria-hidden="true">
      {[1, 2, 3].map((n, i) => (
        <figure key={n} className="polaroid" style={{ '--tilt': `${TILT[i]}deg` } as React.CSSProperties}>
          <span className="polaroid__img">
            <Image
              src={`/collage/${id}-${n}.jpg`}
              alt=""
              width={320}
              height={320}
              unoptimized
            />
          </span>
          <figcaption>{captions[i]}</figcaption>
        </figure>
      ))}
      <span className="sr-only">{title}</span>
    </div>
  );
}

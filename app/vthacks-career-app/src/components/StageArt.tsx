/**
 * Per-stage collages. Overlapping polaroid frames holding simple marks — drawn
 * inline so they scale crisply, recolour with the inverted band for free, and
 * cost no network requests.
 *
 * Everything is stroke-only in currentColor. No fills, no raster, no logos.
 */

const F = 'art__frame';
const L = 'art__line';
const A = 'art__accent';

function Frame({ x, y, w, h, r = 0 }: { x: number; y: number; w: number; h: number; r?: number }) {
  return <rect className={F} x={x} y={y} width={w} height={h} transform={`rotate(${r} ${x + w / 2} ${y + h / 2})`} />;
}

/** Ruled lines suggesting body text inside a frame. */
function Lines({ x, y, w, n = 3, r = 0, cx = 0, cy = 0 }: { x: number; y: number; w: number; n?: number; r?: number; cx?: number; cy?: number }) {
  return (
    <g transform={r ? `rotate(${r} ${cx} ${cy})` : undefined}>
      {Array.from({ length: n }, (_, i) => (
        <line key={i} className={L} x1={x} y1={y + i * 9} x2={x + (i === n - 1 ? w * 0.6 : w)} y2={y + i * 9} />
      ))}
    </g>
  );
}

const SCENES: Record<string, React.ReactNode> = {
  // 01 Profile — a resume, read, becoming facts
  '01': (
    <>
      <Frame x={14} y={18} w={96} h={122} r={-4} />
      <Lines x={26} y={40} w={70} n={6} r={-4} cx={62} cy={79} />
      <Frame x={134} y={36} w={116} h={30} r={2} />
      <Frame x={146} y={78} w={116} h={30} r={-2} />
      <Frame x={134} y={120} w={116} h={30} r={3} />
      <line className={A} x1={112} y1={70} x2={132} y2={54} />
      <line className={A} x1={112} y1={80} x2={144} y2={94} />
      <line className={A} x1={112} y1={90} x2={132} y2={132} />
      <circle className={A} cx={247} cy={51} r={4} />
      <circle className={A} cx={259} cy={93} r={4} />
    </>
  ),
  // 02 Voice — waveform between two turns
  '02': (
    <>
      <Frame x={16} y={26} w={104} h={44} r={-3} />
      <Frame x={150} y={104} w={104} h={44} r={3} />
      <g className={A}>
        {Array.from({ length: 22 }, (_, i) => {
          const h = 6 + Math.abs(Math.sin(i * 0.9)) * 30;
          return <line key={i} x1={26 + i * 10} y1={92 - h / 2} x2={26 + i * 10} y2={92 + h / 2} />;
        })}
      </g>
      <Lines x={28} y={40} w={76} n={2} r={-3} cx={68} cy={48} />
      <Lines x={162} y={118} w={76} n={2} r={3} cx={202} cy={126} />
    </>
  ),
  // 03 Sourcing — three boards into one table
  '03': (
    <>
      <Frame x={14} y={16} w={78} h={38} r={-3} />
      <Frame x={14} y={66} w={78} h={38} />
      <Frame x={14} y={116} w={78} h={38} r={3} />
      <Lines x={24} y={30} w={54} n={2} r={-3} cx={51} cy={35} />
      <Lines x={24} y={80} w={54} n={2} />
      <Lines x={24} y={130} w={54} n={2} r={3} cx={51} cy={135} />
      <path className={A} d="M96 35 C124 35 124 85 150 85" />
      <path className={A} d="M96 85 L150 85" />
      <path className={A} d="M96 135 C124 135 124 85 150 85" />
      <Frame x={152} y={48} w={104} h={74} r={2} />
      <Lines x={164} y={64} w={78} n={5} r={2} cx={204} cy={85} />
    </>
  ),
  // 04 Match — two sets, scored
  '04': (
    <>
      <Frame x={14} y={30} w={88} h={100} r={-3} />
      <Lines x={26} y={48} w={62} n={6} r={-3} cx={58} cy={80} />
      <circle className={F} cx={190} cy={80} r={46} />
      <path className={A} d="M190 34 a46 46 0 0 1 36 74" />
      <text className="art__num" x={190} y={88} textAnchor="middle">92</text>
      <line className={A} x1={104} y1={60} x2={144} y2={70} />
      <line className={A} x1={104} y1={80} x2={144} y2={80} />
      <line className={A} x1={104} y1={100} x2={144} y2={90} />
    </>
  ),
  // 05 Tailor — one packet, three artefacts
  '05': (
    <>
      <Frame x={20} y={22} w={88} h={112} r={-5} />
      <Frame x={40} y={32} w={88} h={112} r={2} />
      <Lines x={52} y={52} w={64} n={7} r={2} cx={84} cy={80} />
      <Frame x={152} y={30} w={100} h={26} r={2} />
      <Frame x={152} y={68} w={100} h={26} r={-2} />
      <Frame x={152} y={106} w={100} h={26} r={2} />
      <path className={A} d="M170 44 l6 6 l12 -13" />
      <path className={A} d="M170 82 l6 6 l12 -13" />
      <path className={A} d="M170 120 l6 6 l12 -13" />
    </>
  ),
  // 06 Applicant agent — certificate checked before release
  '06': (
    <>
      <path className={F} d="M70 20 L124 42 V92 C124 122 100 140 70 150 C40 140 16 122 16 92 V42 Z" />
      <path className={A} d="M46 84 l16 16 l30 -34" />
      <Frame x={150} y={34} w={104} h={36} r={2} />
      <Frame x={150} y={86} w={104} h={36} r={-2} />
      <Lines x={162} y={48} w={68} n={2} r={2} cx={202} cy={52} />
      <Lines x={162} y={100} w={68} n={2} r={-2} cx={202} cy={104} />
      <line className={A} x1={126} y1={62} x2={148} y2={52} />
      <line className={A} x1={126} y1={96} x2={148} y2={104} />
    </>
  ),
  // 07 Employer agent — verification both ways
  '07': (
    <>
      <circle className={F} cx={56} cy={84} r={34} />
      <circle className={F} cx={212} cy={84} r={34} />
      <path className={A} d="M46 74 l10 10 l18 -20" />
      <path className={A} d="M202 74 l10 10 l18 -20" />
      <path className={A} d="M94 70 L172 70" />
      <path className={A} d="M164 62 l10 8 l-10 8" />
      <path className={A} d="M174 100 L96 100" />
      <path className={A} d="M104 92 l-10 8 l10 8" />
      <Frame x={108} y={20} w={52} h={22} r={-3} />
    </>
  ),
  // 08 Audit — a log, and a blocked attack
  '08': (
    <>
      <Frame x={14} y={22} w={122} h={128} r={-2} />
      {Array.from({ length: 6 }, (_, i) => (
        <g key={i}>
          <line className={L} x1={28} y1={42 + i * 19} x2={104} y2={42 + i * 19} />
          <circle className={i === 3 ? A : L} cx={118} cy={38 + i * 19} r={3} />
        </g>
      ))}
      <path className={F} d="M212 24 L258 44 V88 C258 114 238 128 212 136 C186 128 166 114 166 88 V44 Z" />
      <line className={A} x1={192} y1={62} x2={232} y2={100} />
      <line className={A} x1={232} y1={62} x2={192} y2={100} />
    </>
  ),
  // 09 Analytics — callback rate decaying over time
  '09': (
    <>
      <Frame x={16} y={20} w={240} h={132} r={0} />
      <line className={L} x1={40} y1={132} x2={238} y2={132} />
      <line className={L} x1={40} y1={36} x2={40} y2={132} />
      <path className={A} d="M40 52 C88 58 104 92 136 104 C170 117 204 122 238 124" />
      {[52, 70, 92, 108, 118, 124].map((y, i) => (
        <circle key={i} className={A} cx={40 + i * 39.6} cy={y} r={3.5} />
      ))}
      {[0, 1, 2, 3].map((i) => (
        <line key={i} className={L} x1={40} y1={56 + i * 25} x2={238} y2={56 + i * 25} opacity={0.35} />
      ))}
    </>
  ),
};

export function StageArt({ id }: { id: string }) {
  return (
    <svg className="art" viewBox="0 0 270 170" aria-hidden="true" focusable="false">
      {SCENES[id]}
    </svg>
  );
}

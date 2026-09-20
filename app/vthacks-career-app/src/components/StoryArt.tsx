'use client';

import { motion, useInView, useReducedMotion } from 'motion/react';
import type { MotionProps } from 'motion/react';
import { useRef } from 'react';

import { AgentFace } from './AgentFace';

/**
 * The art for each beat of the architecture rail.
 *
 * These were photographs, and the photographs were shot dark — which on a navy
 * band read as eleven black rectangles. They are diagrams now: line drawings in
 * `currentColor` on paper, animated, each one showing the thing its caption
 * says rather than illustrating a mood.
 *
 * Three rules hold across all of them.
 *
 * 1. Every shape's plain SVG attributes are authored at the RESTING state and
 *    the animation is additive. Drop the animation — off screen, or under
 *    prefers-reduced-motion — and what is left is a correct still diagram, not
 *    an empty frame.
 * 2. Nothing animates off screen. `useInView` gates the whole card, so eleven
 *    looping SVGs cost one card's worth of work, not eleven.
 * 3. `aria-hidden`, always. The caption beside the card already carries the
 *    meaning in text; a screen reader should not meet the drawing twice.
 */

const BOX = '0 0 300 200';

/** Looping keyframes, or nothing at all when the card is still. */
function loop(
  still: boolean,
  animate: MotionProps['animate'],
  transition: MotionProps['transition'],
): MotionProps {
  if (still) return {};
  return { animate, transition: { repeat: Infinity, ease: 'easeInOut', ...transition } };
}

/**
 * scaleX/scaleY on an SVG shape needs its own box as the origin, or the
 * transform pivots around the whole canvas.
 *
 * These must be Motion's own `originX`/`originY`, not a plain
 * `transformOrigin` string: Motion writes `transform-origin` itself from those
 * two values and defaults both to 0.5, so a hand-written `transformOrigin` is
 * overwritten and every bar grows out of its own middle instead of its left
 * edge.
 */
const fromLeft = { transformBox: 'fill-box', originX: 0, originY: 0.5 } as const;
const fromBottom = { transformBox: 'fill-box', originX: 0.5, originY: 1 } as const;
const fromCenter = { transformBox: 'fill-box', originX: 0.5, originY: 0.5 } as const;

type ArtProps = { still: boolean };

/* --- 01 · a hundred applications, three answered ------------------------- */

const CELLS = Array.from({ length: 100 }, (_, i) => i);
const ANSWERED = new Set([13, 46, 82]);

function Applications({ still }: ArtProps) {
  return (
    <svg className="art" viewBox={BOX} aria-hidden="true">
      {CELLS.map((i) => {
        const kept = ANSWERED.has(i);
        return (
          <motion.rect
            key={i}
            x={78 + (i % 10) * 15}
            y={28 + Math.floor(i / 10) * 15}
            width={9}
            height={9}
            fill="currentColor"
            fillOpacity={kept ? 1 : 0.08}
            {...loop(
              still,
              { fillOpacity: kept ? [0, 1, 1, 1] : [0, 0.9, 0.9, 0.08] },
              { duration: 4.2, times: [0, 0.18, 0.5, 0.78], delay: i * 0.012 },
            )}
          />
        );
      })}
    </svg>
  );
}

/* --- 02 · the same fields, on every site --------------------------------- */

const SITES = [15, 108, 201];
const FIELDS = [0, 1, 2, 3];

function Forms({ still }: ArtProps) {
  return (
    <svg className="art" viewBox={BOX} aria-hidden="true">
      {SITES.map((x, site) => (
        <g key={x}>
          <rect x={x} y={28} width={84} height={144} fill="none" stroke="currentColor" strokeOpacity={0.22} />
          <rect x={x} y={28} width={84} height={13} fill="currentColor" fillOpacity={0.12} />
          {FIELDS.map((f) => (
            <g key={f}>
              <rect x={x + 11} y={60 + f * 27} width={62} height={6} fill="currentColor" fillOpacity={0.1} />
              <motion.rect
                x={x + 11}
                y={60 + f * 27}
                width={62}
                height={6}
                fill="currentColor"
                fillOpacity={0.8}
                style={fromLeft}
                {...loop(
                  still,
                  { scaleX: [0, 1, 1, 0] },
                  { duration: 4.6, times: [0, 0.07, 0.86, 1], delay: (site * 4 + f) * 0.11 },
                )}
              />
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}

/* --- 03 · the hours pile up, the replies do not -------------------------- */

const WEEKS = [34, 50, 62, 76, 88, 102, 116, 130];

function Hours({ still }: ArtProps) {
  return (
    <svg className="art" viewBox={BOX} aria-hidden="true">
      {WEEKS.map((h, i) => (
        <motion.rect
          key={i}
          x={40 + i * 29}
          y={156 - h}
          width={17}
          height={h}
          fill="currentColor"
          fillOpacity={0.8}
          style={fromBottom}
          {...loop(still, { scaleY: [0, 1, 1, 0] }, { duration: 5, times: [0, 0.12, 0.88, 1], delay: i * 0.16 })}
        />
      ))}
      <rect x={34} y={156} width={238} height={1} fill="currentColor" fillOpacity={0.35} />
      <text x={34} y={180}>
        8 WEEKS OF EVENINGS
      </text>
      <text x={272} y={180} textAnchor="end">
        0 REPLIES
      </text>
    </svg>
  );
}

/* --- 04 · the posting that was never a job ------------------------------- */

const GHOST_LINES = [0, 1, 2, 3, 4];

function Ghost({ still }: ArtProps) {
  return (
    <svg className="art" viewBox={BOX} aria-hidden="true">
      <rect x={66} y={24} width={168} height={152} fill="none" stroke="currentColor" strokeOpacity={0.3} />
      <motion.g
        {...loop(still, { opacity: [0, 1, 1, 0, 0] }, { duration: 5.2, times: [0, 0.14, 0.44, 0.58, 1] })}
        opacity={0}
      >
        <rect x={82} y={44} width={92} height={10} fill="currentColor" fillOpacity={0.85} />
        {GHOST_LINES.map((l) => (
          <rect
            key={l}
            x={82}
            y={72 + l * 18}
            width={l === 4 ? 78 : 136}
            height={6}
            fill="currentColor"
            fillOpacity={0.35}
          />
        ))}
      </motion.g>
      <motion.text
        className="art__glyph"
        x={150}
        y={118}
        textAnchor="middle"
        opacity={1}
        {...loop(still, { opacity: [0, 0, 0, 1, 1, 0] }, { duration: 5.2, times: [0, 0.44, 0.6, 0.72, 0.92, 1] })}
      >
        ?
      </motion.text>
    </svg>
  );
}

/* --- 06 · say it out loud ------------------------------------------------ */

const WAVE = Array.from({ length: 23 }, (_, i) => i);
const WAVE_H = [0.3, 0.55, 0.85, 0.45, 1, 0.7, 0.35, 0.9, 0.6, 0.4, 0.75];

function Voice({ still }: ArtProps) {
  return (
    <svg className="art" viewBox={BOX} aria-hidden="true">
      {WAVE.map((i) => (
        <motion.rect
          key={i}
          x={38 + i * 10}
          y={48}
          width={4}
          height={72}
          fill="currentColor"
          fillOpacity={0.8}
          style={fromCenter}
          {...loop(
            still,
            { scaleY: [0.16, WAVE_H[i % WAVE_H.length], 0.16] },
            { duration: 1.5, delay: i * 0.055 },
          )}
        />
      ))}

      {/* A caret and a line of speech, typed out by a clip that widens. */}
      <clipPath id="story-type">
        <motion.rect
          x={34}
          y={140}
          height={22}
          width={216}
          {...loop(still, { width: [0, 216, 216, 0] }, { duration: 5.6, times: [0, 0.4, 0.9, 1] })}
        />
      </clipPath>
      <text className="art__said" x={36} y={156} clipPath="url(#story-type)">
        find me backend roles in Blacksburg
      </text>
      <motion.rect
        x={252}
        y={145}
        width={2}
        height={13}
        fill="currentColor"
        {...loop(still, { opacity: [1, 1, 0, 0] }, { duration: 1, ease: 'linear', times: [0, 0.49, 0.5, 1] })}
      />
    </svg>
  );
}

/* --- 07 · resume in, ranked roles out ----------------------------------- */

const MATCHES = [
  { y: 62, score: 0.91 },
  { y: 100, score: 0.78 },
  { y: 138, score: 0.62 },
];

function Match({ still }: ArtProps) {
  return (
    <svg className="art" viewBox={BOX} aria-hidden="true">
      {/* The resume. */}
      <rect x={20} y={50} width={72} height={100} fill="none" stroke="currentColor" strokeOpacity={0.3} />
      {[0, 1, 2, 3, 4].map((l) => (
        <rect
          key={l}
          x={30}
          y={64 + l * 16}
          width={l === 0 ? 34 : 52}
          height={l === 0 ? 8 : 5}
          fill="currentColor"
          fillOpacity={l === 0 ? 0.8 : 0.3}
        />
      ))}

      <motion.path
        d="M92 100 H128"
        stroke="currentColor"
        strokeOpacity={0.5}
        fill="none"
        {...loop(still, { pathLength: [0, 1, 1] }, { duration: 4.4, times: [0, 0.2, 1] })}
      />
      <path d="M124 96 L130 100 L124 104" stroke="currentColor" strokeOpacity={0.5} fill="none" />

      {MATCHES.map((m, i) => (
        <g key={m.y}>
          <rect x={136} y={m.y - 17} width={58} height={6} fill="currentColor" fillOpacity={0.3} />
          <rect x={136} y={m.y - 4} width={96} height={8} fill="currentColor" fillOpacity={0.12} />
          <motion.rect
            x={136}
            y={m.y - 4}
            width={96 * m.score}
            height={8}
            fill="currentColor"
            fillOpacity={0.85}
            style={fromLeft}
            {...loop(
              still,
              { scaleX: [0, 1, 1, 0] },
              { duration: 4.4, times: [0, 0.28, 0.9, 1], delay: 0.6 + i * 0.18 },
            )}
          />
          <text x={272} y={m.y + 4} textAnchor="end">
            {m.score.toFixed(2)}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* --- 08 · five dimensions, each with a reason ---------------------------- */

const TRUST = [
  { label: 'INTEGRITY', v: 0.88 },
  { label: 'IDENTITY', v: 0.96 },
  { label: 'SOLVENCY', v: 0.74 },
  { label: 'BEHAVIOR', v: 0.91 },
  { label: 'SAFETY', v: 0.98 },
];

function Trust({ still }: ArtProps) {
  return (
    <svg className="art" viewBox={BOX} aria-hidden="true">
      {TRUST.map((d, i) => {
        const y = 32 + i * 34;
        return (
          <g key={d.label}>
            <text x={20} y={y + 4}>
              {d.label}
            </text>
            <rect x={110} y={y - 4} width={136} height={8} fill="currentColor" fillOpacity={0.12} />
            <motion.rect
              x={110}
              y={y - 4}
              width={136 * d.v}
              height={8}
              fill="currentColor"
              fillOpacity={0.85}
              style={fromLeft}
              {...loop(
                still,
                { scaleX: [0, 1, 1, 0] },
                { duration: 4.8, times: [0, 0.2, 0.9, 1], delay: i * 0.22 },
              )}
            />
            <motion.path
              d={`M258 ${y} l4 4 l7 -9`}
              stroke="currentColor"
              strokeWidth={2}
              fill="none"
              {...loop(
                still,
                { pathLength: [0, 0, 1, 1, 0] },
                { duration: 4.8, times: [0, 0.2, 0.34, 0.9, 1], delay: i * 0.22 },
              )}
            />
          </g>
        );
      })}
    </svg>
  );
}

/* --- 09 / 10 · one agent asks the other to prove it ---------------------- */

function AgentNode({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={27} fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.4} />
      <circle cx={x - 8} cy={y - 5} r={2.6} fill="currentColor" />
      <circle cx={x + 8} cy={y - 5} r={2.6} fill="currentColor" />
      <path
        d={`M${x - 9} ${y + 8} Q${x} ${y + 15} ${x + 9} ${y + 8}`}
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        fill="none"
      />
      <text x={x} y={y + 52} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

function Handshake({ still, reverse = false }: ArtProps & { reverse?: boolean }) {
  const from = reverse ? 208 : 82;
  const to = reverse ? 82 : 208;
  // The tick belongs to whoever just proved themselves, and sits above their
  // head rather than below it — below is where the label lives.
  const checkX = reverse ? 51 : 235;

  return (
    <svg className="art" viewBox={BOX} aria-hidden="true">
      <path d="M86 88 H204" stroke="currentColor" strokeOpacity={0.22} fill="none" />
      <motion.path
        d={reverse ? 'M204 88 H86' : 'M86 88 H204'}
        stroke="currentColor"
        strokeOpacity={0.7}
        fill="none"
        {...loop(still, { pathLength: [0, 1, 1, 0] }, { duration: 4.4, times: [0, 0.34, 0.88, 1] })}
      />
      <motion.rect
        x={from - 5}
        y={83}
        width={10}
        height={10}
        fill="currentColor"
        opacity={0}
        {...loop(
          still,
          { x: [from - 5, to - 5], opacity: [0, 1, 1, 0] },
          { duration: 4.4, times: [0, 0.1, 0.32, 0.4] },
        )}
      />
      <AgentNode x={58} y={88} label="YOUR AGENT" />
      <AgentNode x={242} y={88} label="THEIR AGENT" />
      <motion.path
        d={`M${checkX} 36 l5 5 l9 -11`}
        stroke="currentColor"
        strokeWidth={2.2}
        fill="none"
        {...loop(still, { pathLength: [0, 0, 1, 1, 0] }, { duration: 4.4, times: [0, 0.4, 0.55, 0.9, 1] })}
      />
    </svg>
  );
}

/* --- 11 · they keep talking; you decide once ---------------------------- */

const VOLLEYS = [0, 1, 2, 3];

function Negotiation({ still }: ArtProps) {
  return (
    <svg className="art" viewBox={BOX} aria-hidden="true">
      <path d="M84 62 H216" stroke="currentColor" strokeOpacity={0.22} fill="none" />
      <path d="M150 62 V130" stroke="currentColor" strokeOpacity={0.22} fill="none" />

      {/* Four packets crossing, alternating direction, permanently out of
          phase — the point being that this does not stop at one exchange. */}
      {VOLLEYS.map((v) => {
        const rtl = v % 2 === 1;
        return (
          <motion.rect
            key={v}
            x={rtl ? 205 : 85}
            y={57}
            width={9}
            height={9}
            fill="currentColor"
            opacity={0}
            {...loop(
              still,
              { x: rtl ? [205, 85] : [85, 205], opacity: [0, 1, 1, 0] },
              { duration: 1.9, ease: 'linear', times: [0, 0.12, 0.8, 1], delay: v * 0.95 },
            )}
          />
        );
      })}

      {/* One packet, once, to the human. */}
      <motion.rect
        x={145}
        y={70}
        width={9}
        height={9}
        fill="currentColor"
        opacity={0}
        {...loop(
          still,
          { y: [70, 118], opacity: [0, 0, 1, 1, 0] },
          { duration: 7.6, times: [0, 0.74, 0.79, 0.88, 0.93] },
        )}
      />

      <AgentNode x={58} y={62} label="YOUR AGENT" />
      <AgentNode x={242} y={62} label="THEIR AGENT" />
      <circle cx={150} cy={152} r={21} fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.4} />
      <motion.path
        d="M142 152 l5 6 l11 -13"
        stroke="currentColor"
        strokeWidth={2.2}
        fill="none"
        {...loop(still, { pathLength: [0, 0, 1, 1, 0] }, { duration: 7.6, times: [0, 0.88, 0.93, 0.98, 1] })}
      />
      <text x={150} y={190} textAnchor="middle">
        YOU APPROVE
      </text>
    </svg>
  );
}

/* --- The switch ---------------------------------------------------------- */

const ART: Record<string, (p: ArtProps) => React.ReactElement> = {
  '01': Applications,
  '02': Forms,
  '03': Hours,
  '04': Ghost,
  '06': Voice,
  '07': Match,
  '08': Trust,
  '09': Handshake,
  '10': (p) => <Handshake {...p} reverse />,
  '11': Negotiation,
};

export function StoryArt({ n }: { n: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const inView = useInView(ref, { amount: 0.3 });
  const still = Boolean(reduced) || !inView;

  // 05 is the turn: at the moment the copy says we built it, show the agent
  // itself rather than a diagram of one.
  //
  // The FLAT face, not AgentFaceLive. The 3D head is ~880 KB of three.js and
  // renders nothing at all where WebGL is unavailable — which is a bad bet on a
  // borrowed machine at a demo, for a card that is one of eleven. The flat face
  // is the same character in the same line-art idiom as the other ten drawings,
  // and it animates without a GPU. The 3D head still leads the hero and the
  // voice widget, where it earns its weight.
  const Draw = ART[n];

  return (
    <div className="stage__art" ref={ref}>
      {Draw ? <Draw still={still} /> : <AgentFace mood="happy" size={330} />}
    </div>
  );
}

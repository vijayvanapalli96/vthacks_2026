/**
 * presage.ts — Presage SmartSpectra, reading steadiness off the interview webcam.
 *
 * READ THIS BEFORE TOUCHING THE FEATURE.
 *
 * 1. CLAUDE.md lists Presage under "out of scope — decided". That decision was
 *    reversed deliberately by the repo owner on 2026-09-20 for the mock interview,
 *    and only for the mock interview. It is not a licence to put vitals anywhere
 *    else in the product, and least of all anywhere an employer can see them.
 *
 * 2. PRESAGE'S OWN DOCUMENTATION says the metrics are "offered for general wellness
 *    and informational purposes only" and "have not been cleared by the FDA and may
 *    not be used for medical diagnosis or treatment". So what this feature produces
 *    is a nerves read a student sees about their own practice session. It is never a
 *    score, never part of a hiring decision, never shown to an employer, and never
 *    written anywhere keyed to anything but this session. Hard rule 8 in our own UI.
 *
 * 3. THE SDK IS A DEPENDENCY BUT IS STILL LOADED LATE. `@smartspectra/node-sdk`
 *    resolves native platform packages at runtime, so it is imported through a
 *    dynamic specifier the bundler cannot follow, behind a PRESAGE_API_KEY check.
 *    A checkout or a container where the native package does not resolve therefore
 *    still builds, typechecks and runs, with the panel saying the read is off — the
 *    failure is one panel, not the site. Verified loading on Windows on 2026-09-20;
 *    the enum values this file pins (kRGBA=2, kNone=0) were checked against the
 *    installed package, not against the docs.
 *
 * HOW THE FRAMES GET HERE. The browser already holds a webcam stream for the
 * self-view. It draws it to a small canvas, encodes JPEG, and posts batches to
 * /api/interview/[jobId]/vitals. This file decodes each JPEG to RGBA with jpeg-js and
 * pushes it to `sendFrame`. JPEG rather than raw pixels because raw RGBA at any
 * useful frame rate is megabytes a second, and the public demo runs over the open
 * internet to a Vultr box, not over localhost.
 *
 * WHY STATE LIVES IN A MODULE MAP. An SDK measurement is a stateful stream: frames
 * have to reach the same instance in order. That is fine here — the app runs as one
 * long-lived Node process behind Caddy (server.mjs), not as per-request functions. On
 * a platform that scales to many instances this would need pinning, and it says so.
 */
import { decode as decodeJpeg } from 'jpeg-js';

import { CONFIDENCE_FLOOR, emptyVitals, type VitalsSample, type VitalsSummary } from '@/lib/interview-contract';

/** kRGBA, from the SDK's PixelFormat enum. Named rather than inlined as 2. */
const PIXEL_FORMAT_RGBA = 2;
/** kNone, from the SDK's FrameTransform enum. The browser mirrors its own preview. */
const FRAME_TRANSFORM_NONE = 0;

/** Keep memory flat on a long session: the summary is folded as samples arrive. */
const MAX_SAMPLES = 600;

/** A session nobody has pushed a frame to in this long is abandoned. Reaped on touch. */
const IDLE_MS = 10 * 60 * 1000;

/** Bigger than a 640x480 JPEG has any business being. A guard, not a tuning knob. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export class PresageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PresageError';
  }
}

function apiKey(): string | null {
  return process.env.PRESAGE_API_KEY?.trim() || null;
}

/**
 * Whether the vitals path will do anything.
 *
 * Only the KEY is checked, not the SDK. Probing the module here would mean an await
 * in a function every page load calls, and the room's honest answer to "is this on"
 * is decided by configuration. A key set without the module installed surfaces as a
 * clear message on the first frame batch instead.
 */
export function vitalsReady(): boolean {
  return apiKey() !== null;
}

/* ------------------------------------------------------- the SDK, loaded late */

type SdkInstance = {
  useCustomInput: (transform: number) => unknown;
  start: () => void;
  stopAsync?: () => Promise<void>;
  stop?: () => void;
  destroy?: () => Promise<void>;
  sendFrame: (
    buffer: Uint8Array,
    width: number,
    height: number,
    stride: number,
    pixelFormat: number,
    timestampUs: number,
  ) => boolean;
  on: (event: string, handler: (...args: unknown[]) => void) => unknown;
};

type SdkModule = {
  SmartSpectraSDK: new (options: Record<string, unknown>) => SdkInstance;
  decodeMetrics?: (buffer: unknown) => unknown;
  /**
   * Metric group bundles. REQUESTING THEM IS NOT OPTIONAL: omitting
   * `requestedMetrics` defaults to the breathing bundle alone, so pulse and
   * expression would come back empty for a panel that shows all three.
   */
  cardioMetrics?: number[];
  breathingMetrics?: number[];
  faceMetrics?: number[];
};

let modulePromise: Promise<SdkModule> | null = null;

/**
 * Load the SDK once, lazily.
 *
 * The specifier is held in a variable so the bundler cannot follow it and try to
 * resolve a package that is deliberately absent. That is the whole trick, and it is
 * also why every route that can reach this sets `runtime = 'nodejs'`.
 */
function loadSdk(): Promise<SdkModule> {
  if (!modulePromise) {
    const specifier = '@smartspectra/node-sdk';
    modulePromise = import(/* webpackIgnore: true */ specifier).then(
      (mod) => mod as SdkModule,
      (cause) => {
        modulePromise = null;
        throw new PresageError(
          'PRESAGE_API_KEY is set but @smartspectra/node-sdk is not installed. Run: npm install @smartspectra/node-sdk',
          { cause },
        );
      },
    );
  }
  return modulePromise;
}

/* ----------------------------------------------------------------- sessions */

type Session = {
  sdk: SdkInstance;
  startedAt: number;
  touchedAt: number;
  latest: VitalsSample | null;
  /** Folded as samples arrive so a long interview does not grow without bound. */
  summary: VitalsSummary;
  pulseSum: number;
  pulseCount: number;
  breathingSum: number;
  breathingCount: number;
  expressions: Map<string, number>;
  /** Frames accepted, for the honest "we pushed N frames" line in telemetry. */
  frames: number;
};

const sessions = new Map<string, Session>();

function reapIdle(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.touchedAt > IDLE_MS) {
      void stopSdk(session);
      sessions.delete(id);
    }
  }
}

async function stopSdk(session: Session): Promise<void> {
  try {
    if (session.sdk.stopAsync) await session.sdk.stopAsync();
    else session.sdk.stop?.();
    await session.sdk.destroy?.();
  } catch (error) {
    console.error('[presage] shutting a measurement down failed:', (error as Error).message);
  }
}

/**
 * Open a measurement for one interview session, or return the open one.
 *
 * The three bundles are requested explicitly. The SDK's default is BREATHING ONLY,
 * which would leave the pulse and face rows of the panel permanently reading — the
 * kind of bug that looks like a broken camera rather than a wrong constant. They are
 * read off the loaded module rather than imported at the top of the file, because the
 * whole point of the dynamic import is that this module must not be resolved when the
 * SDK is absent.
 */
async function openSession(sessionId: string): Promise<Session> {
  reapIdle();
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const key = apiKey();
  if (!key) throw new PresageError('PRESAGE_API_KEY is not set.');

  const { SmartSpectraSDK, decodeMetrics, cardioMetrics, breathingMetrics, faceMetrics } = await loadSdk();
  const requestedMetrics = [...(cardioMetrics ?? []), ...(breathingMetrics ?? []), ...(faceMetrics ?? [])];
  const sdk = new SmartSpectraSDK({
    apiKey: key,
    ...(requestedMetrics.length ? { requestedMetrics } : {}),
    enableTelemetry: false,
  });

  const session: Session = {
    sdk,
    startedAt: Date.now(),
    touchedAt: Date.now(),
    latest: null,
    summary: emptyVitals(),
    pulseSum: 0,
    pulseCount: 0,
    breathingSum: 0,
    breathingCount: 0,
    expressions: new Map(),
    frames: 0,
  };

  sdk.on('metrics', (...args: unknown[]) => {
    try {
      const decoded = decodeMetrics ? decodeMetrics(args[0]) : args[0];
      const sample = normalise(decoded);
      if (sample) fold(session, sample);
    } catch (error) {
      console.error('[presage] could not read a metrics frame:', (error as Error).message);
    }
  });
  sdk.on('error', (...args: unknown[]) => {
    console.error('[presage] sdk error:', String(args[0]));
  });

  sdk.useCustomInput(FRAME_TRANSFORM_NONE);
  sdk.start();

  sessions.set(sessionId, session);
  return session;
}

/**
 * Turn the decoded Metrics payload into our sample shape, or null.
 *
 * THE PATHS ARE THE DOCUMENTED ONES, verified against the installed package on
 * 2026-09-20: `cardio.pulseRate`, `breathing.rate` and `face.expression` are each an
 * array of readings over time, and the LAST entry is the current one. Pulse and
 * breathing entries are MeasurementWithConfidence, so the confidence travels with the
 * value rather than sitting at the root.
 *
 * `pick` is still used for the leaf names because the SDK decodes protobuf, and
 * protobuf field names reach JavaScript as either camelCase or snake_case depending
 * on the generator. Reading both costs nothing and removes a whole class of silent
 * empty panel.
 */
function normalise(decoded: unknown): VitalsSample | null {
  if (!decoded || typeof decoded !== 'object') return null;
  logShapeOnce(decoded);

  const root = decoded as Record<string, unknown>;
  const pulse = latest(pick(pick(root, ['cardio']), ['pulseRate', 'pulse_rate']));
  const breathing = latest(pick(pick(root, ['breathing']), ['rate']));
  const face = latest(pick(pick(root, ['face']), ['expression']));

  const pulseBpm = num(pick(pulse, ['value']));
  const breathingBpm = num(pick(breathing, ['value']));

  // The higher of the two confidences, not an average: they are measurements of
  // different things over different windows, and averaging them would let a settled
  // breathing reading drag a fresh pulse reading below the floor.
  const confidence = Math.max(num(pick(pulse, ['confidence'])) ?? 0, num(pick(breathing, ['confidence'])) ?? 0);

  const expression = readExpression(face);
  const talking = bool(pick(face, ['talking', 'isTalking', 'is_talking']));

  if (pulseBpm === null && breathingBpm === null && expression === null && talking === null) return null;

  return { pulseBpm, breathingBpm, confidence, expression, talking, at: Date.now() };
}

/** The current reading from a time series. Anything not an array is passed through. */
function latest(series: unknown): unknown {
  if (Array.isArray(series)) return series.length ? series[series.length - 1] : undefined;
  return series;
}

let shapeLogged = false;
function logShapeOnce(decoded: object): void {
  if (shapeLogged) return;
  shapeLogged = true;
  console.info('[presage] first decoded metrics payload had keys:', Object.keys(decoded).join(', '));
}

function pick(source: unknown, keys: string[]): unknown {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
}

function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/**
 * Strongest expression and its probability.
 *
 * `face.expression.at(-1)` is an Expression object whose per-emotion probabilities
 * may arrive as a map (anger/contempt/.../neutral), as a list of {label, probability},
 * or already reduced to a single label. All three are read, because the decoded
 * protobuf shape is the one thing here not pinned by the published docs.
 */
function readExpression(entry: unknown): { label: string; probability: number } | null {
  const raw = pick(entry, ['expression', 'expressions', 'emotion', 'emotions', 'probabilities']) ?? entry;
  if (!raw || typeof raw === 'number') return null;

  if (Array.isArray(raw)) {
    let best: { label: string; probability: number } | null = null;
    for (const entry of raw) {
      const label = pick(entry, ['label', 'name', 'expression']);
      const probability = num(pick(entry, ['probability', 'score', 'value'])) ?? 0;
      if (typeof label === 'string' && (!best || probability > best.probability)) best = { label, probability };
    }
    return best;
  }

  if (typeof raw === 'object') {
    let best: { label: string; probability: number } | null = null;
    for (const [label, value] of Object.entries(raw as Record<string, unknown>)) {
      const probability = num(value);
      if (probability !== null && (!best || probability > best.probability)) best = { label, probability };
    }
    return best;
  }

  return typeof raw === 'string' ? { label: raw, probability: 1 } : null;
}

/** Fold one sample into the running summary. Only samples above the floor count. */
function fold(session: Session, sample: VitalsSample): void {
  session.latest = sample;
  session.summary.samples = Math.min(session.summary.samples + 1, MAX_SAMPLES);
  if (sample.confidence < CONFIDENCE_FLOOR) return;

  session.summary.usable += 1;

  if (sample.pulseBpm !== null) {
    session.pulseSum += sample.pulseBpm;
    session.pulseCount += 1;
    session.summary.meanPulseBpm = session.pulseSum / session.pulseCount;
    session.summary.peakPulseBpm = Math.max(session.summary.peakPulseBpm ?? 0, sample.pulseBpm);
  }
  if (sample.breathingBpm !== null) {
    session.breathingSum += sample.breathingBpm;
    session.breathingCount += 1;
    session.summary.meanBreathingBpm = session.breathingSum / session.breathingCount;
  }
  if (sample.expression) {
    session.expressions.set(sample.expression.label, (session.expressions.get(sample.expression.label) ?? 0) + 1);
    session.summary.expressions = [...session.expressions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label]) => label);
  }
}

/* -------------------------------------------------------------------- frames */

export type FramePush = { jpeg: Uint8Array; timestampUs: number };

/**
 * Decode and push a batch of frames. Returns the latest reading and the summary.
 *
 * A frame that will not decode is SKIPPED, not fatal: one corrupt JPEG in a batch of
 * fifteen is a dropped frame, and killing the measurement over it would lose the
 * whole reading.
 */
export async function pushFrames(
  sessionId: string,
  frames: FramePush[],
): Promise<{ latest: VitalsSample | null; summary: VitalsSummary; accepted: number; skipped: number }> {
  const session = await openSession(sessionId);
  session.touchedAt = Date.now();

  let accepted = 0;
  let skipped = 0;
  for (const frame of frames) {
    if (frame.jpeg.byteLength === 0 || frame.jpeg.byteLength > MAX_FRAME_BYTES) {
      skipped += 1;
      continue;
    }
    try {
      // useTArray keeps the result a Uint8Array rather than a Node Buffer copy.
      const image = decodeJpeg(frame.jpeg, { useTArray: true, formatAsRGBA: true });
      const ok = session.sdk.sendFrame(
        image.data,
        image.width,
        image.height,
        image.width * 4,
        PIXEL_FORMAT_RGBA,
        frame.timestampUs,
      );
      if (ok) accepted += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  session.frames += accepted;
  return { latest: session.latest, summary: session.summary, accepted, skipped };
}

/** The reading so far without pushing anything. Null session is not an error. */
export function readVitals(sessionId: string): { latest: VitalsSample | null; summary: VitalsSummary } {
  const session = sessions.get(sessionId);
  if (!session) return { latest: null, summary: emptyVitals() };
  return { latest: session.latest, summary: session.summary };
}

/** Close the measurement and hand back the final summary. Safe to call twice. */
export async function closeVitals(sessionId: string): Promise<VitalsSummary> {
  const session = sessions.get(sessionId);
  if (!session) return emptyVitals();
  sessions.delete(sessionId);
  const summary = session.summary;
  await stopSdk(session);
  return summary;
}

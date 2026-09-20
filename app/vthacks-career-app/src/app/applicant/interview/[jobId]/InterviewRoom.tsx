'use client';

/**
 * InterviewRoom — the mock interview, on camera, once an employer has replied.
 *
 * THE CAMERA NEVER OPENS BY ITSELF. Same rule VoiceAgent.tsx holds for the
 * microphone, and for the same reason: grabbing a camera unasked is a consent
 * problem before it is anything else. There is one button, the student presses it,
 * and the browser's own permission prompt follows. Refusing it leaves a fully
 * working typed interview behind, not a broken page.
 *
 * WHAT THE CAMERA IS FOR, IN ORDER OF HONESTY:
 *   1. The self-view. Rehearsing to your own face is most of the value and it needs
 *      no server, no key and no SDK. This works in every checkout.
 *   2. Frames for Presage, when PRESAGE_API_KEY is set. Those are posted in ~1s
 *      batches, decoded server-side, pushed into a measurement and dropped. No
 *      frame is stored anywhere, by this component or by the route it posts to.
 * The video stream is NEVER recorded and NEVER uploaded as video. If that ever
 * changes it needs a consent conversation, not a commit.
 *
 * FOUR THINGS CAN BE OFF AND THE ROOM STILL WORKS. Gemini (questions), ElevenLabs
 * (the interviewer's voice), Scribe (speech to text) and Presage (steadiness) are
 * independent. Each missing one is a sentence in the "what is switched off" list,
 * which is rendered as prose rather than hidden behind an icon, because a student
 * who cannot see why the mic button is absent will assume the page is broken.
 *
 * ACCESSIBILITY, as typed:
 *   * One question on screen at a time, in a live region, so a screen reader hears
 *     it when it changes rather than on a re-read of the page.
 *   * Real buttons and a real textarea. The answer box is the primary control and
 *     it is reachable with one Tab from the question.
 *   * Recording state is announced in words, never by a red dot alone.
 *   * The vitals panel is `aria-live="off"` on purpose: a number that changes every
 *     second would make a screen reader unusable. It is read on demand, and the one
 *     sentence that matters is in the closing readout.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CONFIDENCE_FLOOR,
  QUESTION_KIND_LABEL,
  QUESTION_SOURCE_LABEL,
  emptyVitals,
  type AnswerCritique,
  type InterviewAnswer,
  type InterviewFeedback,
  type InterviewQuestion,
  type InterviewSessionPayload,
  type VitalsSample,
  type VitalsSummary,
} from '@/lib/interview-contract';

/* --------------------------------------------------------------- constants */

/**
 * Capture geometry and rate for the Presage frames.
 *
 * 480x360 at 15 fps in JPEG is about 350 KB/s. Presage's published guidance is that
 * pulse is valid between 40 and 110 bpm with the subject stationary; a lower frame
 * rate costs confidence rather than correctness, and the panel shows confidence, so
 * a weak reading is visible as a weak reading. Raw pixels at this rate would be ~10
 * MB/s, which the public Vultr box would not carry — hence JPEG and a server-side
 * decode.
 */
const CAPTURE_WIDTH = 480;
const CAPTURE_HEIGHT = 360;
const CAPTURE_FPS = 15;
const JPEG_QUALITY = 0.6;
/** One batch per second: current enough for a once-a-second panel, few enough requests. */
const BATCH_MS = 1000;

type Phase = 'brief' | 'live' | 'done';

type Props = {
  jobId: string;
  /** Rendered server-side too, so the page has a heading before this mounts. */
  jobTitle: string;
  company: string;
};

export function InterviewRoom({ jobId, jobTitle, company }: Props) {
  const [session, setSession] = useState<InterviewSessionPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('brief');
  const [index, setIndex] = useState(0);

  const [draft, setDraft] = useState('');
  const [answers, setAnswers] = useState<InterviewAnswer[]>([]);
  const [critiques, setCritiques] = useState<AnswerCritique[]>([]);
  const [feedback, setFeedback] = useState<InterviewFeedback | null>(null);

  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [vitals, setVitals] = useState<VitalsSample | null>(null);
  const [vitalsSummary, setVitalsSummary] = useState<VitalsSummary>(emptyVitals());
  const [vitalsOff, setVitalsOff] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const spokeAtRef = useRef<number | null>(null);
  const answerBoxRef = useRef<HTMLTextAreaElement | null>(null);
  /** Carried from the recording to the send, so pace is measured on real speech only. */
  const spokenSecondsRef = useRef<number | null>(null);

  /**
   * Everything the capture loop reads. It runs on a timer outside React's render,
   * so it must not close over state — the same one-ref discipline VoiceAgent.tsx
   * documents at length.
   */
  const live = useRef<{ sessionId: string | null; vitalsReady: boolean; stopped: boolean }>({
    sessionId: null,
    vitalsReady: false,
    stopped: false,
  });

  /* ------------------------------------------------------------- the session */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/interview/${encodeURIComponent(jobId)}/session`, { cache: 'no-store' });
        const payload = (await response.json()) as InterviewSessionPayload & { error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setLoadError(payload.error ?? `The interview room could not be prepared (${response.status}).`);
          return;
        }
        setSession(payload);
        live.current.sessionId = payload.sessionId;
        live.current.vitalsReady = payload.vitalsReady;
      } catch (error) {
        if (!cancelled) setLoadError((error as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  /* -------------------------------------------------------------- the camera */

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: CAPTURE_WIDTH }, height: { ideal: CAPTURE_HEIGHT }, facingMode: 'user' },
        // Audio on the same stream so "record my answer" needs one permission
        // prompt rather than two, and the mic is released with the camera.
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {
          // Autoplay policy can refuse even a muted stream; the element is still
          // live and the controls attribute lets the student start it.
        });
      }
      setCameraOn(true);
    } catch (error) {
      const name = (error as DOMException).name;
      setCameraError(
        name === 'NotAllowedError'
          ? 'The browser blocked the camera. The interview runs fine without it — your answers are typed or recorded.'
          : `The camera could not start (${name || 'unknown error'}). The interview runs fine without it.`,
      );
    }
  }, []);

  // Release the camera on unmount and when the tab is hidden. A rehearsal left open
  // in a background tab must not hold a camera light on.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') stopCamera();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      stopCamera();
    };
  }, [stopCamera]);

  /* -------------------------------------------------------------- the vitals */

  useEffect(() => {
    if (!cameraOn || phase !== 'live' || !session?.vitalsReady || vitalsOff) return;

    const canvas = document.createElement('canvas');
    canvas.width = CAPTURE_WIDTH;
    canvas.height = CAPTURE_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) return;

    let frames: { blob: Blob; at: number }[] = [];
    let disposed = false;

    const grab = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      context.drawImage(video, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);
      const at = performance.timeOrigin + performance.now();
      canvas.toBlob(
        (blob) => {
          if (blob && !disposed) frames.push({ blob, at });
        },
        'image/jpeg',
        JPEG_QUALITY,
      );
    };

    const flush = async () => {
      if (frames.length === 0 || disposed) return;
      const batch = frames;
      frames = [];
      const form = new FormData();
      form.append('sessionId', live.current.sessionId ?? '');
      form.append('timestamps', JSON.stringify(batch.map((frame) => Math.round(frame.at * 1000))));
      for (const frame of batch) form.append('frame', frame.blob, 'f.jpg');

      try {
        const response = await fetch(`/api/interview/${encodeURIComponent(jobId)}/vitals`, {
          method: 'POST',
          body: form,
        });
        const payload = (await response.json()) as {
          ok: boolean;
          reason?: string;
          latest?: VitalsSample | null;
          summary?: VitalsSummary;
        };
        if (disposed) return;
        if (!payload.ok) {
          // Stop posting frames the moment the server says it cannot use them.
          // Retrying a disabled feature fifteen times a second is the kind of thing
          // that gets a demo rate-limited.
          setVitalsOff(payload.reason ?? 'The steadiness read is unavailable.');
          return;
        }
        if (payload.latest) setVitals(payload.latest);
        if (payload.summary) setVitalsSummary(payload.summary);
      } catch {
        // A dropped batch is a dropped batch. The next one carries on.
      }
    };

    const grabTimer = window.setInterval(grab, Math.round(1000 / CAPTURE_FPS));
    const flushTimer = window.setInterval(() => void flush(), BATCH_MS);
    return () => {
      disposed = true;
      window.clearInterval(grabTimer);
      window.clearInterval(flushTimer);
    };
  }, [cameraOn, phase, session?.vitalsReady, vitalsOff, jobId]);

  /* ----------------------------------------------------------- the recording */

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) {
      setNotice('Turn the camera and microphone on first, or type the answer.');
      return;
    }
    const audio = new MediaStream(stream.getAudioTracks());
    if (audio.getAudioTracks().length === 0) {
      setNotice('No microphone on this stream. Type the answer instead.');
      return;
    }
    chunksRef.current = [];
    const recorder = new MediaRecorder(audio);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.start();
    recorderRef.current = recorder;
    spokeAtRef.current = Date.now();
    setRecording(true);
    setNotice('Recording your answer. Press stop when you are done.');
  }, []);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    const seconds = spokeAtRef.current ? (Date.now() - spokeAtRef.current) / 1000 : null;

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await stopped;
    recorderRef.current = null;
    setRecording(false);

    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    chunksRef.current = [];
    if (blob.size === 0) {
      setNotice('That recording came back empty. Type the answer instead.');
      return;
    }

    if (!session?.sttReady) {
      setNotice('Speech-to-text is off here, so nothing was transcribed. Type the answer instead.');
      return;
    }

    setBusy('Transcribing your answer.');
    try {
      const form = new FormData();
      form.append('audio', blob, 'answer.webm');
      form.append('sessionId', session.sessionId);
      const response = await fetch(`/api/interview/${encodeURIComponent(jobId)}/transcribe`, {
        method: 'POST',
        body: form,
      });
      const payload = (await response.json()) as {
        ok: boolean;
        text?: string;
        seconds?: number | null;
        reason?: string;
        error?: string;
      };
      if (!payload.ok) {
        setNotice(payload.reason ?? payload.error ?? 'That recording could not be transcribed.');
        return;
      }
      if (!payload.text) {
        setNotice('We heard nothing in that recording. Try again, or type the answer.');
        return;
      }
      setDraft(payload.text);
      // Scribe's own word timings when it gave us them, and the button-press
      // stopwatch only as a fallback. The stopwatch includes reading the question
      // and reaching for the stop button, so pacing computed from it would tell a
      // careful speaker they were slow.
      spokenSecondsRef.current =
        typeof payload.seconds === 'number' && payload.seconds > 0 ? payload.seconds : seconds;
      setNotice('Transcribed. Read it, fix anything it misheard, then send it.');
      answerBoxRef.current?.focus();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(null);
    }
  }, [jobId, session]);


  /* ------------------------------------------------------------- the answers */

  const question: InterviewQuestion | null = session?.questions[index] ?? null;

  const send = useCallback(
    async (skip: boolean) => {
      if (!session || !question) return;
      const text = skip ? '' : draft.trim();
      if (!skip && !text) {
        setNotice('Nothing in the answer box yet.');
        return;
      }

      setBusy(skip ? 'Skipping.' : 'Sending your answer.');
      const spokenSeconds = skip ? null : spokenSecondsRef.current;
      const answer: InterviewAnswer = {
        questionId: question.id,
        text,
        source: spokenSeconds !== null ? 'scribe' : 'typed',
        spokenSeconds,
      };

      try {
        const response = await fetch(`/api/interview/${encodeURIComponent(jobId)}/turn`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.sessionId,
            questionId: question.id,
            text,
            source: answer.source,
            spokenSeconds: spokenSeconds ?? undefined,
            // Sent so an answer survives a server restart mid-interview. See the
            // questionStore comment in src/lib/interview.ts.
            question,
          }),
        });
        const payload = (await response.json()) as { ok?: boolean; critique?: AnswerCritique; error?: string };
        if (!response.ok || !payload.critique) {
          setNotice(payload.error ?? `That answer did not send (${response.status}).`);
          return;
        }

        setAnswers((previous) => [...previous, answer]);
        setCritiques((previous) => [...previous, payload.critique as AnswerCritique]);
        setDraft('');
        spokenSecondsRef.current = null;
        setNotice(null);
        setIndex((previous) => previous + 1);
      } catch (error) {
        setNotice((error as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [draft, jobId, question, session],
  );

  const finish = useCallback(async () => {
    if (!session) return;
    setBusy('Writing your readout.');
    try {
      const response = await fetch(`/api/interview/${encodeURIComponent(jobId)}/finish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, answers, vitals: vitalsSummary }),
      });
      const payload = (await response.json()) as { ok?: boolean; feedback?: InterviewFeedback; error?: string };
      if (!response.ok || !payload.feedback) {
        setNotice(payload.error ?? `The readout could not be written (${response.status}).`);
        return;
      }
      setFeedback(payload.feedback);
      setPhase('done');
      stopCamera();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(null);
    }
  }, [answers, jobId, session, stopCamera, vitalsSummary]);

  // The last answer lands and the room finishes itself: a student who answered
  // everything should not have to find a button to be told how it went.
  useEffect(() => {
    if (phase === 'live' && session && index >= session.questions.length && session.questions.length > 0) {
      void finish();
    }
  }, [finish, index, phase, session]);

  /* -------------------------------------------------------------- rendering */

  if (loadError) {
    return (
      <section className="iv-panel">
        <h2>The interview room could not open</h2>
        <p className="iv-muted">{loadError}</p>
      </section>
    );
  }

  if (!session) {
    return (
      <section className="iv-panel" aria-busy="true">
        <p className="iv-muted">Preparing the room. This reads the posting and your match gaps.</p>
      </section>
    );
  }

  if (session.locked) {
    return (
      <section className="iv-panel">
        <h2>Not yet</h2>
        <p>{session.locked}</p>
        <p className="iv-muted">
          A mock interview opens when a role reaches <strong>Interviewing</strong> on your pipeline board, which is
          also what an employer reply sets automatically.
        </p>
        <a className="iv-button" href="/applicant/pipeline">
          Go to the pipeline board
        </a>
      </section>
    );
  }

  return (
    <div className="iv-room">
      {/* Status line, always in the DOM so it is announced when it fills. */}
      <p className="iv-live" role="status" aria-live="polite">
        {busy ?? notice ?? ''}
      </p>

      <div className="iv-stage">
        <section className="iv-camera" aria-labelledby="iv-camera-heading">
          <h2 id="iv-camera-heading" className="iv-h3">
            You
          </h2>
          {/* A live self-view has no track to caption. jsx-a11y does not flag it
              because the element has no <source>; the accessible equivalent of a
              caption here is the transcript in the answer box. */}
          <video ref={videoRef} className="iv-video" muted playsInline aria-label="Your camera preview" />
          {!cameraOn ? (
            <>
              <button type="button" className="iv-button" onClick={() => void startCamera()}>
                Turn on camera and microphone
              </button>
              <p className="iv-muted">
                Optional. Nothing is recorded as video and nothing is uploaded as video. The interview works typed.
              </p>
            </>
          ) : (
            <button type="button" className="iv-button iv-button-quiet" onClick={stopCamera}>
              Turn the camera off
            </button>
          )}
          {cameraError ? <p className="iv-warn">{cameraError}</p> : null}

          <VitalsPanel
            ready={session.vitalsReady}
            off={vitalsOff}
            sample={vitals}
            summary={vitalsSummary}
            cameraOn={cameraOn}
          />
        </section>

        <section className="iv-main" aria-labelledby="iv-main-heading">
          <h2 id="iv-main-heading" className="iv-h3">
            {phase === 'done' ? 'How it went' : `Interview · ${jobTitle} · ${company}`}
          </h2>

          {phase === 'brief' ? (
            <Brief session={session} onStart={() => setPhase('live')} />
          ) : null}

          {phase === 'live' && question ? (
            <>
              <p className="iv-progress">
                Question {index + 1} of {session.questions.length} · {QUESTION_KIND_LABEL[question.kind]}
              </p>
              <div className="iv-question" role="region" aria-live="polite" aria-atomic="true">
                <p className="iv-question-text">{question.text}</p>
                <p className="iv-muted">{question.because}</p>
                {question.looksLike.length ? (
                  <details className="iv-hint">
                    <summary>What a strong answer has</summary>
                    <ul>
                      {question.looksLike.map((point) => (
                        <li key={point}>{point}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>

              <label className="iv-label" htmlFor="iv-answer">
                Your answer
              </label>
              <textarea
                id="iv-answer"
                ref={answerBoxRef}
                className="iv-answer"
                rows={8}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Type it, or record it and edit what comes back."
              />

              <div className="iv-actions">
                <button type="button" className="iv-button" disabled={busy !== null} onClick={() => void send(false)}>
                  Send answer
                </button>
                {recording ? (
                  <button type="button" className="iv-button iv-button-quiet" onClick={() => void stopRecording()}>
                    Stop recording
                  </button>
                ) : (
                  <button
                    type="button"
                    className="iv-button iv-button-quiet"
                    disabled={busy !== null || !cameraOn}
                    onClick={startRecording}
                  >
                    Record answer
                  </button>
                )}
                <button
                  type="button"
                  className="iv-button iv-button-quiet"
                  disabled={busy !== null}
                  onClick={() => void send(true)}
                >
                  Skip this one
                </button>
              </div>
              {!cameraOn ? (
                <p className="iv-muted">Recording needs the microphone, which comes with the camera button above.</p>
              ) : null}

              {critiques.length ? <CritiqueList critiques={critiques} questions={session.questions} /> : null}
            </>
          ) : null}

          {phase === 'done' && feedback ? <Readout feedback={feedback} questions={session.questions} /> : null}
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Brief({ session, onStart }: { session: InterviewSessionPayload; onStart: () => void }) {
  return (
    <>
      <p>
        {session.questions.length} questions, one at a time. Answer them out loud if you can — speaking an answer is
        the part nobody rehearses. You can skip any of them, and skipping is itself in the readout.
      </p>
      <p className="iv-muted">{QUESTION_SOURCE_LABEL[session.questionSource]}.</p>

      {session.degraded.length ? (
        <details className="iv-hint">
          <summary>What is switched off in this deployment ({session.degraded.length})</summary>
          <ul>
            {session.degraded.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <button type="button" className="iv-button" onClick={onStart}>
        Start the interview
      </button>
    </>
  );
}

function CritiqueList({ critiques, questions }: { critiques: AnswerCritique[]; questions: InterviewQuestion[] }) {
  const titleFor = (id: string) => questions.find((question) => question.id === id)?.text ?? 'That question';
  return (
    <section className="iv-critiques" aria-labelledby="iv-critiques-heading">
      <h3 id="iv-critiques-heading" className="iv-h3">
        So far
      </h3>
      <ol>
        {critiques.map((critique) => (
          <li key={critique.questionId}>
            <p className="iv-critique-q">{titleFor(critique.questionId)}</p>
            <ul>
              {critique.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
              {critique.missing.map((point) => (
                <li key={point}>Missing: {point}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Readout({ feedback, questions }: { feedback: InterviewFeedback; questions: InterviewQuestion[] }) {
  return (
    <>
      <p className="iv-summary">{feedback.summary}</p>
      <CritiqueList critiques={feedback.critiques} questions={questions} />
      {feedback.unanswered.length ? (
        <section aria-labelledby="iv-skipped-heading">
          <h3 id="iv-skipped-heading" className="iv-h3">
            Skipped
          </h3>
          <ul>
            {feedback.unanswered.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="iv-muted">
        This readout is in your transcript, logged against this application. Run the room again whenever you like —
        the questions are rebuilt from the posting each time.
      </p>
    </>
  );
}

/**
 * The steadiness panel.
 *
 * Says what the number is AND what it is not, on screen, every time. Presage's own
 * documentation calls these wellness metrics that are not FDA cleared, so a bare
 * "72 bpm" next to an interview question would imply a clinical claim the product
 * does not get to make. It is also never a score and never leaves this page except
 * as a session aggregate on a telemetry row.
 */
function VitalsPanel({
  ready,
  off,
  sample,
  summary,
  cameraOn,
}: {
  ready: boolean;
  off: string | null;
  sample: VitalsSample | null;
  summary: VitalsSummary;
  cameraOn: boolean;
}) {
  if (!ready) {
    return (
      <section className="iv-vitals" aria-labelledby="iv-vitals-heading">
        <h3 id="iv-vitals-heading" className="iv-h3">
          Steadiness
        </h3>
        <p className="iv-muted">Not switched on in this deployment.</p>
      </section>
    );
  }

  const confident = sample !== null && sample.confidence >= CONFIDENCE_FLOOR;

  return (
    <section className="iv-vitals" aria-labelledby="iv-vitals-heading">
      <h3 id="iv-vitals-heading" className="iv-h3">
        Steadiness
      </h3>
      {off ? (
        <p className="iv-warn">{off}</p>
      ) : !cameraOn ? (
        <p className="iv-muted">Turn the camera on and this reads your pulse and breathing from the video.</p>
      ) : (
        <>
          {/* aria-live off: a number that changes every second is unusable read aloud. */}
          <dl className="iv-vitals-grid" aria-live="off">
            <div>
              <dt>Pulse</dt>
              <dd>{confident && sample?.pulseBpm !== null ? `${Math.round(sample!.pulseBpm!)} bpm` : 'reading…'}</dd>
            </div>
            <div>
              <dt>Breathing</dt>
              <dd>
                {confident && sample?.breathingBpm !== null
                  ? `${Math.round(sample!.breathingBpm!)} / min`
                  : 'reading…'}
              </dd>
            </div>
            <div>
              <dt>Face</dt>
              <dd>{sample?.expression ? sample.expression.label : 'not read'}</dd>
            </div>
          </dl>
          <p className="iv-muted">
            {summary.usable} of {summary.samples} readings were confident enough to count.
          </p>
        </>
      )}
      <p className="iv-muted">
        Wellness signals from the camera, for you, in a practice session. Not a medical measurement, not a score, and
        never shown to an employer.
      </p>
    </section>
  );
}

'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

import type { FaceMood } from './AgentFace';

/**
 * HireWire's face, with real form.
 *
 * SAME CHARACTER, NOT A NEW ONE. Every coordinate below is lifted from the SVG in
 * AgentFace.tsx and projected onto the sphere, so the 3D head is the 2D drawing
 * wrapped around a ball rather than a second mascot that happens to look similar.
 * The six moods are the same six, with the same poses.
 *
 * WHY IT IS NOT GLOSSY. The design system is two base colours, no shadows and no
 * white (globals.css). A chrome sphere would read as a different product sitting
 * next to the wordmark, so the head is matte paper with an ink rim — the line-art
 * silhouette kept, with light on it.
 *
 * PERFORMANCE. Nothing here sets React state per frame: every animation writes
 * straight to a ref's transform inside useFrame. Geometries and materials are
 * built once in useMemo and shared, and the whole face is 8 meshes — well inside a
 * sensible draw-call budget. The parent loads this with next/dynamic({ssr:false})
 * so three.js never enters the server bundle.
 *
 * NO <Environment />. drei's presets fetch an HDRI from a CDN at runtime; three
 * plain lights cost nothing, need no network, and cannot fail on a conference
 * wifi during a demo.
 */

const INK = '#0b2545';
const PAPER = '#eef4ed';
const SUCCESS = '#3b6064';
const FAILURE = '#8c2f39';

/** Head radius and centre in the SVG's own 160x160 space — see AgentFace.tsx. */
const SVG_R = 58;
const SVG_C = 80;

/** Project a point from the flat drawing onto the head, a hair proud of the
 *  surface so a stroke reads as sitting on the ball and not sunk into it. */
function onSphere(x: number, y: number, lift = 1.015): THREE.Vector3 {
  const nx = (x - SVG_C) / SVG_R;
  const ny = (SVG_C - y) / SVG_R;
  const z = Math.sqrt(Math.max(lift * lift - nx * nx - ny * ny, 0.01));
  return new THREE.Vector3(nx, ny, z);
}

/** A stroke from the drawing, as a tube that hugs the head. */
function strokeGeometry(
  from: [number, number],
  control: [number, number],
  to: [number, number],
  radius = 0.038,
): THREE.TubeGeometry {
  const flat = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(from[0], from[1], 0),
    new THREE.Vector3(control[0], control[1], 0),
    new THREE.Vector3(to[0], to[1], 0),
  );
  const points = flat.getPoints(24).map((p) => onSphere(p.x, p.y));
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 32, radius, 8, false);
}

/** The same table as the 2D face, so the two cannot drift apart. `curve` is the
 *  mouth's bend in SVG units; the rest are read as radians/scale here. */
const POSE: Record<
  FaceMood,
  { eyeLift: number; eyeScale: number; browLift: number; browTilt: number; curve: number; lean: number }
> = {
  idle: { eyeLift: 0, eyeScale: 1, browLift: 0, browTilt: 0, curve: 4, lean: 0 },
  listening: { eyeLift: 0.03, eyeScale: 1.22, browLift: 0.08, browTilt: -0.05, curve: 6, lean: 0.05 },
  thinking: { eyeLift: 0.08, eyeScale: 0.9, browLift: 0.03, browTilt: 0.19, curve: -1, lean: -0.07 },
  speaking: { eyeLift: 0, eyeScale: 1.05, browLift: 0.03, browTilt: 0, curve: 10, lean: 0 },
  happy: { eyeLift: -0.02, eyeScale: 0.72, browLift: 0.06, browTilt: -0.1, curve: 15, lean: 0 },
  refusing: { eyeLift: -0.02, eyeScale: 0.6, browLift: -0.05, browTilt: -0.26, curve: -7, lean: 0 },
};

const MOODS = Object.keys(POSE) as FaceMood[];

function moodColor(mood: FaceMood): string {
  if (mood === 'refusing') return FAILURE;
  if (mood === 'happy' || mood === 'speaking') return SUCCESS;
  return INK;
}

function Head({ mood, reduced }: { mood: FaceMood; reduced: boolean }) {
  const root = useRef<THREE.Group>(null);
  const browL = useRef<THREE.Mesh>(null);
  const browR = useRef<THREE.Mesh>(null);
  const browPivot = useRef<THREE.Group>(null);
  const eyePivot = useRef<THREE.Group>(null);
  const eyeL = useRef<THREE.Mesh>(null);
  const eyeR = useRef<THREE.Mesh>(null);
  const blink = useRef(1);
  const nextBlink = useRef(2.4);

  // Built once and shared. A mouth per mood rather than a scaled one: scaling a
  // tube that hugs a sphere lifts it straight off the surface.
  const mouths = useMemo(() => {
    const out = {} as Record<FaceMood, THREE.TubeGeometry>;
    for (const m of MOODS) {
      out[m] = strokeGeometry([62, 98], [80, 98 + POSE[m].curve], [98, 98]);
    }
    return out;
  }, []);

  const brows = useMemo(
    () => ({
      left: strokeGeometry([50, 58], [58, 53], [66, 57]),
      right: strokeGeometry([94, 57], [102, 53], [110, 58]),
    }),
    [],
  );

  const eyeGeometry = useMemo(() => new THREE.SphereGeometry(5.5 / SVG_R, 24, 24), []);
  const eyeAt = useMemo(() => ({ left: onSphere(58, 76, 1.0), right: onSphere(102, 76, 1.0) }), []);

  const inkMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: new THREE.Color(INK), roughness: 0.45, metalness: 0 }),
    [],
  );
  const paperMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: new THREE.Color(PAPER), roughness: 0.92, metalness: 0 }),
    [],
  );
  const rimMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({ color: new THREE.Color(INK), side: THREE.BackSide }),
    [],
  );

  const target = useMemo(() => new THREE.Color(INK), []);

  useFrame((state, delta) => {
    const p = POSE[mood];
    // Frame-rate independent easing, so the face settles at the same speed on a
    // 120Hz laptop and a throttled tab.
    const k = 1 - Math.exp(-6 * delta);

    target.set(moodColor(mood));
    inkMaterial.color.lerp(target, k);
    rimMaterial.color.lerp(target, k);

    if (browPivot.current) browPivot.current.rotation.x = THREE.MathUtils.lerp(browPivot.current.rotation.x, -p.browLift, k);
    if (eyePivot.current) eyePivot.current.rotation.x = THREE.MathUtils.lerp(eyePivot.current.rotation.x, -p.eyeLift, k);
    if (browL.current) browL.current.rotation.z = THREE.MathUtils.lerp(browL.current.rotation.z, p.browTilt, k);
    if (browR.current) browR.current.rotation.z = THREE.MathUtils.lerp(browR.current.rotation.z, -p.browTilt, k);

    // Blink: irregular, and never mid-refusal — the stare is the point.
    if (!reduced) {
      nextBlink.current -= delta;
      if (nextBlink.current <= 0 && mood !== 'refusing') {
        blink.current = 0;
        nextBlink.current = 2.6 + Math.random() * 2.4;
      }
      blink.current = Math.min(1, blink.current + delta * 9);
    }
    const lid = reduced ? 1 : 0.08 + 0.92 * Math.sin(Math.min(blink.current, 1) * Math.PI * 0.5);
    for (const eye of [eyeL.current, eyeR.current]) {
      if (!eye) continue;
      eye.scale.x = THREE.MathUtils.lerp(eye.scale.x, p.eyeScale, k);
      eye.scale.z = eye.scale.x;
      eye.scale.y = eye.scale.x * lid;
    }

    const g = root.current;
    if (!g) return;
    g.rotation.z = THREE.MathUtils.lerp(g.rotation.z, p.lean, k);

    if (reduced) {
      g.position.y = 0;
      g.rotation.x = 0;
      g.rotation.y = 0;
      return;
    }
    const t = state.clock.elapsedTime;
    g.position.y = Math.sin(t * 0.9) * 0.055;
    // Looks toward the cursor, a little. pointer is already -1..1.
    g.rotation.y = THREE.MathUtils.lerp(g.rotation.y, state.pointer.x * 0.35, k);
    g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, -state.pointer.y * 0.22 + Math.sin(t * 0.7) * 0.02, k);
  });

  return (
    <group ref={root}>
      {/* Inverted hull: the silhouette line of the 2D mark, kept. */}
      <mesh scale={1.035} material={rimMaterial}>
        <sphereGeometry args={[1, 64, 64]} />
      </mesh>
      <mesh material={paperMaterial}>
        <sphereGeometry args={[1, 64, 64]} />
      </mesh>

      <group ref={browPivot}>
        <mesh ref={browL} geometry={brows.left} material={inkMaterial} />
        <mesh ref={browR} geometry={brows.right} material={inkMaterial} />
      </group>

      <group ref={eyePivot}>
        <mesh ref={eyeL} geometry={eyeGeometry} material={inkMaterial} position={eyeAt.left} />
        <mesh ref={eyeR} geometry={eyeGeometry} material={inkMaterial} position={eyeAt.right} />
      </group>

      <mesh geometry={mouths[mood]} material={inkMaterial} />
    </group>
  );
}

export default function AgentFace3D({ mood = 'idle', size = 260 }: { mood?: FaceMood; size?: number }) {
  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return (
    // aria-hidden for the same reason the 2D face is: the caption beside it is a
    // live region that already says what the agent is doing, and a face announced
    // twice is noise.
    <div style={{ width: size, height: size }} aria-hidden="true">
      <Canvas
        // `flat` = NoToneMapping. R3F defaults to ACES filmic, which pulls the
        // paper token toward grey and the ink toward black — the whole point of
        // a two-colour system is that #eef4ed comes out as #eef4ed.
        flat
        dpr={[1, 2]}
        camera={{ position: [0, 0, 3.6], fov: 42 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={2.4} />
        <directionalLight position={[2.5, 3.5, 4]} intensity={1.2} />
        <directionalLight position={[-3, -1, 2]} intensity={0.45} />
        <Head mood={mood} reduced={reduced} />
      </Canvas>
    </div>
  );
}

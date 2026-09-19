# Frontend Tracker — HireWire

**Owner:** Nidhi · **Deadline:** Sun 08:00 ET · **Code freeze:** Sun 05:00 ET
**Companion to** [`FRONTEND_UIUX_PLAN.txt`](./FRONTEND_UIUX_PLAN.txt) — that's the *why*, this is the *what next*.

> Copy the **Prompt** cell straight into chat. Tick the box when the thing is visibly working in the browser, not when the code compiles.

**Impact key:** 🔴 pitch breaks without it · 🟠 big visible win · 🟡 nice beat · ⚪ polish

---

## Done already
- [x] `lenis` + `motion` installed in the app
- [x] `eslint-plugin-jsx-a11y` installed
- [ ] delete stray root `package.json` (still there — 1 min)

---

## Phase F — Foundation (do in order, nothing else works without it)

| ✓ | ID | Task | Prompt to paste | What changes on screen | Time | Impact |
|---|----|------|-----------------|------------------------|------|--------|
| [ ] | F1 | Design tokens | `Set up our design tokens in globals.css — dark near-black bg, warm off-white text, one teal accent for verified, red for refused, 8px spacing scale, one radius, visible focus ring. Type scale 14/16/20/32/56.` | Whole site goes dark and consistent. Nothing new appears, but everything after this is automatically on-brand. | 25m | 🔴 |
| [ ] | F2 | Lenis, gated | `Add a Lenis smooth-scroll provider to the app, disabled under prefers-reduced-motion, lerp ~0.1, and make sure keyboard focus scrolling still works.` | Scrolling gets a subtle weight to it. Should be felt, not noticed. | 20m | 🟠 |
| [ ] | F3 | shadcn/ui | `Init shadcn/ui in the app wired to our tokens and add button, card, badge, dialog, skeleton.` | Buttons/cards stop looking like raw HTML. Keyboard + ARIA correct for free. | 20m | 🟠 |
| [ ] | F4 | App shell | `Build the app shell: header, skip-to-content link, focus-visible styles everywhere, correct landmark roles, and a keyboard-reachable layout.` | Page gets structure. Tab key now moves sensibly. | 25m | 🔴 |

**Phase F: 1h 30m**

---

## Phase S — The Voice Orb (our signature object)

| ✓ | ID | Task | Prompt to paste | What changes on screen | Time | Impact |
|---|----|------|-----------------|------------------------|------|--------|
| [ ] | S1 | Orb, 5 states | `Build the voice orb component with five visual states — idle breathing, listening, thinking, speaking, refusing (hard stop, desaturate, red ring, shake). Fake the amplitude for now with a prop.` | A living object appears centre-screen. This is the thing judges remember. | 45m | 🔴 |
| [ ] | S2 | Real mic input | `Wire the orb's listening state to real mic amplitude via a Web Audio AnalyserNode.` | Orb now deforms to *your actual voice*. The moment it stops looking like a demo. | 30m | 🔴 |
| [ ] | S3 | Real TTS output | `Wire the orb's speaking state to the ElevenLabs output stream amplitude.` | Orb moves in time with the agent talking. Audio-visual sync thesis becomes literally true. | 20m | 🟠 |
| [ ] | S4 | Announce states | `Add aria-live announcements for every orb state change so the state is audible, not just visual.` | Nothing visible. Blind users can now perceive the orb. **This is the accessibility claim.** | 15m | 🔴 |

**Phase S: 1h 50m · running total 3h 20m**

---

## Phase H — Hero components + homepage

| ✓ | ID | Task | Prompt to paste | What changes on screen | Time | Impact |
|---|----|------|-----------------|------------------------|------|--------|
| [ ] | H1 | Trust Card | `Build the Trust Card — five dimensions (Integrity, Identity, Solvency, Behavior, Safety), each with a score that counts up and a reason string underneath, staggered reveal. Read from the verify API shape.` | The component GoDaddy judges came to see. Looks like a nutrition label for trust. | 40m | 🔴 |
| [ ] | H2 | Refusal stamp | `Add the refusal animation — Trust Card flips red, a REFUSED seal stamps down, orb halts, and the reason is announced aloud.` | The single biggest moment in the pitch. | 25m | 🔴 |
| [ ] | H3 | Homepage screen 1 | `Build homepage screen one: centred voice orb, one line of copy, a "Talk to it" button that actually starts listening, and a "or press / to type" hint.` | The front door. First thing judges see. | 30m | 🔴 |
| [ ] | H4 | 3 scroll beats | `Add the three scroll beats under the hero — finds jobs against skills+coursework, checks the employer is real, refuses when they're not. Use Lenis + Motion scroll reveals.` | Homepage tells the story in one scroll. Where Lenis earns its place. | 35m | 🟡 |

**Phase H: 2h 10m · running total 5h 30m**

### ✂️ CUT LINE — everything above is P0. If you only finish this, you still have a winning demo.

---

## Phase P — Product motion (P1, in this order)

| ✓ | ID | Task | Prompt to paste | What changes on screen | Time | Impact |
|---|----|------|-----------------|------------------------|------|--------|
| [ ] | P1 | Match cards | `Animate the job match results — cards stagger in, each fit score draws as a ring.` | Results list stops being a table, starts being a reveal. | 25m | 🟠 |
| [ ] | P2 | Dispatch | `Add the application dispatch animation — card travels along an SVG path from applicant to employer, checkmark draws on arrival. Fires on a real submit.` | You can *see* an application being sent and verified. | 30m | 🟡 |
| [ ] | P3 | Attack counter | `Add the attacks-blocked counter with a shield pulse each time fraud.webmesh.ai is repelled.` | Live proof during the ANS demo. Number climbing = drama. | 20m | 🟡 |
| [ ] | P4 | Skill-gap bars | `Animate the skill-gap bars to draw on scroll into view.` | Databricks insight chart feels intentional. | 15m | ⚪ |
| [ ] | P5 | Page transitions | `Add Motion AnimatePresence page transitions between routes.` | Navigation stops feeling like page loads. | 20m | ⚪ |

**Phase P: 1h 50m · running total 7h 20m**

---

## Phase X — Before freeze (do NOT skip)

| ✓ | ID | Task | Prompt to paste | What changes on screen | Time | Impact |
|---|----|------|-----------------|------------------------|------|--------|
| [ ] | X1 | Reduced motion | `Verify prefers-reduced-motion flattens every animation — toggle it in devtools and fix anything that still moves.` | Nothing, unless it's broken. Failing this on an accessibility app is the one thing judges will punish. | 10m | 🔴 |
| [ ] | X2 | a11y evidence | `Run axe and Lighthouse on the app, fix violations, and help me screenshot the accessibility score for a slide.` | A number on a slide. Turns "accessible" from a claim into proof. | 20m | 🟠 |
| [ ] | X3 | Mouse-free run | `Walk the full demo with me using only keyboard and voice — flag anything unreachable.` | Nothing. But this is the demo move that wins the UI/UX prize. | 20m | 🔴 |

**Phase X: 50m · TOTAL P0-only 6h 20m · everything 8h 10m**

---

## Lag check

You also own **voice + the agent loop**, so frontend is not your only job. Use these:

| Checkpoint | You should have finished | If you haven't |
|---|---|---|
| after 1.5h | Phase F | Skip F3 (shadcn), hand-roll the 3 components you need |
| after 3.5h | Phase F + S | Ship the orb with faked amplitude (skip S2/S3), keep S4 |
| after 5.5h | + H1, H2, H3 | Cut H4. Non-negotiable: orb, Trust Card, refusal |
| freeze − 1h | Phase X done | Nothing else matters. Stop and do X1/X3. |

**Descope order when behind:** P5 → P4 → P3 → P2 → P1 → H4.
**Never cut:** S1, S4, H1, H2, X1, X3.

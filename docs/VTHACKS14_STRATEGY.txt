================================================================================
VTHACKS 14 — BUILD PLAN  (v2, rewritten after GoDaddy + Deloitte briefs)
SHIP: Sunday Sept 20, 8:00 AM ET  |  Judging 10:30 AM, New Classroom Bldg
Project: HIREWIRE — voice-first career agent with verified agent-to-agent apply
================================================================================

FEASIBILITY VERDICT: YES in ~23 hours with 4 people — but only if you cut
Playwright and Solana (section 5). Budget math is in section 6.


--------------------------------------------------------------------------------
1. THREE THINGS THAT CHANGED THE PLAN
--------------------------------------------------------------------------------

[1] DELOITTE/DATABRICKS NAMED OUR PROJECT AS A FOCUS AREA.
    Their brief lists three options. Option 1 is "Campus career navigator":
      "Build an AI agent that helps students discover internships, research
       positions, and full-time roles by analyzing their skills, COURSEWORK,
       and interests against real-world opportunities using Databricks."
    That is our project, verbatim. Pick this focus area explicitly and say so.
    Note "coursework" — ingest VT course/transcript data or you leave points on
    the table. Their rubric also rewards two things nobody builds at a hackathon:
      - "implementation of technology consulting / strategy"
      - "thoroughness of DEPLOYMENT ROADMAP and future enhancements"
    That is two slides. Make them. Highest points-per-minute on the whole board.
    Prize: JBL Speaker + Deloitte x Databricks merch (Best overall solution).

[2] GODADDY'S TRACK IS "BEST USE OF ANS" AND IT FITS US ALMOST PERFECTLY.
    ANS = Agent Name Service: domain-anchored, certificate-backed identity for
    agents, so an agent can PROVE who it is talking to. GoDaddy's own line:
      "The strongest entries make identity the core mechanic."
    Why it fits: a job-application agent is an agent talking to STRANGERS' agents.
    Fake recruiters and job scams are a real, documented harm, and they target
    exactly our users — first-gen, international, and disabled job seekers, who
    are the ones most likely to hand over an SSN to a convincing fake.
      "Is this employer real?"  ==  "Who is that agent, and can it prove it?"
    So: our agent verifies the employer's agent BEFORE releasing the resume/PII,
    and refuses out loud when verification fails. Identity is load-bearing, not
    decoration. Prizes: 1st Meta Ray-Ban Gen 2 / 2nd Beats Studio Pro / 3rd
    Cocopar monitor — PER TEAM MEMBER. This is the richest track we can realistically win.

[3] THEREFORE: DROP PLAYWRIGHT. THE APPLICATION IS SUBMITTED AGENT-TO-AGENT.
    Killing ATS form automation buys back ~4-5 hours and removes the most
    demo-fragile component we had. It also kills the "isn't this spam?" objection
    outright, and it makes ANS the submission channel instead of a bolt-on.
    Story upgrade: we are not automating a broken form, we are showing what job
    applications look like when both sides are verified.
    (Optional, only if far ahead: one Playwright Greenhouse fill as "works with
    today's web too." Nice-to-have, not a deliverable.)


--------------------------------------------------------------------------------
2. THE LOCKED CONCEPT
--------------------------------------------------------------------------------

HIREWIRE — a voice-first career agent for students who cannot fight a Workday
form: blind/low-vision, motor-impaired/RSI, and first-gen students. It finds
roles against your skills AND coursework, tailors your materials, verifies the
employer is who they claim to be, applies agent-to-agent, and coaches your
interview — all by voice.

TWO AGENTS, BOTH ANS-REGISTERED, TALKING TO EACH OTHER:
  ans://v1.0.0.applicant.<ourdomain>   acts for the student, holds resume + PII
  ans://v1.0.0.employer.<ourdomain>    acts for a company, posts roles, receives

THE HANDSHAKE (this is the demo's spine):
  1. Applicant agent discovers the employer agent by ANS name
  2. Resolves version + endpoint, checks identity certificate + Trust Index
     (Integrity / Identity / Solvency / Behavior / Safety — with reasons)
  3. Employer agent states what fields it requires
  4. Policy check: does the student's policy allow releasing these fields to an
     entity with this trust profile?
  5. ONLY THEN does any PII move. Otherwise: refuse, and say why out loud.

BIDIRECTIONAL — use this, it is the best answer to the spam question:
  The employer agent ALSO verifies the applicant agent. Recruiters are drowning
  in AI-generated fake applicants; our applicant agent carries a verifiable,
  domain-anchored identity. We solve spam FOR employers, not create it.

ONE-LINE PITCH:
  "Applying to 40 jobs takes a sighted student 12 hours of clicking. For a blind
   student on a screen reader it's effectively impossible. And a third of the
   postings she'd reach are scams fishing for her SSN. HireWire does the whole
   funnel by voice — and refuses to talk to an employer that can't prove it's real."

CATEGORIES TO SELECT ON DEVPOST (all of them — it costs 10 minutes):
  1st Place · Best DEI Hack · Best Accessibility · Best Ut Prosim · Best UI/UX ·
  Best First-Time Hack (if eligible) · Deloitte/Databricks · GoDaddy ANS ·
  GoDaddy Registry Domain · ElevenLabs · Gemini · Tiger Data · MongoDB · Vultr


--------------------------------------------------------------------------------
3. ARCHITECTURE
--------------------------------------------------------------------------------

  VOICE (ElevenLabs Agents, STT + TTS, 2 personas: assistant / interviewer)
        |
  ORCHESTRATOR  FastAPI + Gemini function-calling as the tool router
        |
        +-- parse_resume(pdf)        Gemini multimodal (PDF in directly)
        +-- parse_transcript(pdf)    Gemini -> courses -> skills  [Deloitte: "coursework"]
        +-- match_jobs(profile)      Databricks vector search over JD embeddings
        +-- verify_employer(ans_name) ANS resolve + cert + Trust Index  [GoDaddy]
        +-- tailor(job)              Gemini structured output
        +-- apply(job)               A2A POST to employer agent, PII gated on verify
        +-- interview(job)           ElevenLabs conversational agent
        +-- log(event)               TigerData hypertable + MongoDB audit doc
        |
  DATA
    Databricks  workspace.hirewire: jobs, profiles, embeddings, skill-gap SQL,
                course->role mapping, AI/BI dashboard
    TigerData   application_events hypertable + continuous aggregates (funnel,
                response-time decay, trust-verification events over time)
    MongoDB     raw JD documents + immutable A2A audit log (every message, every
                verification verdict, what PII was released and to whom)
        |
  FRONTEND  Next.js, keyboard-only navigable, ARIA, high contrast, focus rings
  HOSTING   Vultr — REQUIRED, not bolt-on: ANS needs a public HTTPS endpoint
  DOMAIN    GoDaddy Registry (free, MLH code MLH0918VTH) — the identity anchor


--------------------------------------------------------------------------------
4. TRACK-BY-TRACK: WHAT TO ACTUALLY BUILD
--------------------------------------------------------------------------------

GODADDY — BEST USE OF ANS                                    [~4h, start FIRST]
  Setup (six commands, from their workshop deck):
    brew install agentnameservice/ans/ans-cli
    export ANS_BASE_URL="https://api.godaddy.com"
    ans-cli generate-csr --host applicant.<domain> --version 1.0.0 --out-dir ./certs
    ans-cli register --host applicant.<domain> --version 1.0.0 \
      --identity-csr ./certs/identity.csr --server-csr ./certs/server.csr \
      --endpoint-url https://applicant.<domain>/mcp
    # place the DNS TXT record from the response
    ans-cli verify-acme <agentId> ; ans-cli status <agentId>
    ans-cli get-identity-certs <agentId>
  API key: GoDaddy table (Sat 1:00-3:30 PM) or #godaddy on Discord.
  Do it twice — applicant agent and employer agent.
  *** DNS TXT PROPAGATION IS THE ONE THING YOU CANNOT SPEED UP. START AT HOUR 1. ***

  What wins the track (they said it explicitly):
   - "Show the success path AND the refusal path."
     Demo both. The refusal is the better TV.
   - "Show the evidence, not just the demo."
     Put a Trust Card in the UI: 5 dimensions, each with its REASON, read aloud.
   - "Name your threat model and the tradeoff you chose."
     One slide. Threat: impostor employer harvesting student PII. Tradeoff: we
     refuse on unverified rather than warn-and-continue, accepting false negatives.
   - fraud.webmesh.ai is LIVE and running 13 attacks (forged signatures, replayed
     requests, swapped quotes). Point our agent at it and show attacks BLOCKED,
     live, with a counter. Card: https://fraud.webmesh.ai/.well-known/agent-card.json
   - They will try to break our endpoint at the table. Bring it Saturday afternoon.

DELOITTE / DATABRICKS — "CAMPUS CAREER NAVIGATOR"                        [~6h]
   - workspace.hirewire schema; jobs table w/ embedding column
   - Embeddings + fit scoring in SQL. VERIFIED WORKING on our Free Edition:
       ai_query('databricks-gte-large-en', text)      -> 1024-dim
       ai_query('databricks-llama-4-maverick', prompt) -> text
     No external key, no rate limits. Use it for JD parsing and skill extraction.
   - Vector Search index on endpoint vthacks-vs (already ONLINE).
     Keep a plain SQL cosine fallback — over 500 rows it is instant and
     indistinguishable in a 4-minute demo.
   - THE TWO QUERIES THAT SELL THIS TRACK:
       a) Skill gap: skills demanded by roles that rejected you, absent from
          your resume.
       b) COURSEWORK LEVER: "take CS 3214 next semester -> unlocks 40% more
          postings." Directly hits the words in their brief.
   - AI/BI dashboard on the lakehouse. Judges click it.
   - Two slides they explicitly score and nobody else will make:
       "Deployment roadmap" (pilot with VT Career Services -> campus -> multi-campus)
       "Consulting framing" (who owns it, what it costs, what it saves)

ELEVENLABS                                                              [~5h]
   - Voice is the INTERFACE, not narration. Whole app operable eyes-free.
   - Two distinct personas: calm assistant vs. interviewer. Cheap, lands hard.
   - Barge-in / interruption handling so it feels live.
   - The refusal spoken aloud: "I stopped. That employer could not prove who it
     is — its identity certificate doesn't match its domain. I have not sent
     anything." That single line wins this track AND the ANS track.
   - Bonus artifact: 30-second overnight audio briefing.

GEMINI                                                                  [~3h]
   - Multimodal: feed the resume PDF and the transcript PDF in directly. Handles
     two-column layouts and tables. Visibly impressive, trivially demoable.
   - JSON-schema structured output for profile + JD extraction. Show the schema.
   - Function-calling as the agent's tool router.
   - Steal the proven VTHacks winner move (GraphSense, 2025): let Gemini pick the
     right CHART TYPE for whatever the student asks about. ~40 lines.

TIGER DATA                                                              [~4h]
   - Hypertable: application_events(time, user_id, job_id, event_type)
     event_type: viewed, tailored, verified, refused, submitted, callback, rejected
   - Continuous aggregate: rolling callback rate by company / role / skill
   - The money chart: "your callback rate drops 60% when you apply more than 5
     days after a posting goes live — here are 9 to hit in the next 48 hours."
     Time-series native. Only makes sense on a time-series DB. Wins the track.
   - Second chart, free: verification events over time — attacks blocked per hour.
   - Seed 30 days of synthetic history EARLY. Empty dashboards kill demos.

MONGODB ATLAS                                                           [~1h]
   - Raw JD documents + the immutable A2A audit log (every message, every
     verification verdict, exactly what PII was released and to whom).
   - The audit log is also the trust story. One store, two tracks.

VULTR                                                                   [~2h]
   - Host the employer agent + API. ANS requires a public HTTPS endpoint, so this
     is load-bearing infrastructure. Say that in the pitch.
   - Gift code: MAJORLEAGUEHACKING

GODADDY REGISTRY (MLH, separate from ANS)                            [~10 min]
   - Register the domain. Code MLH0918VTH. It doubles as our ANS identity anchor.
   - Free prize category. Just do it.

PRESAGE                                            [~3h, ONLY IF AHEAD — Tier 2]
   - Read stress / engagement from the webcam during the mock interview and coach
     on it. Thematically the best-fitting bonus track on the board.

SOLANA                                                                  [SKIP]
   - No honest fit. Judges can tell. Spend the hours on ANS instead — same
     "verifiable identity" instinct, and it's actually load-bearing for us.


--------------------------------------------------------------------------------
5. MUST / SHOULD / SKIP
--------------------------------------------------------------------------------

MUST (this is the winning demo — nothing here is optional)
  M1  Domain + 2 ANS agents registered & ACME-verified          [start hour 1]
  M2  Voice in/out -> Gemini tool router -> action
  M3  Gemini multimodal resume + transcript -> profile JSON
  M4  Databricks jobs table + embeddings + match with reasoning
  M5  A2A apply with verify-before-PII, and the REFUSAL path
  M6  Trust Card UI (5 dimensions + reasons) read aloud
  M7  TigerData hypertable + funnel dashboard (seeded)
  M8  Accessible frontend: keyboard-only, ARIA, contrast
  M9  Deployed on Vultr, MongoDB audit log wired

SHOULD (each is a distinct beat in the pitch; cut from the bottom up)
  S1  Live attack console vs fraud.webmesh.ai with blocked counter
  S2  Coursework lever query ("take CS 3214 -> +40% postings")
  S3  Skill-gap query
  S4  Voice mock interview, second persona
  S5  Deployment-roadmap + consulting slides (Deloitte scores these)
  S6  Gemini auto-chart-type selection
  S7  Overnight audio briefing

SKIP — say no now, not at 4 AM
  Playwright / real ATS form filling        (replaced by A2A)
  Solana                                    (no honest fit)
  Auth, payments, mobile, multi-user, resume WYSIWYG
  Presage                                   (unless S1-S7 are all done)


--------------------------------------------------------------------------------
6. CAN WE ACTUALLY DO IT IN 23 HOURS? — HONEST MATH
--------------------------------------------------------------------------------

  MUST list, focused work:            ~34 h
  Integration + debugging tax (x1.5): ~51 h
  Demo, Devpost, rehearsal:            ~5 h
  TOTAL:                              ~56 person-hours

  Available: 4 people x ~19 effective hours (23 minus food/sleep/judging) = 76 p-h
  Headroom: ~20 p-h  -> that is the SHOULD list, in order, top down.

  VERDICT: achievable, with real margin, PROVIDED:
    - Playwright and Solana stay cut. They were ~7 h with the debugging tax.
    - M1 (DNS/ACME) starts in hour 1. It is the only wall-clock-bound item; if it
      starts at hour 14 the whole ANS track dies and we lose the richest prize.
    - Nobody adds a feature after the T-3h freeze.
  With 3 people instead of 4 (57 p-h): still doable, but drop S4-S7 immediately
  and treat the SHOULD list as S1-S3 only.


--------------------------------------------------------------------------------
7. SCHEDULE — 4 PARALLEL LANES (T = hours before the 8:00 AM ET deadline)
--------------------------------------------------------------------------------

  LANE A (identity)   LANE B (data)      LANE C (agent/voice)  LANE D (frontend)

T-23  domain+ANS CLI  Databricks schema  ElevenLabs keys       Next.js skeleton
      generate CSRs   scrape 500 JDs     Gemini keys           stub dashboard
T-21  register both   embeddings in SQL  resume PDF -> JSON    Trust Card layout
      DNS TXT -> ACME  seed Tiger events  tool router          keyboard nav
T-18  verify + certs  vector index       voice in/out loop     wire to stubs
T-15  employer agent  match + reasoning  tailor + cover letter funnel charts
      endpoint live   skill-gap SQL
T-12  A2A handshake   coursework query   apply() tool          Trust Card live
      verify-before-PII                  refusal path spoken
T-9   fraud.webmesh   AI/BI dashboard    mock interview        accessibility pass
      attack console  MongoDB audit log                        Vultr deploy
T-6   INTEGRATE — everyone on one machine, run the demo end to end, fix what breaks
T-3   *** CODE FREEZE *** record demo video · Devpost · select ALL categories
T-1   rehearse the 4-min pitch three times out loud · warm the SQL warehouse
T-0   SUBMIT.   Judging 10:30 AM, full team present.

  Saturday fixed points — do not miss these:
    GoDaddy sponsor table   1:00-3:30 PM  (get the ANS API key, let them attack us)
    GoDaddy Workshop #2     4:30-5:15 PM  (hands-on office hours)


--------------------------------------------------------------------------------
8. THE 4-MINUTE PITCH
--------------------------------------------------------------------------------

  0:00  Screen-reader clip of a real Workday form. "40 minutes. One application.
        She needs to do it 60 times." Do not introduce yourselves.
  0:30  Second problem, one number: scam postings, and who they target.
  1:00  LIVE: voice command -> roles found against skills AND coursework ->
        tailored -> employer verified -> submitted. Narrate outcomes, not clicks.
  2:00  THE REFUSAL. Point at fraud.webmesh.ai. Attacks blocked, counter climbing,
        agent says out loud why it stopped and confirms nothing was sent.
        This is the moment that wins the room.
  2:45  The two insight charts: time-decay callback rate, coursework lever.
  3:15  Architecture, 15 seconds, naming each sponsor tech and why it was right.
        Then the deployment-roadmap slide (Deloitte scores it).
  3:40  Impact. Ut Prosim, once, sincerely. Stop talking, leave 20s for Q&A.

  ANSWERS TO HAVE READY
   "Isn't this spamming employers?"
     -> Backwards. Verification runs both ways: the employer's agent confirms
        ours is a real, domain-anchored, human-backed applicant. We reduce fake
        applicants. Plus every submit is human-confirmed and fully audit-logged.
   "What does ANS actually do here that TLS doesn't?"
     -> TLS proves a server owns a domain to a human. ANS proves which agent,
        which version, under whose control, with an auditable change history —
        machine to machine, either side able to demand proof.
   "What did Databricks actually do?"
     -> Lakehouse job corpus, embeddings and fit scoring in SQL via ai_query,
        vector search, skill-gap and coursework aggregations, AI/BI dashboard.
        Open the notebook.
   "Why Tiger Data over plain Postgres?"
     -> Hypertable + continuous aggregates; the time-decay and rolling
        callback-rate queries ARE the product.
   "Does it work with Workday today?"
     -> No. A2A with verified employer agents today; legacy ATS bridging is on
        the roadmap. Be honest — overclaiming loses judges faster than a gap does.
APPENDIX A — ENVIRONMENT AS PROVISIONED (verified working)
================================================================================

LOCAL TOOLING
  Databricks CLI ..... v1.17.0 (Homebrew, databricks/tap)
  AI Dev Kit ......... ~/.ai-dev-kit, global scope, tool=claude
  Skills ............. 35 in ~/.claude/skills
                       (26 Databricks agent skills + 8 MLflow + core)
                       manage with: databricks aitools list|update|uninstall
  Auth ............... profile DEFAULT, OAuth, creds in OS keyring

WORKSPACE (Databricks Free Edition, AWS)
  Host ............... <WORKSPACE_HOST>          # see .env.local
  Workspace ID ....... <WORKSPACE_ID>
  Catalogs ........... workspace (MANAGED — build here), samples, system
  SQL Warehouse ...... "Serverless Starter Warehouse"
                       id = <WAREHOUSE_ID>, 2X-Small, serverless
                       auto-starts on first query (~20-30s cold)
  Vector Search ...... endpoint "vthacks-vs" CREATED and ONLINE (STANDARD)
                       0 indexes so far

FOUNDATION MODELS AVAILABLE (pay-per-token, no setup, no external API key)
  LLMs        databricks-llama-4-maverick, databricks-gpt-oss-120b,
              databricks-gpt-oss-20b, databricks-qwen35-122b-a10b,
              databricks-qwen3-next-80b-a3b-instruct, databricks-gemma-3-12b,
              databricks-meta-llama-3-3-70b-instruct,
              databricks-meta-llama-3-1-8b-instruct
  Embeddings  databricks-gte-large-en (1024-dim, VERIFIED),
              databricks-bge-large-en, databricks-qwen3-embedding-0-6b

VERIFIED SMOKE TESTS
  SELECT current_catalog()                                      -> workspace
  ai_query('databricks-llama-4-maverick', 'Reply with: OK')     -> OK
  size(ai_query('databricks-gte-large-en','backend engineer'))  -> 1024

WHAT THIS CHANGES ABOUT THE PLAN
  * ai_query() works in plain SQL. You can do JD parsing, skill extraction and
    fit scoring as SQL columns over the jobs table — no Python service, no
    external key, no rate limit juggling. This is the single fastest path to a
    credible Databricks track entry. Prefer it over hand-rolled API calls.
  * Embeddings are one SQL call. Semantic job<->resume matching is:
      embed the resume once, embed 500 JDs once, cosine similarity.
    With Vector Search online you can do it properly with an index; if the index
    build is slow at 3am, the SQL cosine fallback over 500 rows is instant and
    nobody can tell the difference in a 4-minute demo. Have both.
  * Gemini is still worth keeping for multimodal resume PDF ingestion and the
    voice-agent tool routing (that is the MLH track you want), but you no longer
    need Gemini for the bulk scoring. Split them cleanly in the pitch:
      Gemini  = multimodal understanding + agent reasoning
      Databricks = the data plane, embeddings at scale, and the analytics
    Judges from both companies then hear a reason their tech was chosen.

QUICK REFERENCE COMMANDS
  Run SQL:
    databricks api post /api/2.0/sql/statements --json @q.json
    (put the JSON in a file — inline quoting through zsh will bite you)
  List skills:        databricks aitools list
  Re-auth:            databricks auth login --profile DEFAULT
  Warehouse state:    databricks warehouses get <WAREHOUSE_ID>
  Delete VS endpoint: databricks vector-search-endpoints delete-endpoint vthacks-vs

GOTCHAS FOUND
  * macOS has no `timeout` command (use gtimeout from coreutils, or omit).
  * Inline JSON with single quotes inside --json gets mangled by zsh. Use @file.
  * The warehouse is STOPPED between uses and cold-starts ~20-30s. Fire a dummy
    query 2 minutes before you demo so it is warm on stage.


================================================================================
APPENDIX B — WHY THIS SHAPE WINS (VTHacks 11/12/13 winner analysis, condensed)
================================================================================
  A  Accessibility/assistive tech is the highest win-rate category by a wide
     margin. StoryVue (13, top), AccessVT, MapAbility, VisionLink, SeeBoard,
     ASLator, StreetBoxer. It also sweeps DEI + Accessibility + Ut Prosim.
  B  Ut Prosim is a real judging lens. Service beats commercial polish.
  C  Campus-specific beats generic. HokieLot, SmartOH, VTCourseNav, Subleasing VT.
  D  Agentic document->experience pipelines are the current meta (Cognita, 13 #2).
  E  Career/fintech tools are the most saturated, lowest-placing cluster —
     CrediWise, MoneyLens, Spectrabot, CardWise, intrst., GoGetters. This is why
     we lead with accessibility + verified identity, NOT "auto-apply to jobs."
  F  Winners stack categories. Select everything you qualify for.
  G  Official rubric is 4 equal axes: technical execution / innovation /
     impact+usefulness / presentation+completeness. Two of four are non-code.
     Budget 3 hours for them. That is where the marginal trophy is.
  H  "Best Hack That Didn't Work" exists. If it collapses at 6 AM, pivot the
     narrative there rather than no-showing.
================================================================================



================================================================================
APPENDIX C — UI/UX: WINNING THE POLAROID (Best UI/UX Hack)
Note: Peraton ran a separate "Best UX/UI Design" track at VTHacks 13 and is a
sponsor again this year with details TBD — this work may win TWO prizes. Ask at
their table what their track is.
================================================================================

--------------------------------------------------------------------------------
C1. THE STACK — copy-paste, accessible, open source, all verified current
--------------------------------------------------------------------------------

BASE LAYER — shadcn/ui
  Site    https://ui.shadcn.com
  Repo    https://github.com/shadcn-ui/ui
  Radix primitives underneath, so keyboard nav + ARIA are correct by default.
  Components land in YOUR repo (no lock-in). This makes our accessibility story
  true rather than aspirational.
  Radix docs: https://www.radix-ui.com/primitives

VOICE UI — LiveKit "Agents UI"        *** HIGHEST-VALUE FIND FOR US ***
  Product https://livekit.com/products/agents-ui
  Docs    https://docs.livekit.io/frontends/agents-ui/audio-visualizer/prebuilt/
  Repo    https://github.com/livekit/components-js  (/packages/shadcn)
  Starter https://github.com/livekit-examples/agent-starter-react
  Blog    https://livekit.com/blog/design-voice-ai-interfaces-with-agents-ui
  Announce https://community.livekit.io/t/introducing-agents-ui-an-open-source-shadcn-component-library/443
  Open-source shadcn registry for voice-agent frontends: FIVE audio visualizer
  styles, each with distinct behavior per agent state — connecting, listening,
  thinking, speaking. Plus media controls, session mgmt, chat transcripts.
  CAVEAT: built against LiveKit audio tracks; we're on ElevenLabs. Either lift
  the visualizer and drive it from a Web Audio AnalyserNode on the ElevenLabs
  stream (~20 lines), or use it as pure design reference. Do NOT migrate our
  voice layer to LiveKit at this hour.

DASHBOARD + CHARTS — Tremor
  Site    https://www.tremor.so
  NPM kit https://npm.tremor.so
  Repo    https://github.com/tremorlabs/tremor
  35+ components: charts, KPI cards, trackers, tables. Tailwind + Radix, backed
  by Vercel. As of 2026 the Blocks library (300+ sections) and every official
  template are free and open source. "Show the data, hide the chrome."

AGENT / CHAT UI — assistant-ui
  Site    https://www.assistant-ui.com
  Repo    https://github.com/assistant-ui/assistant-ui
  12k+ stars. Two features that fit us precisely:
   - generative UI: render tool calls as React components (our agent's tool
     calls become live cards, not a text log)
   - INLINE HUMAN APPROVALS — literally our verify-before-PII gate. Don't
     hand-roll it.

ELEVENLABS REFERENCE
  Starter https://github.com/elevenlabs/elevenlabs-nextjs-starter
  Examples https://github.com/elevenlabs/examples
  Next.js quickstart https://elevenlabs.io/docs/eleven-agents/guides/quickstarts/next-js
  Use for SDK wiring, not visual design.

OPTIONAL POLISH (cheap, high perceived quality)
  motion (Framer Motion)  https://motion.dev
  sonner (toasts)         https://sonner.emilkowal.ski
  cmdk (command palette)  https://cmdk.paco.me · https://github.com/pacocoursey/cmdk
  lucide (icons)          https://lucide.dev
  Geist font / tokens     https://vercel.com/geist

ACCESSIBILITY RIGOR
  eslint-plugin-jsx-a11y  https://github.com/jsx-eslint/eslint-plugin-jsx-a11y
                          install hour 1 — catches violations as you type
  axe DevTools            https://www.deque.com/axe/devtools/
  Accessibility Insights  https://accessibilityinsights.io
  React Aria (Adobe)      https://react-spectrum.adobe.com/react-aria/
                          https://github.com/adobe/react-spectrum
                          The most rigorous WCAG implementation available. TOO
                          SLOW to adopt now, but name it in Q&A: "Radix for
                          delivery speed; React Aria is the migration path for
                          stricter compliance." Judges reward a named tradeoff.

--------------------------------------------------------------------------------
C2. WHAT ACTUALLY WINS A UI/UX PRIZE (matters more than the libraries)
--------------------------------------------------------------------------------

1. ONE IDEA, EXECUTED CONSISTENTLY. Judges reward coherence, not component count.
   Pick one visual metaphor and hold it everywhere. Suggestion: "the agent is a
   colleague reporting back" — everything is a card the agent hands you.

2. THE AGENT-STATE VISUALIZER IS OUR SIGNATURE. Judges remember motion. Five
   states, visually distinct, each also announced to screen readers:
       idle · listening · thinking · speaking · REFUSING
   Give REFUSING its own treatment — halt, desaturate, red. That single state
   ties the UI directly to the ANS trust story. No other team will have it.

3. THE TRUST CARD IS OUR HERO COMPONENT. Design it like a nutrition label or a
   credit score: five dimensions (Integrity, Identity, Solvency, Behavior,
   Safety), each with its REASON, not just a number. Make this the most
   beautiful thing on screen. It is what the GoDaddy judges came to see.

4. COMMAND PALETTE THAT MIRRORS VOICE (cmdk). "Everything you can say, you can
   type." Simultaneously a power-user feature, an accessibility feature (users
   who can't speak), and proof the voice layer isn't bolted onto a mouse app.

5. BUILD THE STATES NOBODY BUILDS. Empty, loading, error, offline, no-results.
   Teams skip these; judges click straight into them. A designed empty state
   reads as more finished than a fifth feature.

6. DARK MODE + prefers-reduced-motion. Ten lines each, both visible in 5 seconds.

7. *** PUT YOUR MOUSE DOWN DURING THE DEMO. ***
   Do the entire pitch with voice and keyboard only, and SAY you're doing it.
   For an accessibility app competing for a UI/UX prize this is the single most
   memorable, zero-cost move available. Practice it — it only works if the tab
   order is actually correct.

8. SHOW EVIDENCE, NOT CLAIMS. One slide: Lighthouse accessibility score + an axe
   scan with zero violations. "Accessible" is a claim; a 100 is proof.

9. REAL CONTENT ONLY. No lorem ipsum, no "John Doe," no placeholder logos. Real
   VT majors, real course codes, real company names from the scraped JDs.

10. ONE ACCENT COLOR, ONE FONT, 8px SPACING GRID. Contrast 4.5:1 body, 3:1 large.
    Most hackathon UIs lose on inconsistent spacing long before ideas.

--------------------------------------------------------------------------------
C3. APPS WORTH STUDYING — the bar we are aiming at
--------------------------------------------------------------------------------
  Linear         https://linear.app
                 keyboard-first density, motion restraint. THE reference for #4.
  Raycast        https://www.raycast.com
                 command palette interaction model, done better than anyone.
  Superhuman     https://superhuman.com
                 keyboard-only workflow as a product identity — our demo move #7.
  Vercel / Geist https://vercel.com/geist
                 design tokens, spacing, and genuinely good empty states.
  Stripe docs    https://docs.stripe.com
                 information density done calmly. Steal the layout rhythm.
  Resend         https://resend.com
                 minimal SaaS aesthetic, very copyable in a hackathon timeframe.
  Perplexity     https://www.perplexity.ai
                 agent "thinking" and streaming-state UI, live to inspect.
  Granola        https://www.granola.ai
                 voice/transcript product UI — closest sibling to our app.
  ElevenLabs     https://elevenlabs.io
                 their own site is a strong voice-product reference.

VOICE / AGENT UI CODE TO INSPECT
  OpenAI Realtime Console  https://github.com/openai/openai-realtime-console
  LiveKit Agents Playground https://github.com/livekit/agents-playground
  Vapi                     https://vapi.ai
  Retell                   https://www.retellai.com

--------------------------------------------------------------------------------
C4. INSPIRATION GALLERIES — when you're stuck on a layout
--------------------------------------------------------------------------------
  BOOKMARK THESE THREE FIRST
  Mobbin        https://mobbin.com
                Real product screens, searchable by screen type. Designing an
                empty state? Search "empty state," see 50 real ones. Most
                practical tool on this list.
  Refero        https://refero.design
                The web/SaaS equivalent of Mobbin — real web app screenshots
                organized by page type and UI component.
  Land-book     https://land-book.com
                Modern landing pages; good for our Devpost hero section.

  VISUAL / AWARD-TIER
  Godly         https://godly.website      contemporary, AI tools + SaaS
  Awwwards      https://www.awwwards.com
  SiteInspire   https://www.siteinspire.com
  Minimal Gal.  https://minimal.gallery
  Lapa Ninja    https://www.lapa.ninja

  SPECIALIZED
  Dark Mode Design https://www.darkmodedesign.com   we're shipping dark mode
  Page Flows       https://pageflows.com            user flows as video
  UX Archive       https://uxarchive.com
  Collect UI       https://collectui.com            single-component ideas
  SaaS UI          https://www.saasui.design
  Typewolf         https://www.typewolf.com         typography pairings

--------------------------------------------------------------------------------
C5. SHADCN COMPONENT REGISTRIES — `npx shadcn add` straight into the repo
--------------------------------------------------------------------------------
  registry.directory  https://registry.directory   explorer for the whole ecosystem
  Awesome shadcn/ui   https://www.shadcn.io/awesome/registries
  Magic UI            https://magicui.design   150+ free animated components, 22k stars
  Aceternity UI       https://ui.aceternity.com  278 components: 3D cards, glowing
                      beams, spotlights, particles. Use SPARINGLY — one hero moment.
  Kokonut UI          https://kokonutui.com    AI surfaces and backgrounds — fits us
  Origin UI           https://originui.com     extends the primitive layer
  Cult UI             https://www.cult-ui.com
  21st.dev            https://21st.dev         large block marketplace
  Shadcnblocks        https://www.shadcnblocks.com

  WARNING: animation registries are a trap at hour 18. Pick ONE flourish for the
  hero moment (the agent visualizer) and leave the rest of the app calm. A busy
  UI reads as unfinished, not impressive.

--------------------------------------------------------------------------------
C6. ACCESSIBILITY REFERENCES — our whole thesis; get these right
--------------------------------------------------------------------------------
  ARIA Authoring Practices  https://www.w3.org/WAI/ARIA/apg/
                            The canonical keyboard + ARIA pattern for every
                            widget. If in doubt, copy the pattern from here.
  Inclusive Components      https://inclusive-components.design
  The A11Y Project          https://www.a11yproject.com
  WebAIM contrast checker   https://webaim.org/resources/contrastchecker/
  WCAG quick reference      https://www.w3.org/WAI/WCAG22/quickref/

--------------------------------------------------------------------------------
C7. COLOR, TYPE, MOTION — 15-minute decisions, do not agonize
--------------------------------------------------------------------------------
  Realtime Colors  https://www.realtimecolors.com  preview a palette on a real
                   layout instantly. Fastest way to lock a color scheme. START HERE.
  Coolors          https://coolors.co
  Huemint          https://huemint.com
  Fontshare        https://www.fontshare.com     free, high-quality fonts
  Google Fonts     https://fonts.google.com
  Type Scale       https://typescale.com
  Utopia           https://utopia.fyi            fluid type + space scales
  Easings          https://easings.net
  Cubic Bezier     https://cubic-bezier.com

TIMEBOX: 30 MINUTES OF LOOKING, TOTAL, ACROSS ALL OF C3-C7. Then build.
A gorgeous half-app loses to a coherent whole one, and the rubric weights
impact and completeness equally with execution.
================================================================================

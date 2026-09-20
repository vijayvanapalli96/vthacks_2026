#!/usr/bin/env node
/**
 * provision-voice-agent.mjs — create (or update) the ElevenLabs agent from code.
 *
 *   npm run voice:agent            # create, print the id
 *   npm run voice:agent -- --update agent_xxx   # push this config onto an existing one
 *
 * WHY THIS EXISTS RATHER THAN "make it in the dashboard". The prompt is the most
 * behaviour-defining part of the voice feature and it decides, among other things,
 * whether the agent invents answers. Leaving it in a web UI means it is unversioned,
 * unreviewable, and gone the moment somebody clicks the wrong thing. Here it diffs.
 *
 * Reads ELEVENLABS_API_KEY from .env.local. Prints the agent id; PRINTS NO KEY.
 * Put the id in .env.local as ELEVENLABS_AGENT_ID.
 *
 * COST NOTE: creating an agent is free. Talking to it is not — ElevenLabs bills per
 * conversation-minute and this account is on the free tier.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.elevenlabs.io/v1';

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  // Minimal .env reader. Adding dotenv to dependencies for one script is not worth it.
  const text = readFileSync(resolve(HERE, '..', '.env.local'), 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('ELEVENLABS_API_KEY='));
  const value = line?.slice('ELEVENLABS_API_KEY='.length).trim();
  if (!value) throw new Error('ELEVENLABS_API_KEY not found in the environment or .env.local');
  return value;
}

/**
 * The system prompt.
 *
 * THIS AGENT IS NO LONGER A QUESTION-ASKER, AND THE PROMPT IS WHERE THAT CHANGES.
 * It has six tools, it is told where the user is, and it is told — in as many words —
 * the one thing it must not do.
 *
 * Six things it has to get right, because each is a way the demo breaks:
 *  - ONE question at a time, when it is asking at all. A stacked "and also, and also"
 *    gets one answer for three fields and the other two are recorded wrong.
 *  - record_answer after EVERY answer, with the exact field_key from the queue.
 *  - Never invent, never infer. A confidently wrong stored value is the worst outcome.
 *  - Read back what a tool said it did. The user cannot see the database, so the only
 *    way they learn it misheard them is if it says what it wrote.
 *  - IT CANNOT APPLY. Hard rule 3: ANS resolve, certificate, Trust Index, policy gate,
 *    HUMAN CONFIRM, then fields. There is no apply tool — enforced in code, in
 *    VoiceAgent.tsx's clientTools — and this prompt says so too, so the model does not
 *    have to discover the limit by having a call fail and then improvise around it.
 *  - NEVER READ A job_id OUT LOUD. They are long derived keys; reading one aloud is
 *    thirty seconds of noise and teaches the user nothing. Positions and names are how
 *    humans refer to a list.
 */
const PROMPT = `You are the HIREWIRE assistant. You are the calm, brisk one — not a salesperson, not a therapist. You help a university student find work: you finish their profile, you read their match results back to them, you explain why a role scored the way it did, and you take them to the right page. You do things, not just ask things.

WHO YOU ARE TALKING TO
{{known_name}} is a student. We have already read their documents and recorded {{known_facts}} facts about them.

WHERE THEY ARE RIGHT NOW
{{page_name}}

{{page_context}}

That description comes from the app itself, not from you. You will be sent an updated one every time they move to another page, and whenever their matches change. ALWAYS trust the most recent one over anything earlier in the conversation. If you have not been told what is on screen, say you are not sure and ask — never describe a page you have not been told about.

YOUR TOOLS
- record_answer — store an answer to one of the profile questions below.
- list_matches — read their current match list back. Name AT MOST THREE roles out loud, with their scores, and say the rest are on screen. Never read ten titles aloud; nobody can hold that.
- explain_match — why a role scored what it did. This returns the explanation that was written when the match ran, including which of their skills line up and which required skills are missing. Read it back in your own words, briefly. Do not embellish it and do not invent a reason it does not give you.
- refresh_matches — re-run the match agent against fresh postings. This is EXPENSIVE and takes up to a minute: say you are running it, say roughly how long, then wait. Never call it twice for one request, and never call it just because they asked "what are my matches" — use list_matches for that.
- open_page — take them somewhere. target is one of: dashboard, matches, job, apply, profile, activity, pipeline. For target "job" or "apply" you must also pass job_ref.
- set_job_status — record where a role stands: saved, applied, interviewing, rejected, dismissed. "Save that one" is status "saved".

HOW TO REFER TO A JOB (job_ref)
Pass the exact job_id string from the MATCH IDS line you were given, when you have it. You may also pass what the user said — "the second one", "the Stripe one", "the top one" — and the app will resolve it against their real list. If it cannot, it will refuse and tell you why: say that reason out loud and ask them which one they meant. Do NOT try a different job. Do NOT read a job_id out loud, ever — they are long machine keys and useless to a human. Refer to roles by title, company and position in the list.

THE ONE THING YOU CANNOT DO: APPLY
You cannot apply to a job. You cannot send a CV, an email, a form, or any personal detail to an employer. There is no tool for it and there will not be one. Nothing about this student leaves the system until they have read the approval page themselves and approved it.
So when they say "apply to that one": say plainly that you can take them to the approval page but you cannot send anything yourself — they approve what leaves — and then call open_page with target "apply" and the job_ref. Then STOP. Do not narrate what would happen next. Never say "applying now", "I have applied", "sent", or "submitted". If they push, repeat that the last step is theirs. This limit is the product working correctly, so say it as a feature and not as an apology.

BEING USEFUL WITHOUT BEING PUSHY
- When you are told a new match run has landed, volunteer it: name the strongest three with their scores and ask if they want you to open one or explain one. Then wait.
- After you open a role, you already have its reason in the page description. Offer it: one sentence on why it scored, one on what they are missing.
- Offer to save a role when they sound interested. One offer, not three.
- If they want the profile questions instead, go back to them. They are not more important than what the student asked for.

THEIR OUTSTANDING PROFILE QUESTIONS — {{gap_count}}, in this order:
{{gap_queue}}

Each line is numbered and begins with a [field_key] in square brackets. That field_key is the exact string you pass to record_answer. Never invent a field_key and never use one that is not in the queue above. Ask ONE at a time, in order, in your own words; never bundle two into one sentence. Pass what they actually said, in their own words — do not tidy it, do not normalise it into a category, do not convert "ninety thousand" into a number. The system does that and keeps their wording too. The answerable field_keys are: {{answerable_fields}}.

RULES YOU DO NOT BREAK
- Every tool returns a sentence saying what it actually did. Read the essential part of it back — one short clause, "Got it, full-time" or "Saved the Stripe one". If it says something failed, was refused, or could not be understood, SAY THAT PLAINLY. Never pretend a tool succeeded. Never describe an action you did not take.
- Never guess, infer or fill in an answer the user did not give. If their reply does not answer the question, ask once more, more specifically; if it still does not, leave it and move on without calling record_answer.
- If they ask to skip something, skip it. Do not push.
- Never invent a job, a company, a score or a reason. If you have no match list, say so and offer to run one.
- If they ask what you know about them, say you have read their documents and recorded {{known_facts}} facts and that they can see all of it on their profile page. Do not recite specifics.
- Never say an email address, phone number or postal address out loud, and never ask them to confirm one over voice. If they need to check those, send them to the profile page.
- You do not give visa, legal or salary advice.
- Keep every turn short. This is speech, not prose. Two sentences is usually too many.

WHEN THERE IS NOTHING LEFT
If the queue is empty and they have nothing they want, say so, mention that everything is on their profile page and that anything you can do they can also click or type, and stop. Do not invent work to fill time.`;

/**
 * A client tool definition, with the two fields that are always the same.
 *
 * `response_timeout_secs` is generous because every one of these crosses a Databricks
 * warehouse that cold-starts in 20-30 seconds. The browser answers optimistically
 * before the timeout anyway (see the Promise.race in VoiceAgent.tsx) — this is the
 * ceiling, not the expected latency.
 */
function clientTool(name, description, properties = {}, required = []) {
  return {
    type: 'client',
    name,
    description,
    expects_response: true,
    response_timeout_secs: 20,
    parameters: { type: 'object', properties, required },
  };
}

/** The shared description of a job reference, so all four tools agree on it. */
const JOB_REF = {
  type: 'string',
  description:
    'Which job. Prefer the exact job_id from the MATCH IDS line you were given. You may also pass what the user said — "the second one", "the Stripe one", "the top one" — and the app resolves it against their real match list, refusing if it cannot. Never read this value out loud.',
};

const config = {
  name: 'HIREWIRE assistant (actions)',
  conversation_config: {
    agent: {
      // A dynamic variable, not a literal, so the opening line is computed server-side
      // in buildFirstMessage() and the transcript's first line is exactly what was
      // said. A prompt-generated greeting would be a second, unlogged source of truth.
      first_message: '{{first_message}}',
      language: 'en',
      prompt: {
        prompt: PROMPT,
        /**
         * SIX TOOLS, AND A SEVENTH THAT DELIBERATELY DOES NOT EXIST.
         *
         * There is no `apply`. Hard rule 3 requires ANS resolution, a certificate
         * check, a Trust Index, a policy gate and a HUMAN CONFIRMATION before any field
         * leaves, and none of that can happen inside a spoken turn. The agent can call
         * open_page with target "apply" — which is the approval PAGE — and it stops
         * there. The absence is enforced in three places on purpose: this list, the
         * `clientTools` object in VoiceAgent.tsx, and a paragraph of the prompt above,
         * because a model that discovers a limit by having a call fail will improvise
         * around it.
         *
         * Every tool here is backed by an endpoint that a BUTTON in TranscriptPanel
         * also calls (hard rule 5). None of them takes a user id: the browser's fetch
         * carries the session cookie and the server resolves the user from it.
         */
        tools: [
          clientTool(
            'record_answer',
            "Record the user's answer to ONE question from the profile queue. Call this immediately after they answer, once per question. field_key must be copied exactly from the square brackets in the queue.",
            {
              field_key: {
                type: 'string',
                description:
                  'The exact field_key in square brackets from the question queue, e.g. employment_type. Never invented.',
              },
              value: {
                type: 'string',
                description:
                  "The user's answer in their own words. Not normalised, not categorised, not converted to a number.",
              },
            },
            ['field_key', 'value'],
          ),

          clientTool(
            'get_page_context',
            'Ask what page the user is currently on and what is on it. You are normally SENT this automatically whenever they navigate, so only call it if you have lost track or the conversation has been going a long time. Costs nothing.',
          ),

          clientTool(
            'list_matches',
            'Read the user\'s current match list. Returns the strongest three as a sentence plus a count of the rest. Reads from the last completed match run — it does NOT re-run anything and costs nothing. Use this for "what are my matches", "what have I got", "read them out". Name at most three roles out loud.',
          ),

          clientTool(
            'explain_match',
            'Why one role scored the way it did: the explanation written when the match ran, which of the user\'s skills line up, and which required skills are missing from their profile. Costs nothing — it is read from storage, not generated. Use this for "why am I a good fit", "why did that score so high", "what am I missing".',
            { job_ref: JOB_REF },
            ['job_ref'],
          ),

          clientTool(
            'refresh_matches',
            'Re-run the match agent against fresh postings. EXPENSIVE: about twenty model calls and up to a minute of work. Only call it when the user explicitly asks for new or reloaded matches. Say it is running and roughly how long before you call it, then wait for the result. Never call it twice for one request. For "what are my matches" use list_matches instead.',
          ),

          clientTool(
            'open_page',
            'Navigate the user to a page. target "apply" opens the APPROVAL page for a role — it does not apply, and you must say out loud that you cannot send anything yourself before calling it. The app validates the job against the user\'s own match list and refuses if it does not resolve; if it refuses, say the reason and ask which role they meant.',
            {
              target: {
                type: 'string',
                enum: ['dashboard', 'matches', 'job', 'apply', 'profile', 'activity', 'pipeline'],
                description:
                  'Where to go. "job" opens one role from their match list; "apply" opens the approval page for one role. Both require job_ref.',
              },
              job_ref: JOB_REF,
            },
            ['target'],
          ),

          clientTool(
            'set_job_status',
            'Record where a role stands for this user. "Save that one" is status "saved". status "applied" records THAT THE USER SAYS THEY APPLIED — it is never you reporting that you applied, because you cannot apply. Returns a sentence saying what changed, or why it did not.',
            {
              job_ref: JOB_REF,
              status: {
                type: 'string',
                enum: ['saved', 'applied', 'interviewing', 'rejected', 'dismissed'],
                description: 'The stage to record. Default to "saved" when they just say to save it.',
              },
              note: {
                type: 'string',
                description:
                  'Optional. Anything the user said about why, in their own words. Never a summary you wrote.',
              },
            },
            ['job_ref', 'status'],
          ),
        ],
      },
    },
  },
  platform_settings: {
    overrides: {
      // Belt and braces alongside the dynamic variable: lets the app override the
      // opening line directly if the variable path ever changes upstream.
      conversation_config_override: {
        agent: { first_message: true },
      },
    },
  },
};

async function main() {
  const key = apiKey();
  const updateIndex = process.argv.indexOf('--update');
  const existing = updateIndex === -1 ? null : process.argv[updateIndex + 1];

  // `--update` MUTATES A LIVE AGENT, AND AGENTS ARE SHARED.
  //
  // During the build the id in .env.local was the whole team's agent. Pushing this
  // config onto it would have changed behaviour for a teammate mid-demo, with no
  // warning and no undo — you cannot diff an ElevenLabs agent against what it used to
  // be. Creating a new one is free, so the safe action is the default and the
  // destructive one has to be typed out.
  if (existing && !process.argv.includes('--confirm')) {
    console.error(
      `Refusing to overwrite agent ${existing}.\n\n` +
        'An agent id may belong to a teammate, and a PATCH has no undo. If you are\n' +
        'certain this one is yours, re-run with --confirm:\n\n' +
        `  npm run voice:agent -- --update ${existing} --confirm\n\n` +
        'Otherwise drop --update: creating a new agent is free, and you put its id in\n' +
        'YOUR OWN .env.local.\n',
    );
    process.exit(1);
  }

  const url = existing ? `${API}/convai/agents/${existing}` : `${API}/convai/agents/create`;
  const res = await fetch(url, {
    method: existing ? 'PATCH' : 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`ElevenLabs ${res.status}: ${text}`);
    process.exit(1);
  }

  const parsed = JSON.parse(text);
  const id = parsed.agent_id ?? existing;
  console.log(existing ? `Updated ${id}` : `Created ${id}`);
  console.log(`\nPut this in app/vthacks-career-app/.env.local:\n  ELEVENLABS_AGENT_ID=${id}\n`);
}

await main();

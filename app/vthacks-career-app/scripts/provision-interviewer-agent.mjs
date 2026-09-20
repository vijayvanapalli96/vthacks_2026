#!/usr/bin/env node
/**
 * provision-interviewer-agent.mjs — persona 2, the interviewer (F4.7).
 *
 *   npm run voice:interviewer                          # create, print the id
 *   npm run voice:interviewer -- --update agent_xxx --confirm
 *
 * A SECOND AGENT, NOT A SECOND PROMPT ON THE FIRST. See interviewerConfig() in
 * src/lib/elevenlabs.ts for why. The short version: the assistant's prompt is built
 * around a question queue it must not deviate from and a record_answer tool it must
 * call after every answer; an interviewer follows up on what it just heard and must
 * write nothing. One agent doing both does each badly, and the failure mode is the
 * one that logs a rehearsed answer as a profile fact.
 *
 * THIS AGENT HAS NO TOOLS AT ALL, and that is the design. The room drives the
 * question order, the answers, the critique and every write. The agent's entire job
 * is to say the questions out loud like a person and react like one. Giving it tools
 * would create a second path to the same writes, which hard rule 5 exists to prevent.
 *
 * Reads ELEVENLABS_API_KEY from .env.local. Prints the agent id; PRINTS NO KEY.
 * Put the id in .env.local as ELEVENLABS_INTERVIEWER_AGENT_ID.
 *
 * COST NOTE: creating an agent is free. Talking to it is not — ElevenLabs bills per
 * conversation-minute and this account is on the free tier. A mock interview is
 * minutes of continuous speech, which is the most expensive thing in this app.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.elevenlabs.io/v1';

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  // Minimal .env reader, matching provision-voice-agent.mjs. Adding dotenv to
  // dependencies for two scripts is not worth it.
  const text = readFileSync(resolve(HERE, '..', '.env.local'), 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('ELEVENLABS_API_KEY='));
  const value = line?.slice('ELEVENLABS_API_KEY='.length).trim();
  if (!value) throw new Error('ELEVENLABS_API_KEY not found in the environment or .env.local');
  return value;
}

/**
 * The interviewer prompt.
 *
 * Four things it must get right, because each is a way the rehearsal stops being
 * useful:
 *  - ASK THE QUEUE VERBATIM, IN ORDER. The room shows the same questions on screen
 *    and critiques the answers against them. An agent that improvises a seventh
 *    question produces an answer the critique has no criteria for.
 *  - ONE QUESTION, THEN SILENCE. Interview nerves and a talkative interviewer are
 *    the same failure: the candidate never gets their run at it.
 *  - NO COACHING MID-INTERVIEW. The critique arrives after each answer, on screen,
 *    computed. An agent that says "great answer!" to a weak one has taught the
 *    student the wrong thing and contradicted the panel next to it.
 *  - NOTHING ILLEGAL TO ASK. The queue is generated, and a generated question set is
 *    exactly the place a sponsorship or age question could appear. If one does, the
 *    agent skips it and says why.
 */
const PROMPT = `You are conducting a MOCK interview. {{candidate_name}} is a university student rehearsing for a real interview they have already been offered, for the {{role_title}} role at {{company_name}}. This is practice. Nothing here reaches the employer.

YOU ARE THE INTERVIEWER, not a coach and not an assistant. Be warm, unhurried and professional. Interviewers are not adversaries and they are not cheerleaders.

YOUR QUESTION QUEUE — {{question_count}} questions, in this order:
{{question_queue}}

Each line is numbered and begins with a [question_id] in square brackets. Ask the questions IN THIS ORDER and ASK THEM AS WRITTEN — you may rephrase lightly so it sounds like speech rather than a form, but never change what is being asked. Never add a question of your own to the list. Never read the [question_id] out loud.

HOW TO RUN IT
1. Greet them once, briefly, name the role, and say you will ask {{question_count}} questions. Then ask the first one.
2. ONE question, then STOP TALKING. Let the silence sit. A candidate thinking is not a candidate who needs help.
3. When they finish, you may ask ONE natural follow-up if something genuinely needs clarifying — "what was your part in that specifically?" is a good follow-up. Then move to the next question in the queue.
4. Acknowledge briefly and neutrally between questions: "Thank you", "Understood", "Let us move on". Do NOT evaluate. Do not say "great answer", "perfect", "that is exactly what we want to hear", or anything that tells them how they did. Written feedback appears on their screen after each answer and it is computed from what they actually said; your praise would contradict it.
5. If they ask to skip, skip without comment and go to the next question.
6. When the queue is finished, thank them, say the readout is on screen, and stop.

WHAT YOU NEVER DO
- Never ask about visa status, sponsorship, work authorisation, age, health, disability, religion, nationality, marital or family status, pregnancy, or salary history. If a question in the queue asks about any of these, SKIP IT and say plainly: "There is a question here that an interviewer should not ask, so I am skipping it." That is a correct outcome, not a failure.
- Never claim to be a real employee of {{company_name}} or of any company. If asked, you are a practice interviewer.
- Never give them the answer, and never hint at one. Never say what you were hoping to hear.
- Never promise, imply or speculate about an outcome. You have no influence over anything.
- Never invent facts about the company, the team, the salary or the process. If they ask something you were not given, say you do not have that and it is a good question for the real interview — that is genuinely useful.
- Never record, store or claim to store anything. You have no tools. If they ask you to save or change something, tell them the page can do it and you cannot.

Keep every turn short. This is speech. Two sentences is usually one too many.`;

const config = {
  name: 'HIREWIRE interviewer (persona 2)',
  conversation_config: {
    agent: {
      // Computed in the room rather than in the prompt, so the spoken opening and
      // the on-screen question list cannot drift.
      first_message:
        'Thanks for making the time. I have {{question_count}} questions about the {{role_title}} role. Whenever you are ready, tell me a little about your background.',
      language: 'en',
      prompt: {
        prompt: PROMPT,
        /**
         * NO TOOLS. Not an omission — see the header. The room owns every write, and
         * a tool here would be a second path to it.
         */
        tools: [],
      },
    },
  },
  platform_settings: {
    overrides: {
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

  // Same guard, same reason, as provision-voice-agent.mjs: an agent id may belong
  // to a teammate and a PATCH has no undo.
  if (existing && !process.argv.includes('--confirm')) {
    console.error(
      `Refusing to overwrite agent ${existing}.\n\n` +
        'An agent id may belong to a teammate, and a PATCH has no undo. If you are\n' +
        'certain this one is yours, re-run with --confirm:\n\n' +
        `  npm run voice:interviewer -- --update ${existing} --confirm\n\n` +
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
  console.log(`\nPut this in app/vthacks-career-app/.env.local:\n  ELEVENLABS_INTERVIEWER_AGENT_ID=${id}\n`);
}

await main();

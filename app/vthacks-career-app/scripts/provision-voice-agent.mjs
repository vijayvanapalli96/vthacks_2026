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
 * Four things it must get right, because each is a way the demo breaks:
 *  - ONE question at a time. A stacked "and also, and also" gets one answer for
 *    three fields and the other two are recorded wrong or not at all.
 *  - record_answer after EVERY answer, with the exact field_key from the queue.
 *    The queue is the source of truth; inventing a key gets a 400 and a lost answer.
 *  - Never invent, never infer. If the user rambles, ask again. A confidently wrong
 *    stored value is the single worst outcome here.
 *  - Read back what was recorded. The user cannot see the database; the only way
 *    they learn it misheard them is if it says what it wrote.
 */
const PROMPT = `You are the HIREWIRE profile assistant. You are the calm, brisk one — not a salesperson, not a therapist. You help a university student finish their job-search profile by asking a short list of questions out loud.

WHO YOU ARE TALKING TO
{{known_name}} is a student. We have already read their documents and recorded {{known_facts}} facts about them. You are only here for the things a resume cannot answer.

YOUR QUESTION QUEUE — {{gap_count}} question(s), in this order:
{{gap_queue}}

Each line is numbered and begins with a [field_key] in square brackets. That field_key is the exact string you must pass to the record_answer tool. Never invent a field_key and never use one that is not in the queue above.

HOW TO RUN THE CONVERSATION
1. Ask ONE question at a time, in queue order, in your own natural words. Never bundle two questions into one sentence — you will get one answer for two fields.
2. When the user answers, call record_answer with that question's field_key and their answer as the value. Pass what they actually said, in their own words. Do not tidy it, do not normalise it into a category, do not convert "ninety thousand" into a number — the system does that and keeps their wording too.
3. The tool replies with a sentence describing what was saved. Read the essential part of it back briefly, so they can hear if you misheard. One short clause is enough: "Got it — full-time." Do not read the whole sentence out.
4. If the tool reply says something could not be saved or could not be understood, say so plainly and move on. Never pretend a save worked.
5. Then ask the next question.

RULES YOU DO NOT BREAK
- Never guess, infer or fill in an answer the user did not give. If their reply does not actually answer the question, ask once more, more specifically. If it still does not, say you will leave it for now and move on — do NOT call record_answer.
- If they say they would rather skip one, skip it. Do not call the tool. Do not push.
- If they ask what you already know about them, say you have read their documents and recorded {{known_facts}} facts, and that they can see all of it on their profile page. Do not make specific claims about the contents.
- If they ask something you cannot do — apply to a job, contact an employer, change something you have no tool for — say plainly that you cannot do it from here. Never imply you have taken an action you have not.
- You do not give visa, legal or salary advice. You record what they tell you.
- Keep every turn short. This is speech, not prose. Two sentences is usually too many.

WHEN THE QUEUE IS EMPTY
Say that is everything you needed, tell them it is saved on their profile, mention they can always type answers instead of speaking, and stop. Do not invent extra questions to fill time.`;

const config = {
  name: 'HIREWIRE profile assistant',
  conversation_config: {
    agent: {
      // A dynamic variable, not a literal, so the opening line is computed server-side
      // in buildFirstMessage() and the transcript's first line is exactly what was
      // said. A prompt-generated greeting would be a second, unlogged source of truth.
      first_message: '{{first_message}}',
      language: 'en',
      prompt: {
        prompt: PROMPT,
        tools: [
          {
            type: 'client',
            name: 'record_answer',
            description:
              'Record the user\'s answer to ONE question from the queue. Call this immediately after they answer, once per question. field_key must be copied exactly from the square brackets in the queue. value must be what the user actually said, in their own words.',
            expects_response: true,
            // Long enough to survive a cold Databricks warehouse; the browser answers
            // optimistically before this anyway (see VoiceAgent.tsx).
            response_timeout_secs: 20,
            parameters: {
              type: 'object',
              properties: {
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
              required: ['field_key', 'value'],
            },
          },
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

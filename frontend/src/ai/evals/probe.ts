/**
 * `npm run ai:probe` — isolates which part of a request a provider rejects.
 *
 * OpenAI-compatible endpoints are not uniformly compatible. Google's in particular accepts
 * a narrower JSON-Schema subset for function declarations than OpenAI does, and the
 * resulting 400 names nothing useful. This sends a ladder of requests, each adding exactly
 * one feature, and reports the first rung that fails.
 *
 * Every request is deliberately tiny (max_tokens 16), so a full run costs a negligible
 * number of tokens.
 *
 * Usage:
 *   GOOGLE_API_KEY=... npm run ai:probe -- --model gemini-3.6-flash
 *   GROQ_API_KEY=...   npm run ai:probe -- --model llama-3.3-70b-versatile
 */

import { MODEL_OPTIONS } from '../providers';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const modelId = arg('model', 'gemini-3.6-flash')!;
const model = MODEL_OPTIONS.find(m => m.id === modelId);
if (!model) {
  console.error(`Unknown model "${modelId}". Available:\n${MODEL_OPTIONS.map(m => `  ${m.id}`).join('\n')}`);
  process.exit(1);
}

const KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', groq: 'GROQ_API_KEY',
  google: 'GOOGLE_API_KEY', mistral: 'MISTRAL_API_KEY', together: 'TOGETHER_API_KEY',
};
function providerOf(id: string): string {
  if (id.startsWith('claude-')) return 'anthropic';
  if (id.startsWith('llama-') || id.startsWith('mixtral-') || id.startsWith('gemma-')) return 'groq';
  if (id.startsWith('gemini-')) return 'google';
  if (id.startsWith('mistral-') || id.startsWith('codestral-')) return 'mistral';
  if (id.startsWith('meta-llama/')) return 'together';
  return 'openai';
}
const envVar = KEY_ENV[providerOf(modelId)];
const apiKey = process.env[envVar] ?? '';
if (!apiKey) {
  console.error(`No API key. Set ${envVar} in your environment.`);
  process.exit(1);
}

if (model.apiFormat !== 'openai') {
  console.error('This probe targets OpenAI-compatible endpoints only.');
  process.exit(1);
}

const URL = `${model.baseUrl}/chat/completions`;
const USER = { role: 'user', content: 'Reply with the single word: ok' };

/** A no-argument tool. Its schema has an empty `properties` object. */
const NO_ARG_TOOL = {
  type: 'function',
  function: {
    name: 'read_circuit',
    description: 'Read the circuit.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

/** A no-argument tool whose schema omits `properties` entirely. */
const NO_ARG_TOOL_NO_PROPS = {
  type: 'function',
  function: {
    name: 'read_circuit',
    description: 'Read the circuit.',
    parameters: { type: 'object' },
  },
};

/** An ordinary tool with typed string arguments. */
const TYPED_TOOL = {
  type: 'function',
  function: {
    name: 'build_circuit',
    description: 'Build a circuit.',
    parameters: {
      type: 'object',
      properties: { wires: { type: 'string' }, gates: { type: 'string' } },
      required: ['wires', 'gates'],
    },
  },
};

/** A tool using `additionalProperties` for an open-ended numeric map. */
const ADDITIONAL_PROPS_TOOL = {
  type: 'function',
  function: {
    name: 'add_gate',
    description: 'Add a gate.',
    parameters: {
      type: 'object',
      properties: {
        gateId: { type: 'string' },
        parameters: { type: 'object', additionalProperties: { type: 'number' } },
      },
      required: ['gateId'],
    },
  },
};

/** A tool with an `enum` constraint. */
const ENUM_TOOL = {
  type: 'function',
  function: {
    name: 'add_wire',
    description: 'Add a wire.',
    parameters: {
      type: 'object',
      properties: { wireType: { type: 'string', enum: ['qubit', 'qumode'] } },
      required: ['wireType'],
    },
  },
};

interface Rung {
  name: string;
  /** What this tells us if it fails. */
  meaning: string;
  body: Record<string, unknown>;
}

/**
 * Ordered by suspicion, not by complexity.
 *
 * Free tiers can be tiny — Gemini's newest models allow only a handful of requests — so a
 * run may exhaust the quota partway through. Whatever quota exists should be spent on the
 * rungs most likely to be the culprit, which means the multi-turn and tool_choice shapes
 * come before the schema variations.
 */
const RUNGS: Rung[] = [
  {
    name: 'plain chat, no tools',
    meaning: 'The endpoint, model id, or key is wrong — nothing to do with tool schemas.',
    body: { model: modelId, max_tokens: 16, messages: [USER] },
  },
  {
    name: "tool_choice: 'required'",
    meaning: "The provider rejects forcing a tool call. Fix: use 'auto' for this provider.",
    body: { model: modelId, max_tokens: 16, messages: [USER], tools: [TYPED_TOOL], tool_choice: 'required' },
  },
  {
    name: 'assistant tool_call with content: null',
    meaning: 'The provider rejects a null assistant content alongside tool_calls. Fix: send "" instead of null.',
    body: {
      model: modelId, max_tokens: 16, tools: [TYPED_TOOL],
      messages: [
        USER,
        {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'build_circuit', arguments: '{"wires":"q0","gates":""}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Built: W q0' },
      ],
    },
  },
  {
    name: 'assistant tool_call with content: ""',
    meaning: 'Even an empty-string content fails — the tool-result round-trip shape itself is wrong for this provider.',
    body: {
      model: modelId, max_tokens: 16, tools: [TYPED_TOOL],
      messages: [
        USER,
        {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'build_circuit', arguments: '{"wires":"q0","gates":""}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Built: W q0' },
      ],
    },
  },
  {
    name: 'system message + tools',
    meaning: 'The provider rejects a system role alongside tools.',
    body: {
      model: modelId, max_tokens: 16, tools: [TYPED_TOOL],
      messages: [{ role: 'system', content: 'You are a test.' }, USER],
    },
  },
  {
    name: 'tool with typed string args',
    meaning: 'The provider rejects ordinary function declarations. Very unusual.',
    body: { model: modelId, max_tokens: 16, messages: [USER], tools: [TYPED_TOOL] },
  },
  {
    name: 'tool with additionalProperties',
    meaning: 'The provider rejects `additionalProperties`. Fix: replace open-ended maps with a string argument.',
    body: { model: modelId, max_tokens: 16, messages: [USER], tools: [ADDITIONAL_PROPS_TOOL] },
  },
  {
    name: 'tool with enum',
    meaning: 'The provider rejects `enum` in function parameters. Fix: describe the options in prose instead.',
    body: { model: modelId, max_tokens: 16, messages: [USER], tools: [ENUM_TOOL] },
  },
  {
    name: 'no-arg tool  (properties: {})',
    meaning: 'The provider rejects an EMPTY properties object. Fix: omit `properties` for no-argument tools.',
    body: { model: modelId, max_tokens: 16, messages: [USER], tools: [NO_ARG_TOOL] },
  },
  {
    name: 'no-arg tool  (properties omitted)',
    meaning: 'The provider needs some other shape for no-argument tools — try a dummy optional argument.',
    body: { model: modelId, max_tokens: 16, messages: [USER], tools: [NO_ARG_TOOL_NO_PROPS] },
  },
];

/**
 * A 429 says nothing about whether the request shape is valid — the provider never looked
 * at it. Conflating the two produced a confidently wrong diagnosis, so quota exhaustion is
 * its own outcome and the rung is reported as untested.
 */
type Outcome =
  | { kind: 'ok' }
  | { kind: 'rejected'; status: number; detail: string }
  | { kind: 'quota'; detail: string }
  | { kind: 'network'; detail: string };

async function run(rung: Rung): Promise<Outcome> {
  try {
    const response = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(rung.body),
    });
    if (response.ok) return { kind: 'ok' };

    const text = await response.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error?.message ?? parsed.message ?? text;
    } catch { /* keep raw */ }
    detail = String(detail).replace(/\s+/g, ' ').slice(0, 400);

    if (response.status === 429) return { kind: 'quota', detail };
    return { kind: 'rejected', status: response.status, detail };
  } catch (e) {
    return { kind: 'network', detail: e instanceof Error ? e.message : String(e) };
  }
}

const delayMs = Number(arg('delay', '1500'));

async function main() {
  console.log(`\nHyQSim — request-feature probe`);
  console.log(`Model:    ${modelId}`);
  console.log(`Endpoint: ${URL}\n`);

  const rejected: Rung[] = [];
  const untested: Rung[] = [];
  let quotaDetail = '';

  for (const [index, rung] of RUNGS.entries()) {
    // Once the quota is gone every later request returns 429 regardless of its shape.
    // Continuing would burn time and print nothing trustworthy.
    if (quotaDetail) {
      untested.push(rung);
      continue;
    }

    process.stdout.write(`  ${rung.name.padEnd(40)}`);
    const r = await run(rung);

    // Rung 0 is the control: the simplest possible valid request. If it fails, the key,
    // model id or endpoint is wrong, and every later rung would fail for the same reason —
    // which would read as "every feature is rejected". Stop instead of lying.
    if (index === 0 && r.kind !== 'ok') {
      const detail = r.kind === 'quota' || r.kind === 'network' || r.kind === 'rejected' ? r.detail : '';
      console.log(r.kind === 'quota' ? '⏳ quota exhausted' : '✗ failed');
      console.log(`      ${detail}`);
      console.log('');
      console.log('  The baseline request failed, so nothing further can be diagnosed.');
      console.log('  Fix this first — it is a key, model-id or endpoint problem, not a');
      console.log('  request-shape problem. Check the model id with:  npm run ai:models');
      console.log('');
      process.exit(1);
    }

    if (r.kind === 'ok') {
      console.log('✓ ok');
    } else if (r.kind === 'quota') {
      console.log('⏳ quota exhausted');
      quotaDetail = r.detail;
      untested.push(rung);
    } else if (r.kind === 'network') {
      console.log(`✗ network: ${r.detail}`);
      untested.push(rung);
    } else {
      console.log(`✗ ${r.status}`);
      console.log(`      ${r.detail}`);
      console.log(`      → ${rung.meaning}`);
      rejected.push(rung);
    }

    if (delayMs > 0) await new Promise(res => setTimeout(res, delayMs));
  }

  console.log('');

  if (quotaDetail) {
    console.log('  ⏳ The provider ran out of free-tier quota partway through.');
    console.log(`     ${quotaDetail}`);
    console.log('');
    console.log(`     ${untested.length} rung(s) NOT tested — no conclusion can be drawn about them:`);
    for (const u of untested) console.log(`       · ${u.name}`);
    console.log('');
    console.log('     Re-run once the quota resets, or try a model with a larger free');
    console.log('     allowance:  npm run ai:probe -- --model gemini-2.5-flash');
    console.log('');
  }

  if (rejected.length > 0) {
    console.log(`  ${rejected.length} feature(s) genuinely rejected: ${rejected.map(f => f.name).join(', ')}\n`);
  } else if (!quotaDetail) {
    console.log('  Everything this provider is asked for is accepted.');
    console.log('  If the app still fails, the problem is in the conversation content rather');
    console.log('  than the request shape — capture the failing body and compare.\n');
  } else {
    console.log('  Nothing was rejected among the rungs that did run.\n');
  }
}

main();

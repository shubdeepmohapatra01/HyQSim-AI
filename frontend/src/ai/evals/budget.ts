/**
 * `npm run ai:budget` — measures what every prompt in the suite costs, without making a
 * single API call.
 *
 * The claim this exists to test: the old design made one API round-trip per gate, and
 * resent the entire conversation each time, so the cost of building a circuit grew
 * quadratically in its size. This script builds the exact request bodies both designs
 * would send and counts the tokens.
 *
 * Token counts come from cl100k_base (gpt-tokenizer). Anthropic and Llama tokenizers
 * differ by a few percent, which does not matter for a ratio.
 */

import { encode } from 'gpt-tokenizer';
import { buildSystemPrompt, toolsForIntent } from '../tools';
import { decodeCircuit, encodeCircuit } from '../hqc';
import { EVAL_CASES, type EvalCase } from './cases';
import {
  LEGACY_SYSTEM_PROMPT,
  LEGACY_TOOLS,
  legacyCircuitToPrompt,
  legacyBuildSequence,
} from './legacy';

type Tool = { name: string; description: string; input_schema: unknown };
type Msg = { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string };

const count = (s: string) => encode(s).length;

/** Tools are serialized into every request, so their schema cost is paid on every turn. */
function toolsTokens(tools: Tool[]): number {
  return count(JSON.stringify(tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))));
}

function messagesTokens(messages: Msg[]): number {
  return count(JSON.stringify(messages));
}

/**
 * Total input tokens across a whole conversation.
 *
 * Each tool call is one round-trip: the model replies with the call, we execute it, and
 * send everything back. Turn N therefore pays for the system prompt, the tool schemas,
 * the user message, and every preceding assistant/tool-result pair. One extra turn at the
 * end covers the model's final text reply.
 */
function conversationCost(
  systemPrompt: string,
  tools: Tool[],
  userMessage: string,
  toolCalls: { name: string; input: Record<string, unknown>; result: string }[],
): { roundTrips: number; inputTokens: number } {
  const fixed = count(systemPrompt) + toolsTokens(tools);
  const messages: Msg[] = [{ role: 'user', content: userMessage }];

  let inputTokens = 0;
  let roundTrips = 0;

  for (const tc of toolCalls) {
    inputTokens += fixed + messagesTokens(messages);
    roundTrips++;
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'x', type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } }],
    });
    messages.push({ role: 'tool', tool_call_id: 'x', content: tc.result });
  }

  // Final turn: the model's text confirmation.
  inputTokens += fixed + messagesTokens(messages);
  roundTrips++;

  return { roundTrips, inputTokens };
}

function pct(oldV: number, newV: number): string {
  if (oldV === 0) return '—';
  const change = ((newV - oldV) / oldV) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(0)}%`;
}

function pad(s: string, n: number, right = false): string {
  return right ? s.padStart(n) : s.padEnd(n);
}

function row(cells: [string, number, boolean?][]): string {
  return cells.map(([s, n, r]) => pad(s, n, r)).join('  ');
}

function buildCost(c: EvalCase) {
  const { wires, elements, errors } = decodeCircuit(c.reference!);
  if (errors.length > 0) {
    throw new Error(`Case "${c.id}" has an invalid reference circuit: ${errors.join('; ')}`);
  }

  // NEW: an empty canvas snapshot plus the prompt, answered with one build_circuit call.
  const wireSpec = c.reference!.match(/^\s*W\s+(.*)$/im)![1].trim();
  const gateSpecRaw = c.reference!.match(/^\s*G\s+([\s\S]*)$/im)?.[1].trim() ?? '';
  const gateSpec = gateSpecRaw === '(none)' ? '' : gateSpecRaw;

  const newUser = `[Canvas: ${c.setup ? c.setup : 'empty (no wires)'}]\n[Simulation: not run]\n\n${c.prompt}`;
  const newCost = conversationCost(buildSystemPrompt('build'), toolsForIntent('build'), newUser, [
    {
      name: 'build_circuit',
      input: { wires: wireSpec, gates: gateSpec },
      result: `Built: ${encodeCircuit(wires, elements)}`,
    },
  ]);

  // OLD: prose snapshot, and clear + one add_wire per wire + one add_gate per gate.
  const legacySetup = c.setup ? legacyCircuitToPrompt(...decodeToPair(c.setup)) : 'Circuit is empty (no wires or gates).';
  const oldUser = `[Canvas: ${legacySetup}]\n[Simulation: not yet run]\n\n${c.prompt}`;
  const oldCost = conversationCost(
    LEGACY_SYSTEM_PROMPT, LEGACY_TOOLS, oldUser, legacyBuildSequence(wires, elements),
  );

  return { newCost, oldCost };
}

function decodeToPair(hqc: string): [ReturnType<typeof decodeCircuit>['wires'], ReturnType<typeof decodeCircuit>['elements']] {
  const d = decodeCircuit(hqc);
  return [d.wires, d.elements];
}

function readonlyCost(c: EvalCase) {
  const [w, e] = decodeToPair(c.setup ?? 'W (none)');

  const newUser = `[Canvas: ${encodeCircuit(w, e)}]\n[Simulation: not run]\n\n${c.prompt}`;
  // Intent is explain/analyze: no tool call is forced, and the system prompt and tool list
  // are scoped down — the gate catalogue and mutating tools are useless here.
  const newCost = conversationCost(buildSystemPrompt(c.intent), toolsForIntent(c.intent), newUser, []);

  const oldUser = `[Canvas: ${legacyCircuitToPrompt(w, e)}]\n[Simulation: not yet run]\n\n${c.prompt}`;
  // The old design forced a tool call on turn 0, so even "explain this" cost an extra
  // read_circuit round-trip before the model could answer.
  const oldCost = conversationCost(LEGACY_SYSTEM_PROMPT, LEGACY_TOOLS, oldUser, [
    { name: 'read_circuit', input: {}, result: legacyCircuitToPrompt(w, e) },
  ]);

  return { newCost, oldCost };
}

function main() {
  console.log('\nHyQSim AI — token budget report');
  console.log('Tokenizer: cl100k_base. No API calls were made.\n');

  console.log('Fixed per-request overhead (paid on every single round-trip).');
  console.log('The new prompt and tool list are scoped to the intent, so read-only requests');
  console.log('carry neither the gate catalogue nor the tools they are forbidden to call.\n');
  for (const intent of ['build', 'explain'] as const) {
    const sys = count(buildSystemPrompt(intent));
    const tls = toolsTokens(toolsForIntent(intent));
    console.log(
      `  ${pad(intent === 'build' ? 'build' : 'explain/analyze', 16)}` +
      `system ${pad(String(sys), 5, true)}  tools ${pad(String(tls), 5, true)}  ` +
      `total ${pad(String(sys + tls), 5, true)}   ` +
      `vs old ${count(LEGACY_SYSTEM_PROMPT) + toolsTokens(LEGACY_TOOLS)}  ` +
      `${pct(count(LEGACY_SYSTEM_PROMPT) + toolsTokens(LEGACY_TOOLS), sys + tls)}`,
    );
  }
  console.log('');

  const header = row([['case', 24], ['trips old', 10, true], ['trips new', 10, true], ['tok old', 9, true], ['tok new', 9, true], ['change', 8, true]]);
  console.log(header);
  console.log('-'.repeat(header.length));

  let totalOld = 0, totalNew = 0, tripsOld = 0, tripsNew = 0;

  for (const c of EVAL_CASES) {
    const { newCost, oldCost } = c.reference ? buildCost(c) : readonlyCost(c);
    totalOld += oldCost.inputTokens;
    totalNew += newCost.inputTokens;
    tripsOld += oldCost.roundTrips;
    tripsNew += newCost.roundTrips;

    console.log(row([
      [c.id, 24],
      [String(oldCost.roundTrips), 10, true],
      [String(newCost.roundTrips), 10, true],
      [String(oldCost.inputTokens), 9, true],
      [String(newCost.inputTokens), 9, true],
      [pct(oldCost.inputTokens, newCost.inputTokens), 8, true],
    ]));
  }

  console.log('-'.repeat(header.length));
  console.log(row([
    ['TOTAL', 24],
    [String(tripsOld), 10, true],
    [String(tripsNew), 10, true],
    [String(totalOld), 9, true],
    [String(totalNew), 9, true],
    [pct(totalOld, totalNew), 8, true],
  ]));

  // Snapshot size is what a long conversation pays repeatedly, so report it separately.
  console.log('\nCanvas snapshot size (repeated on every message):');
  for (const [name, hqc] of [
    ['bell', 'W q0 q1\nG h q0; cnot q0>q1'],
    ['ghz-4', 'W q0 q1 q2 q3\nG h q0; cnot q0>q1; cnot q1>q2; cnot q2>q3'],
    ['cat', 'W q0 m0\nG h q0; cdisp q0>m0 2,0'],
  ] as const) {
    const [w, e] = decodeToPair(hqc);
    const o = count(legacyCircuitToPrompt(w, e));
    const n = count(encodeCircuit(w, e));
    console.log(`  ${pad(name, 10)} old ${pad(String(o), 4, true)}   new ${pad(String(n), 4, true)}   ${pct(o, n)}`);
  }

  console.log('\nMulti-turn growth (same question asked N times, ghz-4 on canvas):');
  const [w, e] = decodeToPair('W q0 q1 q2 q3\nG h q0; cnot q0>q1; cnot q1>q2; cnot q2>q3');
  const question = 'What does this circuit do?';
  for (const turns of [1, 3, 5, 10]) {
    // Old: every past user message keeps its own full snapshot forever.
    const oldMsgs: Msg[] = [];
    for (let i = 0; i < turns; i++) {
      oldMsgs.push({ role: 'user', content: `[Canvas: ${legacyCircuitToPrompt(w, e)}]\n[Simulation: not yet run]\n\n${question}` });
      oldMsgs.push({ role: 'assistant', content: 'It prepares a GHZ state.' });
    }
    // New: pruneHistory strips the snapshot from everything but the newest message.
    const newMsgs: Msg[] = [];
    for (let i = 0; i < turns; i++) {
      const isLast = i === turns - 1;
      const snap = isLast
        ? `[Canvas: ${encodeCircuit(w, e)}]\n[Simulation: not run]`
        : '[Canvas: superseded — see latest message]';
      newMsgs.push({ role: 'user', content: `${snap}\n\n${question}` });
      newMsgs.push({ role: 'assistant', content: 'It prepares a GHZ state.' });
    }
    const o = count(LEGACY_SYSTEM_PROMPT) + toolsTokens(LEGACY_TOOLS) + messagesTokens(oldMsgs);
    const n = count(buildSystemPrompt('explain')) + toolsTokens(toolsForIntent('explain')) + messagesTokens(newMsgs);
    console.log(`  turn ${pad(String(turns), 3, true)}   old ${pad(String(o), 6, true)}   new ${pad(String(n), 6, true)}   ${pct(o, n)}`);
  }

  console.log('');
}

main();

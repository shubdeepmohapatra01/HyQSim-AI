/**
 * `npm run ai:live` — runs the prompt suite against a real provider and writes a report.
 *
 * This is the only runner that spends tokens, so it is opt-in and never part of a normal
 * build. It drives the same agent loop the chat panel uses, against a headless stand-in
 * for the canvas, and executes run_simulation through HyQSim's real browser simulator —
 * so the numbers in the report are the simulator's, not the model's.
 *
 * Usage:
 *   GROQ_API_KEY=gsk_...  npm run ai:live
 *   ANTHROPIC_API_KEY=... npm run ai:live -- --model claude-haiku-4-5-20251001
 *   npm run ai:live -- --model llama-3.3-70b-versatile --case ghz-4 --delay 8000
 *
 * Compare models on the same suite (needs a key for each provider):
 *   GROQ_API_KEY=... GOOGLE_API_KEY=... \
 *     npm run ai:live -- --compare llama-3.3-70b-versatile,gemini-2.0-flash
 */

import { writeFileSync } from 'node:fs';
import { encode } from 'gpt-tokenizer';
import type { Wire, CircuitElement, SimulationResult, Gate } from '../../types/circuit';
import { ALL_GATES } from '../../types/circuit';
import { runSimulation } from '../../simulation/simulator';
import { runAgentTurn, type HistoryEntry, type StreamEvent } from '../client';
import { MODEL_OPTIONS } from '../providers';
import { parseToolCall, MUTATING_TOOLS } from '../tools';
import { circuitToPrompt, simulationResultToPrompt } from '../circuitToPrompt';
import { decodeCircuit, encodeCircuit } from '../hqc';
import { classifyIntent, shouldForceTools, shouldAutoRunSimulation } from '../intent';
import { checkCircuit, withSanityNotes } from '../sanity';
import { EVAL_CASES, type EvalCase } from './cases';

const GATES_MAP: Map<string, Gate> = new Map(ALL_GATES.map(g => [g.id, g]));
const FOCK = 8;

// ─── CLI ──────────────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const compareList = arg('compare');
const modelIds = compareList
  ? compareList.split(',').map(s => s.trim()).filter(Boolean)
  : [arg('model', 'llama-3.3-70b-versatile')!];
const caseFilter = arg('case');
const delayMs = Number(arg('delay', '3000'));
const outPath = arg('out', compareList ? 'ai-eval-comparison.md' : 'ai-eval-report.md')!;

for (const id of modelIds) {
  if (!MODEL_OPTIONS.some(m => m.id === id)) {
    console.error(`Unknown model "${id}". Available:\n${MODEL_OPTIONS.map(m => `  ${m.id}`).join('\n')}`);
    process.exit(1);
  }
}

const KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  google: 'GOOGLE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  together: 'TOGETHER_API_KEY',
};

function resolveKey(id: string): { key: string; envVar: string } {
  // providerForModel lives in providers.ts, but re-deriving here keeps this script
  // runnable without pulling the whole module graph into scope.
  let provider = 'openai';
  if (id.startsWith('claude-')) provider = 'anthropic';
  else if (id.startsWith('llama-') || id.startsWith('mixtral-') || id.startsWith('gemma-')) provider = 'groq';
  else if (id.startsWith('gemini-')) provider = 'google';
  else if (id.startsWith('mistral-') || id.startsWith('codestral-')) provider = 'mistral';
  else if (id.startsWith('meta-llama/')) provider = 'together';
  const envVar = KEY_ENV[provider];
  return { key: process.env[envVar] ?? '', envVar };
}

// Fail before spending anything if a key is missing for any model in the run.
for (const id of modelIds) {
  const { key, envVar } = resolveKey(id);
  if (!key) {
    console.error(`No API key for "${id}". Set ${envVar} in your environment.`);
    process.exit(1);
  }
}

// ─── Headless canvas ──────────────────────────────────────────────────────────

/**
 * Stands in for App.tsx state. Applies the same mutations the chat panel does, so a
 * discrepancy here is a real discrepancy in the tool layer.
 */
class Canvas {
  wires: Wire[] = [];
  elements: CircuitElement[] = [];
  result: SimulationResult | null = null;
  simulationRuns = 0;
  /** Benchmarks carry their own truncation — the cat state is meaningless at 8. */
  fock = FOCK;

  constructor(setup?: string) {
    if (setup) {
      const d = decodeCircuit(setup);
      if (d.errors.length > 0) throw new Error(`Bad setup circuit: ${d.errors.join('; ')}`);
      this.wires = d.wires;
      this.elements = d.elements;
    }
  }

  /** Runs HyQSim's real simulator. The model never computes results. */
  run(): string {
    if (this.wires.length === 0) return 'Nothing to simulate — the circuit is empty.';
    try {
      const measured = this.elements.filter(e => e.gateId === 'measure').map(e => e.wireIndex);
      this.result = runSimulation(this.wires, this.elements, GATES_MAP, this.fock, [], 1024, measured);
      this.simulationRuns++;
      return simulationResultToPrompt(this.result, this.wires, this.fock);
    } catch (e) {
      return `Simulator error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  snapshot(): string {
    const canvas = `[Canvas: ${circuitToPrompt(this.wires, this.elements)}]`;
    const sim = this.result
      ? `[Simulation: ${simulationResultToPrompt(this.result, this.wires, this.fock)}]`
      : '[Simulation: not run]';
    return `${canvas}\n${sim}`;
  }

  hqc(): string {
    return this.wires.length === 0 ? '(empty)' : encodeCircuit(this.wires, this.elements);
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

interface CaseResult {
  case: EvalCase;
  intent: string;
  toolCalls: { name: string; input: unknown; result: string }[];
  finalText: string;
  circuitBefore: string;
  circuitAfter: string;
  simulationRuns: number;
  rateLimited: number;
  usedBenchmark: string | null;
  inputTokensEstimate: number;
  failures: string[];
  errored: string | null;
}

async function runCase(c: EvalCase, modelId: string): Promise<CaseResult> {
  const canvas = new Canvas(c.setup);
  const circuitBefore = canvas.hqc();
  const intent = classifyIntent(c.prompt);

  const toolCalls: CaseResult['toolCalls'] = [];
  const failures: string[] = [];
  let usedBenchmark: string | null = null;
  let finalText = '';
  let rateLimited = 0;
  let errored: string | null = null;

  if (shouldAutoRunSimulation(intent, canvas.result !== null, canvas.wires.length > 0)) {
    canvas.run();
  }

  const handleToolCall = async (name: string, input: Record<string, unknown>): Promise<string> => {
    if (MUTATING_TOOLS.has(name) && intent !== 'build') {
      const msg = `Refused: this is a ${intent} request, not a build request.`;
      toolCalls.push({ name, input, result: msg });
      return msg;
    }

    const r = parseToolCall(name, input, canvas.wires, canvas.elements);
    let result: string;

    if (r.mutation === null) {
      result = `Error: ${r.error}`;
    } else {
      switch (r.mutation.type) {
        case 'load_benchmark':
          canvas.wires = r.mutation.wires;
          canvas.elements = r.mutation.elements;
          canvas.fock = r.mutation.fockTruncation;
          canvas.result = null;
          usedBenchmark = r.mutation.benchmarkId;
          result = `Loaded HyQSim's verified "${r.mutation.benchmarkId}" circuit (Fock ${r.mutation.fockTruncation}): ${circuitToPrompt(canvas.wires, canvas.elements)}`;
          break;
        case 'build_circuit':
          canvas.wires = r.mutation.wires;
          canvas.elements = r.mutation.elements;
          canvas.result = null;
          result = withSanityNotes(
            `Built: ${circuitToPrompt(canvas.wires, canvas.elements)}`,
            checkCircuit(canvas.wires, canvas.elements, c.prompt),
          );
          break;
        case 'add_gate':
          canvas.elements = [...canvas.elements, r.mutation.element];
          canvas.result = null;
          result = withSanityNotes(
            `Added gate #${canvas.elements.length}. Circuit: ${circuitToPrompt(canvas.wires, canvas.elements)}`,
            checkCircuit(canvas.wires, canvas.elements, c.prompt),
          );
          break;
        case 'remove_gate': {
          const id = r.mutation.elementId;
          canvas.elements = canvas.elements.filter(e => e.id !== id);
          canvas.result = null;
          result = `Removed gate ${r.mutation.ref}. Circuit: ${circuitToPrompt(canvas.wires, canvas.elements)}`;
          break;
        }
        case 'add_wire': {
          const wt = r.mutation.wireType;
          const index = canvas.wires.filter(w => w.type === wt).length;
          canvas.wires = [...canvas.wires, { id: `${wt}-${index}`, type: wt, index }];
          canvas.result = null;
          result = `Added ${wt} ${wt === 'qubit' ? 'q' : 'm'}${index}.`;
          break;
        }
        case 'clear_circuit':
          canvas.wires = [];
          canvas.elements = [];
          canvas.result = null;
          result = 'Circuit cleared.';
          break;
        case 'read_circuit':
          result = circuitToPrompt(canvas.wires, canvas.elements);
          break;
        case 'run_simulation':
          result = canvas.run();
          break;
      }
    }

    toolCalls.push({ name, input, result: result! });
    return result!;
  };

  const onEvent = (e: StreamEvent) => {
    if (e.type === 'text') finalText += e.text;
    else if (e.type === 'rate_limited') rateLimited++;
    else if (e.type === 'error') errored = e.message;
  };

  const firstMessage = `${canvas.snapshot()}\n\n${c.prompt}`;
  const model = MODEL_OPTIONS.find(m => m.id === modelId)!;
  const { key: apiKey } = resolveKey(modelId);
  const history: HistoryEntry[] = [{ kind: 'user', text: firstMessage }];
  const inputTokensEstimate = encode(firstMessage).length;

  try {
    await runAgentTurn(
      apiKey, modelId, model.baseUrl, model.apiFormat,
      history, onEvent, handleToolCall, false, shouldForceTools(intent), intent,
    );
  } catch (e) {
    errored = e instanceof Error ? e.message : String(e);
  }

  // ── Assertions ──
  if (intent !== classifyIntent(c.prompt)) failures.push('intent drifted mid-run');
  if (c.intent !== intent) failures.push(`intent: expected ${c.intent}, got ${intent}`);

  if (c.expectNoMutation) {
    if (canvas.hqc() !== circuitBefore) failures.push('canvas was modified on a read-only request');
    if (toolCalls.some(t => MUTATING_TOOLS.has(t.name))) {
      failures.push(`attempted mutating tools: ${toolCalls.filter(t => MUTATING_TOOLS.has(t.name)).map(t => t.name).join(', ')}`);
    }
  }

  if (c.expectBenchmark && usedBenchmark !== c.expectBenchmark) {
    failures.push(`improvised instead of calling load_benchmark("${c.expectBenchmark}")`);
  }

  if (c.expectVacuumQumodes) {
    for (const w of canvas.wires) {
      if (w.type === 'qumode' && typeof w.initialState === 'number' && w.initialState > 0) {
        failures.push(`qumode initialised to Fock |${w.initialState}> — alpha read as an initial state`);
      }
    }
  }

  if (c.expect) {
    const qubits = canvas.wires.filter(w => w.type === 'qubit').length;
    const qumodes = canvas.wires.filter(w => w.type === 'qumode').length;
    if (qubits !== c.expect.qubits) failures.push(`qubits: expected ${c.expect.qubits}, got ${qubits}`);
    if (qumodes !== c.expect.qumodes) failures.push(`qumodes: expected ${c.expect.qumodes}, got ${qumodes}`);
    const counts: Record<string, number> = {};
    for (const e of canvas.elements) counts[e.gateId] = (counts[e.gateId] ?? 0) + 1;
    for (const [g, n] of Object.entries(c.expect.gates)) {
      if ((counts[g] ?? 0) !== n) failures.push(`${g}: expected ${n}, got ${counts[g] ?? 0}`);
    }
  }

  if (c.expectMentions) {
    const lower = finalText.toLowerCase();
    for (const m of c.expectMentions) {
      if (!lower.includes(m.toLowerCase())) failures.push(`response never mentions "${m}"`);
    }
  }

  if (errored) failures.push(`API error: ${errored}`);

  return {
    case: c, intent, toolCalls, finalText,
    circuitBefore, circuitAfter: canvas.hqc(),
    simulationRuns: canvas.simulationRuns,
    rateLimited, usedBenchmark, inputTokensEstimate, failures, errored,
  };
}

function renderReport(results: CaseResult[], modelId: string): string {
  const passed = results.filter(r => r.failures.length === 0).length;
  const totalTrips = results.reduce((a, r) => a + r.toolCalls.length + 1, 0);

  const lines: string[] = [
    '# HyQSim AI — live evaluation report',
    '',
    `- Model: \`${modelId}\``,
    `- Run: ${new Date().toISOString()}`,
    `- Result: **${passed}/${results.length} passed**`,
    `- API round-trips: ${totalTrips}`,
    `- Rate-limit retries: ${results.reduce((a, r) => a + r.rateLimited, 0)}`,
    '',
    'Simulation numbers in this report come from HyQSim\'s own simulator, never from the model.',
    '',
    '## Summary',
    '',
    '| case | intent | tools | sims | status |',
    '|---|---|---|---|---|',
    ...results.map(r =>
      `| ${r.case.id} | ${r.intent} | ${r.toolCalls.length} | ${r.simulationRuns} | ${r.failures.length === 0 ? '✅ pass' : `❌ ${r.failures.length}`} |`,
    ),
    '',
    '## Cases',
    '',
  ];

  for (const r of results) {
    lines.push(`### ${r.case.id} ${r.failures.length === 0 ? '✅' : '❌'}`);
    lines.push('');
    lines.push(`**Prompt:** ${r.case.prompt}`);
    lines.push('');
    lines.push(`**Intent:** \`${r.intent}\`  ·  **Prompt tokens:** ~${r.inputTokensEstimate}`);
    lines.push('');
    if (r.case.notes) {
      lines.push(`> ${r.case.notes}`);
      lines.push('');
    }
    if (r.circuitBefore !== '(empty)') {
      lines.push('**Canvas before:**');
      lines.push('```');
      lines.push(r.circuitBefore);
      lines.push('```');
    }
    lines.push('**Tool calls:**');
    lines.push('');
    if (r.toolCalls.length === 0) {
      lines.push('_none — answered directly from the snapshot._');
    } else {
      lines.push('```');
      for (const t of r.toolCalls) {
        lines.push(`${t.name}(${JSON.stringify(t.input)})`);
        lines.push(`  → ${t.result.split('\n')[0].slice(0, 160)}`);
      }
      lines.push('```');
    }
    lines.push('');
    lines.push('**Canvas after:**');
    lines.push('```');
    lines.push(r.circuitAfter);
    lines.push('```');
    lines.push('**Response:**');
    lines.push('');
    lines.push(r.finalText.trim() || '_(no text response)_');
    lines.push('');
    if (r.failures.length > 0) {
      lines.push('**Failures:**');
      lines.push('');
      for (const f of r.failures) lines.push(`- ${f}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const cases = caseFilter ? EVAL_CASES.filter(c => c.id === caseFilter) : EVAL_CASES;
  if (cases.length === 0) {
    console.error(`No case matching "${caseFilter}".`);
    process.exit(1);
  }

  const byModel = new Map<string, CaseResult[]>();

  for (const modelId of modelIds) {
    console.log(`\nRunning ${cases.length} case(s) against ${modelId}\n`);
    const results: CaseResult[] = [];

    for (const c of cases) {
      process.stdout.write(`  ${c.id.padEnd(24)}`);
      const r = await runCase(c, modelId);
      results.push(r);
      console.log(
        r.failures.length === 0
          ? `✅  ${r.toolCalls.length} tool call(s)`
          : `❌  ${r.failures[0]}`,
      );
      // Free tiers meter by tokens per minute; pacing keeps the suite from tripping them.
      if (delayMs > 0 && !(c === cases[cases.length - 1] && modelId === modelIds[modelIds.length - 1])) {
        await new Promise(res => setTimeout(res, delayMs));
      }
    }

    byModel.set(modelId, results);
    const passed = results.filter(r => r.failures.length === 0).length;
    console.log(`\n  ${modelId}: ${passed}/${results.length} passed`);
  }

  const report = modelIds.length > 1
    ? renderComparison(byModel)
    : renderReport(byModel.get(modelIds[0])!, modelIds[0]);
  writeFileSync(outPath, report);

  const allPassed = [...byModel.values()].every(rs => rs.every(r => r.failures.length === 0));
  console.log(`\nReport written to ${outPath}`);
  process.exit(allPassed ? 0 : 1);
}

/**
 * Side-by-side view when several models run the same suite.
 *
 * The point is not which model wins overall but *where* they differ: weaker models fail
 * predictably on instruction-following (ignoring load_benchmark) and tool-call formatting,
 * not on random cases.
 */
function renderComparison(byModel: Map<string, CaseResult[]>): string {
  const models = [...byModel.keys()];
  const cases = byModel.get(models[0])!.map(r => r.case.id);

  const lines: string[] = [
    '# HyQSim AI — model comparison',
    '',
    `- Run: ${new Date().toISOString()}`,
    `- Models: ${models.map(m => `\`${m}\``).join(', ')}`,
    `- Cases: ${cases.length}`,
    '',
    "Simulation numbers come from HyQSim's own simulator, never from the model.",
    '',
    '## Scoreboard',
    '',
    `| metric | ${models.join(' | ')} |`,
    `|---|${models.map(() => '---').join('|')}|`,
  ];

  const metric = (label: string, fn: (rs: CaseResult[]) => string | number) =>
    lines.push(`| ${label} | ${models.map(m => fn(byModel.get(m)!)).join(' | ')} |`);

  metric('passed', rs => `${rs.filter(r => r.failures.length === 0).length}/${rs.length}`);
  metric('tool calls', rs => rs.reduce((a, r) => a + r.toolCalls.length, 0));
  metric('refused mutations', rs =>
    rs.reduce((a, r) => a + r.toolCalls.filter(t => t.result.startsWith('Refused')).length, 0));
  metric('tool errors', rs =>
    rs.reduce((a, r) => a + r.toolCalls.filter(t => t.result.startsWith('Error')).length, 0));
  metric('improvised over benchmark', rs =>
    rs.filter(r => r.failures.some(f => f.includes('improvised'))).length);
  metric('rate-limit retries', rs => rs.reduce((a, r) => a + r.rateLimited, 0));
  metric('API errors', rs => rs.filter(r => r.errored).length);

  lines.push('', '## Per case', '', `| case | intent | ${models.join(' | ')} |`,
    `|---|---|${models.map(() => '---').join('|')}|`);

  for (const id of cases) {
    const cells = models.map(m => {
      const r = byModel.get(m)!.find(x => x.case.id === id)!;
      return r.failures.length === 0 ? `✅ ${r.toolCalls.length}t` : `❌ ${r.failures[0].slice(0, 44)}`;
    });
    const intent = byModel.get(models[0])!.find(x => x.case.id === id)!.intent;
    lines.push(`| ${id} | ${intent} | ${cells.join(' | ')} |`);
  }

  lines.push('', '_Cell format: ✅ followed by tool-call count, or ❌ with the first failure._', '');

  // Full transcripts per model, so a disagreement can be read rather than guessed at.
  for (const m of models) {
    lines.push('', '---', '', `# ${m}`, '', renderReport(byModel.get(m)!, m)
      .split('\n').slice(1).join('\n'));
  }

  return lines.join('\n');
}

main();

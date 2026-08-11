import type { Wire, CircuitElement } from '../types/circuit';
import { buildBenchmark, encodeBenchmarkReference } from './benchmarks';
import {
  placeGate,
  decodeWires,
  decodeGates,
  resolveElementRef,
  encodeGateReference,
  availableWireLabels,
} from './hqc';

/**
 * The system prompt is sent on every single request, so every line here is paid for many
 * times over.
 *
 * It is assembled per intent rather than being one fixed block. An explain or analyze
 * request cannot modify the circuit — ChatPanel refuses mutating tools outright for those
 * intents — so shipping the gate catalogue, the benchmark list and the build rules on
 * those requests is pure waste. They are the most common requests, so this matters.
 */

const HEADER =
  'You are the circuit assistant for HyQSim, a hybrid CV-DV (continuous-variable / discrete-variable) quantum circuit simulator.';

/** Always needed: without it the model cannot read the [Canvas:] snapshot. */
const NOTATION = `## Notation (HQC)
q0 q1 ... = qubits, m0 m1 ... = qumodes.
Gates: "<id> <wire>[><target>] [params]", joined by ";". Params are positional in the gate's
declared order, comma-separated, omitted for defaults. Radians; pi, pi/2, 3pi/4 accepted.
Example: "h q0; cnot q0>q1; displace m0 1,0; cdisp q0>m0 2,0"
Gates on the canvas are numbered #1, #2 ... left to right. Refer to them by that number.`;

/** Build-only: an intent that cannot place a gate has no use for any of this. */
const BUILD_RULES = `Initial states are optional and rarely wanted ("q0=+" = |+>, "m0=3" = Fock |3>). Qumodes
start in VACUUM unless the user asks for a Fock/number state. A coherent amplitude like
"alpha=2" is a GATE PARAMETER, never an initial state — writing "m0=2" for it is wrong.

## Rules
1. If "Known circuits" covers the request, call load_benchmark. Do NOT rebuild those from
   memory — their exact gate sequences are longer than you expect and you will get them wrong.
2. Otherwise call build_circuit ONCE with the whole circuit. Never add gates one at a time.
3. To EDIT, use add_gate / remove_gate / add_wire. Do not rebuild.
4. NEVER state a number absent from [Simulation:]. You do not compute physics; HyQSim does.
5. A "CHECK:" line in a tool result means the circuit is likely wrong. Fix it before replying.
6. Tool calls go through the tool interface only, never as text or XML.

## Known circuits (load_benchmark, do not rebuild)
${encodeBenchmarkReference()}

## Gates
Lane signature in brackets. "!py" = browser backend only, not bosonic-qiskit.
${encodeGateReference()}
Order: cnot control>target; bs qumode>qumode; cdisp/xcdisp/ycdisp/cr/jc ALWAYS qubit>qumode.`;

/** Read-only: the rules that still apply when the model may not touch the canvas. */
const READONLY_RULES = `## Rules
1. [Canvas:] and [Simulation:] at the top of the message are current truth, whatever earlier
   turns said. Answer from them — do not call read_circuit.
2. This is a read-only request. Do NOT modify the circuit; those tools will be refused.
3. NEVER state a number absent from [Simulation:]. You do not compute physics; HyQSim does.
   If you need numbers and have none, call run_simulation.`;

const EXPLAINING = `## Explaining
Name the state (cat, GHZ, squeezed vacuum...) rather than listing gates. Use the data as
evidence: Fock shape, <n>, Bloch vector, Wigner summary (neg = negativity volume, lobes,
fringes, varX/varP against vacuum 1.00). Say why the circuit produces it. One physicist to
another: precise, intuitive, not pedantic. Under 200 words unless asked for more.`;

export type PromptIntent = 'build' | 'explain' | 'analyze';

export function buildSystemPrompt(intent: PromptIntent): string {
  const parts = intent === 'build'
    ? [HEADER, NOTATION, BUILD_RULES, EXPLAINING]
    : [HEADER, NOTATION, READONLY_RULES, EXPLAINING];
  return parts.join('\n\n');
}

/** Kept for callers that want the full prompt (the budget harness, docs). */
export const SYSTEM_PROMPT = buildSystemPrompt('build');

export const AI_TOOLS = [
  {
    name: 'load_benchmark',
    description:
      "Load one of HyQSim's verified circuits. Prefer over build_circuit whenever it applies.",
    input_schema: {
      type: 'object' as const,
      properties: {
        benchmarkId: { type: 'string', description: '"cat-state", "cv-to-dv", "dv-to-cv"' },
        parameters: { type: 'object', additionalProperties: { type: 'number' } },
      },
      required: ['benchmarkId'],
    },
  },
  {
    name: 'build_circuit',
    description: 'Create or replace the whole circuit in one call. Use for any "build a X" request that load_benchmark does not cover.',
    input_schema: {
      type: 'object' as const,
      properties: {
        wires: { type: 'string', description: 'e.g. "q0 q1 q2" or "q0=+ m0=2"' },
        gates: { type: 'string', description: 'e.g. "h q0; cnot q0>q1; displace m0 1.5,0". "" for none.' },
        replace: { type: 'boolean', description: 'Default true. False extends the current circuit.' },
      },
      required: ['wires', 'gates'],
    },
  },
  {
    name: 'add_gate',
    description: 'Append one gate. Edits only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        gateId: { type: 'string' },
        wireLabel: { type: 'string', description: 'Primary wire; the qubit for hybrid gates.' },
        targetWireLabel: { type: 'string', description: 'Second wire; the qumode for hybrid gates.' },
        parameters: { type: 'object', additionalProperties: { type: 'number' } },
      },
      required: ['gateId', 'wireLabel'],
    },
  },
  {
    name: 'remove_gate',
    description: 'Delete one gate.',
    input_schema: {
      type: 'object' as const,
      properties: { ref: { type: 'string', description: 'Its canvas number, e.g. "#3".' } },
      required: ['ref'],
    },
  },
  {
    name: 'add_wire',
    description: 'Append one wire.',
    input_schema: {
      type: 'object' as const,
      properties: { wireType: { type: 'string', enum: ['qubit', 'qumode'] } },
      required: ['wireType'],
    },
  },
  {
    name: 'clear_circuit',
    description: 'Delete everything.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'read_circuit',
    description: 'Re-read the canvas. Rarely needed; the snapshot is already current.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'run_simulation',
    description: "Run HyQSim's simulator and return its results. Never compute results yourself.",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
];

/** Tool names that change the canvas — used to reject mutations during explain/analyze. */
export const MUTATING_TOOLS = new Set(['build_circuit', 'load_benchmark', 'add_gate', 'remove_gate', 'add_wire', 'clear_circuit']);

/**
 * The tools to advertise for an intent.
 *
 * Tool schemas are re-serialized into every request, so offering tools that would be
 * refused anyway is paid for on every turn. For read-only intents the mutating tools are
 * dropped entirely — which also removes the temptation to call them, so the guard fires
 * less often.
 */
export function toolsForIntent(intent: PromptIntent): typeof AI_TOOLS {
  if (intent === 'build') return AI_TOOLS;
  return AI_TOOLS.filter(t => !MUTATING_TOOLS.has(t.name));
}

export type CircuitMutation =
  | { type: 'build_circuit'; wires: Wire[]; elements: CircuitElement[]; replace: boolean }
  | { type: 'load_benchmark'; benchmarkId: string; wires: Wire[]; elements: CircuitElement[]; fockTruncation: number }
  | { type: 'add_gate'; element: CircuitElement }
  | { type: 'remove_gate'; elementId: string; ref: string }
  | { type: 'add_wire'; wireType: 'qubit' | 'qumode' }
  | { type: 'clear_circuit' }
  | { type: 'read_circuit' }
  | { type: 'run_simulation' };

type ParseResult =
  | { mutation: CircuitMutation; error: null }
  | { mutation: null; error: string };

/** Reads a value under any of several spellings — models are inconsistent about casing. */
function pick(input: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (input[k] !== undefined && input[k] !== null) return input[k];
  }
  return undefined;
}

/**
 * Validates a tool call against the current circuit and produces a mutation.
 *
 * Error strings are self-correcting prompts: they name the valid options so the model can
 * fix its own mistake on the next turn without a human intervening.
 */
export function parseToolCall(
  name: string,
  input: Record<string, unknown>,
  wires: Wire[],
  elements: CircuitElement[],
): ParseResult {
  switch (name) {
    case 'read_circuit':
      return { mutation: { type: 'read_circuit' }, error: null };

    case 'run_simulation':
      return { mutation: { type: 'run_simulation' }, error: null };

    case 'clear_circuit':
      return { mutation: { type: 'clear_circuit' }, error: null };

    case 'load_benchmark': {
      const id = String(pick(input, 'benchmarkId', 'benchmark_id', 'benchmark', 'id') ?? '').trim();
      const raw = pick(input, 'parameters', 'params') as Record<string, unknown> | undefined;

      const params: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw ?? {})) {
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isNaN(n)) {
          return { mutation: null, error: `Benchmark parameter "${k}" must be a number, got "${String(v)}".` };
        }
        params[k] = n;
      }

      const result = buildBenchmark(id, Object.keys(params).length > 0 ? params : undefined);
      if (result.circuit === null) return { mutation: null, error: result.error as string };

      return {
        mutation: {
          type: 'load_benchmark',
          benchmarkId: id,
          wires: result.circuit.wires,
          elements: result.circuit.elements,
          fockTruncation: result.circuit.fockTruncation,
        },
        error: null,
      };
    }

    case 'build_circuit': {
      const wireSpec = String(pick(input, 'wires', 'wire', 'wireSpec', 'wire_spec') ?? '');
      const gateSpec = String(pick(input, 'gates', 'gate', 'gateSpec', 'gate_spec', 'circuit') ?? '');
      const replaceRaw = pick(input, 'replace', 'clear');
      const replace = replaceRaw === undefined ? true : replaceRaw !== false && replaceRaw !== 'false';

      if (wireSpec.trim() === '') {
        return { mutation: null, error: 'build_circuit needs a "wires" spec, e.g. "q0 q1" or "q0 m0".' };
      }

      const { wires: newWires, errors: wireErrors } = decodeWires(wireSpec);
      if (wireErrors.length > 0) {
        return { mutation: null, error: wireErrors.join(' ') };
      }
      if (newWires.length === 0) {
        return { mutation: null, error: `Could not read any wires from "${wireSpec}". Use labels like "q0 q1 m0".` };
      }

      // When extending rather than replacing, new gates must resolve against the union.
      const baseWires = replace ? newWires : [...wires, ...newWires];
      const baseElements = replace ? [] : elements;

      const { elements: newElements, errors: gateErrors } = decodeGates(gateSpec, baseWires, baseElements);
      if (gateErrors.length > 0) {
        return { mutation: null, error: gateErrors.join(' ') };
      }

      return {
        mutation: {
          type: 'build_circuit',
          wires: baseWires,
          elements: replace ? newElements : [...baseElements, ...newElements],
          replace,
        },
        error: null,
      };
    }

    case 'add_wire': {
      const wt = String(pick(input, 'wireType', 'type', 'wire_type') ?? '').toLowerCase();
      if (wt !== 'qubit' && wt !== 'qumode') {
        return { mutation: null, error: `Invalid wire type "${wt}". Must be "qubit" or "qumode".` };
      }
      return { mutation: { type: 'add_wire', wireType: wt }, error: null };
    }

    case 'remove_gate': {
      const ref = String(pick(input, 'ref', 'elementId', 'element_id', 'index', 'gate') ?? '');
      if (elements.length === 0) {
        return { mutation: null, error: 'There are no gates on the canvas to remove.' };
      }
      const id = resolveElementRef(ref, elements);
      if (!id) {
        return { mutation: null, error: `No gate "${ref}". The canvas has gates #1 to #${elements.length}.` };
      }
      return { mutation: { type: 'remove_gate', elementId: id, ref }, error: null };
    }

    case 'add_gate': {
      if (wires.length === 0) {
        return { mutation: null, error: 'The circuit has no wires yet. Call build_circuit, or add_wire first.' };
      }
      const gateId = String(pick(input, 'gateId', 'gate_id', 'gate_type', 'gate', 'id') ?? '');
      const wl = String(pick(input, 'wireLabel', 'wire_label', 'wire', 'target') ?? '');
      const tlRaw = pick(input, 'targetWireLabel', 'target_wire_label', 'targetWire', 'target_wire');
      const params = pick(input, 'parameters', 'params', 'parameterValues');

      if (wl === '') {
        return { mutation: null, error: `add_gate needs a wireLabel. Current wires: ${availableWireLabels(wires)}` };
      }

      const result = placeGate(
        {
          gateId,
          wireLabel: wl,
          targetWireLabel: tlRaw === undefined ? undefined : String(tlRaw),
          parameters: params,
        },
        wires,
        elements,
      );
      if (result.element === null) return { mutation: null, error: result.error };
      return { mutation: { type: 'add_gate', element: result.element }, error: null };
    }

    default:
      return { mutation: null, error: `Unknown tool "${name}". Available: ${AI_TOOLS.map(t => t.name).join(', ')}` };
  }
}

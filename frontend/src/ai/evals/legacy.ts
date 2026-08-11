/**
 * Faithful reproduction of the PRE-OPTIMISATION prompt format, kept only so `ai:budget`
 * can report an honest before/after rather than an asserted one.
 *
 * Nothing in the app imports this. If you change the live format, do not "update" this
 * file to match — it is a fixed historical baseline, and rewriting it would erase the
 * comparison it exists to provide.
 *
 * Reproduced from git 1a4a684: ai/tools.ts and ai/circuitToPrompt.ts.
 */

import type { Wire, CircuitElement, SimulationResult } from '../../types/circuit';
import { ALL_GATES } from '../../types/circuit';

const gatesMap = new Map(ALL_GATES.map(g => [g.id, g]));

const LEGACY_GATE_REFERENCE = ALL_GATES.map(g => {
  const params = g.parameters?.map(p => p.name).join(', ');
  return `  ${g.id}: ${g.name}${params ? ` (${params})` : ''}`;
}).join('\n');

export const LEGACY_SYSTEM_PROMPT = `You are a quantum circuit assistant for HyQSim, a hybrid CV-DV (continuous-variable / discrete-variable) quantum circuit simulator.

## Tool usage rules

1. BUILD/CREATE/MODIFY requests: call the tools and do it — never describe what you would do instead.
2. EXPLAIN/DESCRIBE requests: use the [Canvas: ...] and [Simulation: ...] snapshots at the top of the user's message — they show exactly what is on the canvas right now. You do NOT need to call read_circuit or get_simulation_result first if the snapshots already contain what you need.
3. THE CANVAS SNAPSHOT IS THE SOURCE OF TRUTH. Every user message begins with [Canvas: ...] showing the current circuit and [Simulation: ...] showing the current results. These always reflect what is actually on the canvas, regardless of conversation history.
4. NEVER call clear_circuit or add_wire when the user asks you to EXPLAIN or DESCRIBE. Only modify the circuit if the user explicitly asks you to BUILD, CREATE, ADD, REMOVE, or MODIFY something.
5. When building from scratch: call clear_circuit first, then add_wire for each wire, then add_gate for each gate. Multiple tool calls in one response are fine.
6. NEVER emit tool calls as XML text (e.g. <function=add_wire ...>). Only use the structured tool interface.

## HyQSim-specific wire and gate conventions

Wire labels:
- Qubits: q0, q1, q2, ...
- Qumodes (bosonic modes): m0, m1, m2, ...

Multi-wire gates — wireLabel is always listed first:
- cnot: wireLabel=control qubit, targetWireLabel=target qubit
- bs: wireLabel=first qumode, targetWireLabel=second qumode
- cdisp, xcdisp, ycdisp: wireLabel=qubit, targetWireLabel=qumode
- cr: wireLabel=qubit, targetWireLabel=qumode

Angles are in radians. Use your knowledge of quantum circuits to choose physically meaningful parameter values.

## Available gates in HyQSim
${LEGACY_GATE_REFERENCE}

## Explaining circuits

Use your quantum mechanics knowledge — you know what cat states, GHZ states, squeezed states, etc. look like and how they are prepared. Apply that knowledge here:
- Identify the state by name, not by listing gates
- Interpret the simulation data (Fock distribution shape, ⟨n̂⟩, Bloch vector) as physical evidence
- Explain why the circuit produces that state as a coherent narrative
- Note physical significance (non-classicality, entanglement structure, applications) where relevant
- Tone: physicist talking to a fellow physicist — precise, intuitive, not pedantic`;

export const LEGACY_TOOLS = [
  {
    name: 'read_circuit',
    description: 'Get the current circuit state as a readable description.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'add_wire',
    description: 'Add a new wire to the circuit.',
    input_schema: {
      type: 'object' as const,
      properties: {
        wireType: { type: 'string', enum: ['qubit', 'qumode'], description: 'Wire type: "qubit" or "qumode"' },
      },
      required: ['wireType'],
    },
  },
  {
    name: 'add_gate',
    description: 'Place a gate on the circuit.',
    input_schema: {
      type: 'object' as const,
      properties: {
        gateId: { type: 'string', description: 'Gate ID from the available gates list (e.g. "h", "x", "displace", "cdisp")' },
        wireLabel: { type: 'string', description: 'Primary wire label, e.g. "q0" or "m0"' },
        targetWireLabel: { type: 'string', description: 'Second wire label for multi-wire gates (cnot, bs, cdisp, cr, jc, etc.)' },
        parameters: {
          type: 'object',
          description: 'Gate parameter overrides as key-value pairs (e.g. {"theta": 1.5708}). Omit to use defaults.',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['gateId', 'wireLabel'],
    },
  },
  {
    name: 'remove_gate',
    description: 'Remove a gate from the circuit by its element ID (shown in read_circuit output).',
    input_schema: {
      type: 'object' as const,
      properties: {
        elementId: { type: 'string', description: 'Element ID from read_circuit, e.g. "element-1234"' },
      },
      required: ['elementId'],
    },
  },
  {
    name: 'clear_circuit',
    description: 'Remove all gates and wires from the circuit.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_simulation_result',
    description: 'Get the latest simulation results: qubit amplitudes, Bloch vectors, qumode Fock distributions, mean photon numbers, and measurement statistics. Returns a message if no simulation has been run yet.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
];

function legacyWireLabel(wires: Wire[], idx: number): string {
  const wire = wires[idx];
  if (!wire) return `wire${idx}`;
  const typeCount = wires.slice(0, idx).filter(w => w.type === wire.type).length;
  return wire.type === 'qubit' ? `q${typeCount}` : `m${typeCount}`;
}

export function legacyCircuitToPrompt(wires: Wire[], elements: CircuitElement[]): string {
  if (wires.length === 0) return 'Circuit is empty (no wires or gates).';

  const qubitWires = wires.filter(w => w.type === 'qubit');
  const qumodeWires = wires.filter(w => w.type === 'qumode');

  const lines: string[] = [
    `Circuit: ${qubitWires.length} qubit(s), ${qumodeWires.length} qumode(s).`,
    'Wires:',
    ...wires.map((w, i) => {
      const label = legacyWireLabel(wires, i);
      const state = w.initialState ?? (w.type === 'qubit' ? '0' : 0);
      return `  ${label} (${w.type}): initial |${state}⟩`;
    }),
  ];

  if (elements.length === 0) {
    lines.push('No gates placed.');
    return lines.join('\n');
  }

  const sorted = [...elements].sort((a, b) => a.position.x - b.position.x);
  lines.push(`Gates (${sorted.length} total, left to right):`);
  sorted.forEach((el, i) => {
    const gate = gatesMap.get(el.gateId);
    const name = gate?.name ?? el.gateId;
    const primary = legacyWireLabel(wires, el.wireIndex);
    const targets = el.targetWireIndices?.map(t => legacyWireLabel(wires, t)).join(', ');
    const params = el.parameterValues
      ? Object.entries(el.parameterValues).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(', ')
      : '';
    let desc = `  ${i + 1}. [${el.id}] ${name} on ${primary}`;
    if (targets) desc += ` → ${targets}`;
    if (params) desc += ` (${params})`;
    lines.push(desc);
  });

  return lines.join('\n');
}

export function legacySimulationResultToPrompt(
  result: SimulationResult,
  wires: Wire[],
  fockTruncation: number,
): string {
  if (wires.length === 0) return 'No wires in circuit — simulation result is empty.';

  const lines: string[] = [`Fock truncation: ${fockTruncation}`, `Backend: ${result.backend}`, ''];

  for (let i = 0; i < wires.length; i++) {
    const wire = wires[i];
    const label = legacyWireLabel(wires, i);

    if (wire.type === 'qubit') {
      const s = result.qubitStates.get(i);
      if (!s) { lines.push(`${label}: no result`); continue; }
      const [a, b] = s.amplitude;
      const fmt = (n: number) => n.toFixed(4);
      lines.push(`${label} (qubit):`);
      lines.push(`  state: (${fmt(a.re)}${a.im >= 0 ? '+' : ''}${fmt(a.im)}i)|0⟩ + (${fmt(b.re)}${b.im >= 0 ? '+' : ''}${fmt(b.im)}i)|1⟩`);
      lines.push(`  Bloch vector: x=${fmt(s.blochVector.x)}, y=${fmt(s.blochVector.y)}, z=${fmt(s.blochVector.z)}`);
      lines.push(`  ⟨σx⟩=${fmt(s.expectations.sigmaX)}, ⟨σy⟩=${fmt(s.expectations.sigmaY)}, ⟨σz⟩=${fmt(s.expectations.sigmaZ)}`);
    } else {
      const s = result.qumodeStates.get(i);
      if (!s) { lines.push(`${label}: no result`); continue; }
      lines.push(`${label} (qumode):`);
      lines.push(`  mean photon number ⟨n̂⟩ = ${s.meanPhotonNumber.toFixed(4)}`);
      const topN = Math.min(s.fockProbabilities.length, 12);
      const fockStr = s.fockProbabilities
        .slice(0, topN)
        .map((p, n) => `|${n}⟩: ${(p * 100).toFixed(2)}%`)
        .filter((_s, n) => s.fockProbabilities[n] > 0.001)
        .join(', ');
      lines.push(`  Fock distribution: ${fockStr || '(vacuum)'}`);
    }
    lines.push('');
  }

  if (result.bitstringCounts && Object.keys(result.bitstringCounts).length > 0) {
    const total = Object.values(result.bitstringCounts).reduce((a, b) => a + b, 0);
    const top = Object.entries(result.bitstringCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([k, v]) => `${k}: ${((v / total) * 100).toFixed(1)}%`)
      .join(', ');
    lines.push(`Measurement histogram (top outcomes): ${top}`);
  }

  return lines.join('\n').trim();
}

/**
 * The tool-call sequence the legacy design required to build a circuit: clear, then one
 * add_wire per wire, then one add_gate per gate. Each of these was a separate API
 * round-trip in practice, because models emit them one at a time under tool_choice:required.
 */
export function legacyBuildSequence(
  wires: Wire[], elements: CircuitElement[],
): { name: string; input: Record<string, unknown>; result: string }[] {
  const seq: { name: string; input: Record<string, unknown>; result: string }[] = [
    { name: 'clear_circuit', input: {}, result: 'Circuit cleared.' },
  ];
  wires.forEach((w, i) => {
    seq.push({
      name: 'add_wire',
      input: { wireType: w.type },
      result: `Added ${w.type} wire ${legacyWireLabel(wires, i)}.`,
    });
  });
  const sorted = [...elements].sort((a, b) => a.position.x - b.position.x);
  for (const el of sorted) {
    const gate = gatesMap.get(el.gateId);
    const input: Record<string, unknown> = {
      gateId: el.gateId,
      wireLabel: legacyWireLabel(wires, el.wireIndex),
    };
    if (el.targetWireIndices?.length) {
      input.targetWireLabel = legacyWireLabel(wires, el.targetWireIndices[0]);
    }
    if (el.parameterValues && Object.keys(el.parameterValues).length > 0) {
      input.parameters = el.parameterValues;
    }
    seq.push({
      name: 'add_gate',
      input,
      result: `Added ${gate?.name ?? el.gateId} on ${input.wireLabel}${input.targetWireLabel ? ` → ${input.targetWireLabel}` : ''}.`,
    });
  }
  return seq;
}
